import { formatAddr, parseAddress } from "../core/addr.ts";
import {
  type AckValue,
  type Addr,
  describePart,
  type Envelope,
  EnvelopeSchema,
  EXPECTS_REPLY,
  type Kind,
  newEnvelope,
  type Part,
  preview,
  textOf,
} from "../core/envelope.ts";
import { AgentLinkError, invalid, limited, notFound } from "../core/errors.ts";
import { echoKey, LIMITS } from "../core/limits.ts";
import {
  decidePolicy,
  type PolicyAction,
  type PolicyOverrides,
  type Trust,
} from "../core/policy.ts";
import { type RenderItem, renderInjection } from "../core/render.ts";
import { type DaemonContext, iso } from "./context.ts";
import { isLive, type Registry } from "./registry.ts";
import {
  type AgentRow,
  type DeliveryRow,
  type DeliveryState,
  type InboxItem,
  type MessageRow,
  type Sender,
  toolLabel,
} from "./types.ts";

export interface SendInput {
  to?: string[];
  kind: Kind;
  text?: string;
  parts?: Part[];
  replyTo?: string;
  thread?: string;
  taskId?: string;
  wait?: boolean;
  ttlMs?: number;
  hops?: number;
  ack?: AckValue;
}

interface Recipient {
  addr: Addr;
  toAddr: string;
  agent?: AgentRow;
  human?: boolean;
}

export interface SendResult {
  message: Record<string, unknown>;
  deliveries: Record<string, unknown>[];
  queued: InboxItem[];
}

export type InboxTarget = { agent: AgentRow } | { human: true };

const UNREAD: DeliveryState[] = ["queued", "delivered"];

export class Mailbox {
  readonly #ctx: DaemonContext;
  readonly #registry: Registry;
  readonly #replyWaiters = new Map<string, Set<(m: MessageRow) => void>>();
  readonly #inboxWaiters = new Map<string, Set<() => void>>();

  constructor(ctx: DaemonContext, registry: Registry) {
    this.#ctx = ctx;
    this.#registry = registry;
  }

  get handle(): string {
    return this.#ctx.config.handle;
  }

  get paused(): boolean {
    return this.#ctx.store.getMeta("paused") === "1";
  }

  senderAddr(sender: Sender): Addr {
    return sender.kind === "agent"
      ? { member: this.handle, agent: sender.agent.name, role: "agent" }
      : { member: this.handle, role: "human" };
  }

  // ---------------------------------------------------------------- lookups

  resolveMessage(idOrPrefix: string): MessageRow {
    const key = idOrPrefix.trim().toUpperCase();
    const exact = this.#ctx.store.get<MessageRow>("SELECT * FROM messages WHERE id = ?", key);
    if (exact) return exact;
    if (key.length < 6) throw notFound(`message "${idOrPrefix}"`);
    const rows = this.#ctx.store.all<MessageRow>(
      "SELECT * FROM messages WHERE id LIKE ? ORDER BY id DESC LIMIT 2",
      `${key}%`,
    );
    if (rows.length === 0) throw notFound(`message "${idOrPrefix}"`);
    if (rows.length > 1)
      throw invalid(`message id "${idOrPrefix}" is ambiguous; use more characters`);
    return rows[0] as MessageRow;
  }

  envelopeOf(message: MessageRow): Envelope {
    return EnvelopeSchema.parse(JSON.parse(message.envelope));
  }

  deliveriesOf(messageId: string): DeliveryRow[] {
    return this.#ctx.store.all<DeliveryRow>(
      "SELECT * FROM deliveries WHERE message_id = ? ORDER BY id",
      messageId,
    );
  }

  #overrides(scope: Trust): PolicyOverrides {
    const rows = this.#ctx.store.all<{ kind: Kind; action: PolicyAction }>(
      "SELECT kind, action FROM policy_overrides WHERE scope = ?",
      scope,
    );
    return Object.fromEntries(rows.map((r) => [r.kind, r.action]));
  }

  // ---------------------------------------------------------------- sending

  #resolveRecipients(sender: Sender, to: string[], original?: MessageRow): Recipient[] {
    const out: Recipient[] = [];
    const humanRecipient = (): Recipient => ({
      addr: { member: this.handle, role: "human" },
      toAddr: `@${this.handle}`,
      human: true,
    });
    const agentRecipient = (agent: AgentRow): Recipient => ({
      addr: { member: this.handle, agent: agent.name, role: "agent" },
      toAddr: agent.name,
      agent,
    });

    if (to.length === 0) {
      if (!original) throw invalid("no recipient given");
      const author = original.from_agent_id
        ? this.#registry.byId(original.from_agent_id)
        : undefined;
      if (author) out.push(agentRecipient(author));
      else if (original.from_addr === `@${this.handle}`) out.push(humanRecipient());
      else throw invalid(`cannot route a reply to ${original.from_addr} yet`);
    }

    for (const raw of to) {
      const spec = parseAddress(raw);
      switch (spec.kind) {
        case "name": {
          const agent = this.#registry.byName(spec.name);
          if (agent) out.push(agentRecipient(agent));
          else if (spec.name === this.handle) out.push(humanRecipient());
          else throw notFound(`agent "${spec.name}" (run: agentlink peers)`);
          break;
        }
        case "member":
          if (spec.member === this.handle && !spec.team) out.push(humanRecipient());
          else throw teamNotReady(raw);
          break;
        case "member-agent": {
          if (spec.member !== this.handle || spec.team) throw teamNotReady(raw);
          const agent = this.#registry.byName(spec.agent);
          if (!agent) throw notFound(`agent "${spec.agent}" (run: agentlink peers)`);
          out.push(agentRecipient(agent));
          break;
        }
        case "repo": {
          const agents = this.#ctx.store
            .all<AgentRow>(
              "SELECT * FROM agents WHERE (repo_remote = ? OR repo_root = ?) AND state IN ('busy','idle')",
              spec.repo,
              spec.repo,
            )
            .filter((a) => sender.kind !== "agent" || a.id !== sender.agent.id);
          if (agents.length === 0) throw notFound(`running agents in repo ${spec.repo}`);
          out.push(...agents.map(agentRecipient));
          break;
        }
        case "a2a":
          throw new AgentLinkError("not_supported", "A2A agents are not supported yet", 501);
      }
    }

    const unique = new Map<string, Recipient>();
    for (const r of out) unique.set(r.toAddr, r);
    if (sender.kind === "agent" && unique.has(sender.agent.name)) {
      throw invalid("an agent cannot message itself");
    }
    return [...unique.values()];
  }

  #checkGuards(
    sender: Sender,
    recipients: Recipient[],
    thread: string | undefined,
    original: MessageRow | undefined,
    key: string,
    hops: number,
  ): void {
    if (hops > LIMITS.maxHops) throw invalid(`too many forwarding hops (max ${LIMITS.maxHops})`);
    if (sender.kind !== "agent") return; // humans are never throttled
    const { store } = this.#ctx;
    if (thread) {
      const count = store.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?",
        thread,
      )?.n;
      const allowance =
        store.get<{ extra_allowance: number }>(
          "SELECT extra_allowance FROM thread_state WHERE thread_id = ?",
          thread,
        )?.extra_allowance ?? 0;
      if ((count ?? 0) >= LIMITS.threadMaxMessages + allowance) {
        throw limited(
          "thread_cap",
          `thread ${thread} reached ${LIMITS.threadMaxMessages + allowance} messages and is paused; ask your user to continue it (agentlink thread ${thread} --allow 10)`,
        );
      }
      const recent = store.all<{ echo_key: string }>(
        "SELECT echo_key FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?",
        thread,
        LIMITS.echoWindow,
      );
      if (recent.some((r) => r.echo_key === key)) {
        throw limited("echo", "this message repeats one already in the thread (echo guard)");
      }
    }
    if (original) {
      const depth = store.get<{ d: number }>(
        `WITH RECURSIVE chain(id, reply_to, depth) AS (
           SELECT id, reply_to, 1 FROM messages WHERE id = ?
           UNION ALL SELECT m.id, m.reply_to, c.depth + 1 FROM messages m JOIN chain c ON m.id = c.reply_to WHERE c.depth < 64
         ) SELECT MAX(depth) AS d FROM chain`,
        original.id,
      )?.d;
      if ((depth ?? 0) >= LIMITS.replyMaxDepth) {
        throw limited(
          "reply_depth",
          `reply chain is ${depth} deep (max ${LIMITS.replyMaxDepth}); summarise and start a new thread, or ask your user`,
        );
      }
    }
    const since = iso(new Date(this.#ctx.now().getTime() - LIMITS.pairRateWindowMs));
    for (const r of recipients) {
      if (!r.agent) continue;
      const n = store.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM messages m JOIN deliveries d ON d.message_id = m.id
         WHERE m.from_agent_id = ? AND d.to_agent_id = ? AND m.created_at > ?`,
        sender.agent.id,
        r.agent.id,
        since,
      )?.n;
      if ((n ?? 0) >= LIMITS.pairRateMax) {
        throw limited(
          "rate_limited",
          `rate limit: ${LIMITS.pairRateMax} messages per ${LIMITS.pairRateWindowMs / 60_000} min to ${r.toAddr}`,
        );
      }
    }
  }

  send(sender: Sender, input: SendInput): SendResult {
    const { store } = this.#ctx;
    const parts: Part[] =
      input.parts ?? (input.text !== undefined ? [{ kind: "text", text: input.text }] : []);
    const text = textOf({ parts });
    if (parts.length === 0 || (parts.every((p) => p.kind === "text") && !text.trim())) {
      throw invalid("message is empty");
    }
    if (Buffer.byteLength(text) > LIMITS.maxTextBytes) {
      throw invalid(`message too large (max ${LIMITS.maxTextBytes} bytes); attach a file instead`);
    }
    const original = input.replyTo ? this.resolveMessage(input.replyTo) : undefined;
    if (!original && ["reply", "ack", "review_result"].includes(input.kind)) {
      throw invalid(`a ${input.kind} must answer a message (replyTo)`);
    }
    const recipients = this.#resolveRecipients(sender, input.to ?? [], original);
    const thread =
      original?.thread_id ?? (input.thread ? this.resolveThread(input.thread) : undefined);
    const key = echoKey(`${input.kind}:${text}`);
    this.#checkGuards(sender, recipients, thread, original, key, input.hops ?? 0);

    const now = this.#ctx.now();
    const trust: Trust = sender.kind === "human" ? "user" : "local";
    const senderAgent = sender.kind === "agent" ? sender.agent : undefined;
    const envelope = newEnvelope({
      kind: input.kind,
      from: this.senderAddr(sender),
      to: recipients.map((r) => r.addr),
      parts,
      ...(thread ? { contextId: thread } : {}),
      ...(original ? { replyTo: original.id } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(senderAgent?.repo_remote ? { repo: senderAgent.repo_remote } : {}),
      ...(senderAgent?.branch ? { branch: senderAgent.branch } : {}),
      hops: input.hops ?? 0,
      ...(input.wait ? { wait: true } : {}),
      ...(input.ack ? { ack: input.ack } : {}),
      ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
      now,
    });
    const fromAddr = senderAgent ? senderAgent.name : `@${this.handle}`;
    const overrides = this.#overrides(trust);
    const stamp = iso(now);
    // An answer to someone blocked in `ask --wait` reaches them through the long-poll; don't
    // also inject it via hooks.
    const answersWaiter =
      !!original &&
      ["reply", "review_result", "ack"].includes(input.kind) &&
      this.hasReplyWaiter(original.id);
    const isOriginalAuthor = (r: Recipient) =>
      !!original &&
      ((r.agent && r.agent.id === original.from_agent_id) ||
        (r.human && original.from_addr === `@${this.handle}`));

    const deliveryIds = store.tx(() => {
      store.run(
        `INSERT INTO messages (id, thread_id, reply_to, task_id, kind, from_addr, from_agent_id, trust, envelope,
           preview, echo_key, wait, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        envelope.messageId,
        envelope.contextId,
        envelope.replyTo ?? null,
        envelope.taskId ?? null,
        envelope.kind,
        fromAddr,
        senderAgent?.id ?? null,
        trust,
        JSON.stringify(envelope),
        preview(text),
        key,
        input.wait ? 1 : 0,
        envelope.createdAt,
        envelope.meta.expiresAt,
      );
      const ids: number[] = [];
      for (const r of recipients) {
        let state: DeliveryState;
        let note: string | null = null;
        let method: string | null = null;
        if (answersWaiter && isOriginalAuthor(r)) {
          state = "seen";
          method = "longpoll";
        } else if (r.human) {
          state = "delivered";
        } else {
          const action = decidePolicy(trust, input.kind, overrides);
          state = action === "deliver" ? "queued" : action === "hold" ? "held" : "refused";
          if (action !== "deliver") note = `policy: ${action}`;
        }
        const res = store.run(
          `INSERT INTO deliveries (message_id, to_addr, to_agent_id, state, method, note, created_at, delivered_at, seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          envelope.messageId,
          r.toAddr,
          r.agent?.id ?? null,
          state,
          method,
          note,
          stamp,
          state === "delivered" || state === "seen" ? stamp : null,
          state === "seen" ? stamp : null,
        );
        ids.push(res.lastInsertRowid);
      }
      if (original) this.#markAnswered(original, sender, envelope.messageId, input.kind, stamp);
      return ids;
    });

    const message = store.get<MessageRow>(
      "SELECT * FROM messages WHERE id = ?",
      envelope.messageId,
    ) as MessageRow;
    const deliveries = deliveryIds.map(
      (id) => store.get<DeliveryRow>("SELECT * FROM deliveries WHERE id = ?", id) as DeliveryRow,
    );
    this.#ctx.events.publish({ type: "message", message: this.messageView(message) });
    for (const d of deliveries) this.#publishDelivery(d);
    if (original) this.#resolveReplyWaiters(original.id, message);
    for (const r of recipients) this.#notifyInbox(r.human ? "human" : (r.agent?.id ?? ""));

    return {
      message: this.messageView(message),
      deliveries: deliveries.map((d) => this.deliveryView(d)),
      queued: deliveries
        .filter((d) => d.state === "queued")
        .map((d) => ({ delivery: d, message, envelope })),
    };
  }

  #markAnswered(
    original: MessageRow,
    sender: Sender,
    replyId: string,
    kind: Kind,
    stamp: string,
  ): void {
    const isAck = kind === "ack";
    const state: DeliveryState = isAck ? "acked" : "replied";
    const column = isAck ? "acked_at" : "replied_at";
    const who = sender.kind === "agent" ? "to_agent_id = ?" : "to_agent_id IS NULL AND to_addr = ?";
    const whoParam = sender.kind === "agent" ? sender.agent.id : `@${this.handle}`;
    const updated = this.#ctx.store.run(
      `UPDATE deliveries SET state = ?, ${column} = ?, reply_id = COALESCE(reply_id, ?),
         seen_at = COALESCE(seen_at, ?), delivered_at = COALESCE(delivered_at, ?)
       WHERE message_id = ? AND ${who} AND state NOT IN ('refused','expired')
         ${isAck ? "AND state NOT IN ('replied')" : ""}`,
      state,
      stamp,
      replyId,
      stamp,
      stamp,
      original.id,
      whoParam,
    );
    if (updated.changes > 0) {
      for (const d of this.deliveriesOf(original.id)) this.#publishDelivery(d);
    }
  }

  resolveThread(idOrPrefix: string): string {
    const key = idOrPrefix.trim().toUpperCase();
    const row =
      this.#ctx.store.get<{ thread_id: string }>(
        "SELECT thread_id FROM messages WHERE thread_id = ? LIMIT 1",
        key,
      ) ??
      this.#ctx.store.get<{ thread_id: string }>(
        "SELECT thread_id FROM messages WHERE thread_id LIKE ? LIMIT 1",
        `${key}%`,
      );
    if (!row) throw notFound(`thread "${idOrPrefix}"`);
    return row.thread_id;
  }

  // ---------------------------------------------------------------- reading

  #targetClause(target: InboxTarget): [string, string] {
    return "agent" in target
      ? ["d.to_agent_id = ?", target.agent.id]
      : ["d.to_agent_id IS NULL AND d.to_addr = ?", `@${this.handle}`];
  }

  inbox(target: InboxTarget, opts: { unreadOnly?: boolean; limit?: number } = {}): InboxItem[] {
    const [clause, param] = this.#targetClause(target);
    const states = opts.unreadOnly ? UNREAD : null;
    const rows = this.#ctx.store.all<DeliveryRow & { m_envelope: string }>(
      `SELECT d.*, m.envelope AS m_envelope FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE ${clause} ${states ? `AND d.state IN (${states.map(() => "?").join(",")})` : "AND d.state != 'refused'"}
       ORDER BY d.id DESC LIMIT ?`,
      param,
      ...(states ?? []),
      opts.limit ?? 50,
    );
    return rows.reverse().map((r) => this.#item(r));
  }

  #item(row: DeliveryRow & { m_envelope?: string }): InboxItem {
    const { m_envelope: _, ...delivery } = row;
    const message = this.#ctx.store.get<MessageRow>(
      "SELECT * FROM messages WHERE id = ?",
      delivery.message_id,
    ) as MessageRow;
    return { delivery: delivery as DeliveryRow, message, envelope: this.envelopeOf(message) };
  }

  /** Queued deliveries for an agent, oldest first (not marked). */
  pending(agentId: string, filter?: (item: InboxItem) => boolean): InboxItem[] {
    const rows = this.#ctx.store.all<DeliveryRow>(
      "SELECT * FROM deliveries WHERE to_agent_id = ? AND state = 'queued' ORDER BY id",
      agentId,
    );
    const items = rows.map((r) => this.#item(r));
    return filter ? items.filter(filter) : items;
  }

  /** Takes queued deliveries for injection and marks them seen. Nothing while paused/muted. */
  drain(agent: AgentRow, method: string, filter?: (item: InboxItem) => boolean): InboxItem[] {
    if (this.paused || agent.muted) return [];
    const items = this.pending(agent.id, filter).slice(0, LIMITS.maxInboxBatch);
    this.markSeen(
      items.map((i) => i.delivery.id),
      method,
    );
    return items;
  }

  markSeen(deliveryIds: number[], method: string, state: DeliveryState = "seen"): void {
    if (deliveryIds.length === 0) return;
    const stamp = iso(this.#ctx.now());
    this.#ctx.store.tx(() => {
      for (const id of deliveryIds) {
        this.#ctx.store.run(
          `UPDATE deliveries SET state = CASE WHEN state IN ('queued','delivered') THEN ? ELSE state END,
             method = COALESCE(method, ?), delivered_at = COALESCE(delivered_at, ?),
             seen_at = CASE WHEN ? = 'seen' THEN COALESCE(seen_at, ?) ELSE seen_at END
           WHERE id = ?`,
          state,
          method,
          stamp,
          state,
          stamp,
          id,
        );
      }
    });
    for (const id of deliveryIds) {
      const d = this.#ctx.store.get<DeliveryRow>("SELECT * FROM deliveries WHERE id = ?", id);
      if (d) this.#publishDelivery(d);
    }
  }

  /** Whether this delivery answers a message whose sender expects a reply. */
  answersExpecting(item: InboxItem): boolean {
    if (!item.message.reply_to) return false;
    const original = this.#ctx.store.get<MessageRow>(
      "SELECT kind FROM messages WHERE id = ?",
      item.message.reply_to,
    );
    return !!original && EXPECTS_REPLY.has(original.kind);
  }

  renderItem(item: InboxItem): RenderItem {
    const env = item.envelope;
    const author = item.message.from_agent_id
      ? this.#registry.byId(item.message.from_agent_id)
      : undefined;
    const fromLabel = author
      ? `${toolLabel(author.tool)} session "${author.name}"`
      : env.from.role === "system"
        ? "agentlink"
        : env.from.role === "human"
          ? env.from.member
          : formatAddr(env.from, this.handle);
    const attachments = env.parts
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.kind !== "text")
      .map(
        ({ p, i }) =>
          `attachment ${i + 1}: ${describePart(p)} → agentlink show ${env.messageId} --part ${i + 1}`,
      );
    return {
      id: env.messageId,
      thread: env.contextId,
      kind: env.kind,
      from: item.message.from_addr,
      fromLabel,
      trust: item.message.trust,
      sentAt: env.createdAt,
      text: textOf(env),
      ...(env.replyTo ? { replyTo: env.replyTo } : {}),
      ...(env.meta.ack ? { ack: env.meta.ack } : {}),
      attachments,
    };
  }

  render(items: InboxItem[], recipient: string): string {
    return renderInjection(
      items.map((i) => this.renderItem(i)),
      { recipient },
    );
  }

  thread(threadId: string): { message: MessageRow; deliveries: DeliveryRow[] }[] {
    const id = this.resolveThread(threadId);
    return this.#ctx.store
      .all<MessageRow>("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, id", id)
      .map((message) => ({ message, deliveries: this.deliveriesOf(message.id) }));
  }

  allowThread(threadId: string, extra: number): void {
    const id = this.resolveThread(threadId);
    this.#ctx.store.run(
      `INSERT INTO thread_state (thread_id, extra_allowance) VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET extra_allowance = extra_allowance + excluded.extra_allowance`,
      id,
      extra,
    );
  }

  recent(limit: number): MessageRow[] {
    return this.#ctx.store
      .all<MessageRow>("SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT ?", limit)
      .reverse();
  }

  // ---------------------------------------------------------------- waiting

  /** Resolves with the first answer (reply / review_result / ack) to `messageId`, or undefined on timeout. */
  waitForReply(
    messageId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<MessageRow | undefined> {
    const existing = this.#ctx.store.get<MessageRow>(
      "SELECT * FROM messages WHERE reply_to = ? AND kind IN ('reply','review_result','ack') ORDER BY created_at LIMIT 1",
      messageId,
    );
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const set = this.#replyWaiters.get(messageId) ?? new Set();
      const done = (m?: MessageRow) => {
        clearTimeout(timer);
        set.delete(fn);
        if (set.size === 0) this.#replyWaiters.delete(messageId);
        resolve(m);
      };
      const fn = (m: MessageRow) => done(m);
      const timer = setTimeout(() => done(undefined), timeoutMs);
      signal?.addEventListener("abort", () => done(undefined), { once: true });
      set.add(fn);
      this.#replyWaiters.set(messageId, set);
    });
  }

  #resolveReplyWaiters(originalId: string, reply: MessageRow): void {
    if (!["reply", "review_result", "ack"].includes(reply.kind)) return;
    for (const fn of this.#replyWaiters.get(originalId) ?? []) fn(reply);
  }

  hasReplyWaiter(messageId: string): boolean {
    return (this.#replyWaiters.get(messageId)?.size ?? 0) > 0;
  }

  waitForInbox(target: InboxTarget, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const key = "agent" in target ? target.agent.id : "human";
    return new Promise((resolve) => {
      const set = this.#inboxWaiters.get(key) ?? new Set();
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done, { once: true });
      set.add(done);
      this.#inboxWaiters.set(key, set);
    });
  }

  #notifyInbox(key: string): void {
    for (const fn of this.#inboxWaiters.get(key) ?? []) fn();
  }

  // ---------------------------------------------------------------- approvals

  held(): InboxItem[] {
    return this.#ctx.store
      .all<DeliveryRow>("SELECT * FROM deliveries WHERE state = 'held' ORDER BY id")
      .map((r) => this.#item(r));
  }

  decide(deliveryId: number, decision: "approve" | "deny", by: string): InboxItem {
    const d = this.#ctx.store.get<DeliveryRow>("SELECT * FROM deliveries WHERE id = ?", deliveryId);
    if (!d) throw notFound(`held delivery ${deliveryId}`);
    if (d.state !== "held") throw invalid(`delivery ${deliveryId} is ${d.state}, not held`);
    this.#ctx.store.run(
      "UPDATE deliveries SET state = ?, decided_by = ?, note = ? WHERE id = ?",
      decision === "approve" ? "queued" : "refused",
      by,
      decision === "approve" ? `approved by ${by}` : `denied by ${by}`,
      deliveryId,
    );
    const updated = this.#ctx.store.get<DeliveryRow>(
      "SELECT * FROM deliveries WHERE id = ?",
      deliveryId,
    ) as DeliveryRow;
    this.#publishDelivery(updated);
    return this.#item(updated);
  }

  // ---------------------------------------------------------------- expiry

  /** Expires undelivered mail past its TTL and tells local senders. Returns expired count. */
  expireSweep(): number {
    const stamp = iso(this.#ctx.now());
    const rows = this.#ctx.store.all<
      DeliveryRow & { from_agent_id: string | null; preview: string; kind: Kind }
    >(
      `SELECT d.*, m.from_agent_id, m.preview, m.kind FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.state IN ('queued','held') AND m.expires_at < ?`,
      stamp,
    );
    for (const row of rows) {
      this.#ctx.store.run(
        "UPDATE deliveries SET state = 'expired', note = 'ttl' WHERE id = ?",
        row.id,
      );
      const sender = row.from_agent_id ? this.#registry.byId(row.from_agent_id) : undefined;
      if (sender) {
        this.notify(
          sender,
          `Your ${row.kind} ${row.message_id} to ${row.to_addr} expired undelivered: "${row.preview}"`,
        );
      }
    }
    return rows.length;
  }

  /** Queues a system notice (from "agentlink") for a local agent. */
  notify(agent: AgentRow, text: string): InboxItem {
    const envelope = newEnvelope({
      kind: "info",
      from: { member: "agentlink", role: "system" },
      to: [{ member: this.handle, agent: agent.name, role: "agent" }],
      parts: [{ kind: "text", text }],
      now: this.#ctx.now(),
    });
    const stamp = iso(this.#ctx.now());
    const id = this.#ctx.store.tx(() => {
      this.#ctx.store.run(
        `INSERT INTO messages (id, thread_id, kind, from_addr, trust, envelope, preview, echo_key, created_at, expires_at)
         VALUES (?, ?, 'info', 'agentlink', 'local', ?, ?, ?, ?, ?)`,
        envelope.messageId,
        envelope.contextId,
        JSON.stringify(envelope),
        preview(text),
        echoKey(text),
        envelope.createdAt,
        envelope.meta.expiresAt,
      );
      return this.#ctx.store.run(
        "INSERT INTO deliveries (message_id, to_addr, to_agent_id, state, created_at) VALUES (?, ?, ?, 'queued', ?)",
        envelope.messageId,
        agent.name,
        agent.id,
        stamp,
      ).lastInsertRowid;
    });
    const delivery = this.#ctx.store.get<DeliveryRow>(
      "SELECT * FROM deliveries WHERE id = ?",
      id,
    ) as DeliveryRow;
    this.#publishDelivery(delivery);
    this.#notifyInbox(agent.id);
    return this.#item(delivery);
  }

  // ---------------------------------------------------------------- views

  messageView(m: MessageRow): Record<string, unknown> {
    return {
      id: m.id,
      thread: m.thread_id,
      replyTo: m.reply_to,
      taskId: m.task_id,
      kind: m.kind,
      from: m.from_addr,
      trust: m.trust,
      preview: m.preview,
      createdAt: m.created_at,
      expiresAt: m.expires_at,
    };
  }

  deliveryView(d: DeliveryRow): Record<string, unknown> {
    const agent = d.to_agent_id ? this.#registry.byId(d.to_agent_id) : undefined;
    return {
      id: d.id,
      messageId: d.message_id,
      to: d.to_addr,
      toState: agent?.state,
      state: d.state,
      method: d.method,
      note: d.note,
      deliveredAt: d.delivered_at,
      seenAt: d.seen_at,
      ackedAt: d.acked_at,
      repliedAt: d.replied_at,
      replyId: d.reply_id,
    };
  }

  #publishDelivery(d: DeliveryRow): void {
    this.#ctx.events.publish({ type: "delivery", delivery: this.deliveryView(d) });
  }

  /** Recipients' presence summary, used for sender-facing notes. */
  presenceOf(agentId: string): AgentRow | undefined {
    return this.#registry.byId(agentId);
  }

  isLiveAgent(agentId: string): boolean {
    const a = this.#registry.byId(agentId);
    return !!a && isLive(a);
  }
}

function teamNotReady(addr: string): AgentLinkError {
  return new AgentLinkError(
    "no_team",
    `"${addr}" is a team address; join a team first (agentlink team join <invite>)`,
    400,
  );
}
