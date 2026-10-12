import { hostname } from "node:os";
import { formatAddr, parseAddress } from "../core/addr.ts";
import {
  type AckValue,
  type Addr,
  AddrSchema,
  describePart,
  type Envelope,
  EnvelopeSchema,
  EXPECTS_REPLY,
  type Kind,
  newEnvelope,
  type Part,
  preview,
  RemoteEnvelopeSchema,
  textOf,
} from "../core/envelope.ts";
import { AgentLinkError, invalid, limited, notFound } from "../core/errors.ts";
import { coversQuery, facetsOf, fromLabelOf, homeShort, identityLine } from "../core/identity.ts";
import { partsHaveInvite } from "../core/invite-code.ts";
import { echoKey, LIMITS } from "../core/limits.ts";
import {
  decidePolicy,
  type PolicyAction,
  type PolicyOverrides,
  type Trust,
} from "../core/policy.ts";
import { scanParts } from "../core/redact.ts";
import { type RenderItem, renderInjection } from "../core/render.ts";
import { safeField } from "../core/sanitize.ts";
import { didYouMean } from "../core/suggest.ts";
import { type DaemonContext, iso } from "./context.ts";
import { isLive, type Registry } from "./registry.ts";
import type { RemoteAgent } from "./relay-client.ts";
import { ensureSearchIndex, searchDoc } from "./store/search.ts";
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
  /** Send to teammates even though the text looks like it contains a secret. */
  force?: boolean;
  /** Answer everyone in the original message's conversation (group chat). */
  replyAll?: boolean;
}

interface Recipient {
  addr: Addr;
  toAddr: string;
  agent?: AgentRow;
  human?: boolean;
  /** Team member handle for recipients on other machines. */
  remote?: string;
}

export interface SendResult {
  message: Record<string, unknown>;
  deliveries: Record<string, unknown>[];
  queued: InboxItem[];
}

export type InboxTarget = { agent: AgentRow } | { human: true };

/** History filters (search, log). Addresses as people type them: "alpha", "me/alpha", "@bob". */
export interface MessageFilter {
  from?: string;
  to?: string;
  kinds?: Kind[];
  since?: string;
  until?: string;
  thread?: string;
  repo?: string;
  /** Only what the viewer sent. */
  mine?: boolean;
}

export interface SearchRow {
  id: string;
  thread: string;
  kind: Kind;
  from: string;
  to: string[];
  createdAt: string;
  snippet: string;
  tokens: number;
}

export interface ThreadSummary {
  thread: string;
  subject: string;
  participants: string[];
  messages: number;
  lastAt: string;
  lastFrom: string;
  lastPreview: string;
  open: boolean;
  /** An ask/request/handoff in it waits for the viewer's answer. */
  needsAnswer: boolean;
  /** The viewer waits for someone else's answer. */
  waiting: boolean;
  unread: number;
}

/** Where a conversation stands, the same for every viewer who sees the same messages. */
export interface ThreadStatus {
  /** held (mail waits for a person's approval) > waiting_on_you > awaiting > answered. */
  state: "held" | "waiting_on_you" | "awaiting" | "answered";
  /** Who still owes an answer to an ask/request/handoff/review (not replied, acked or refused). */
  awaiting: string[];
  /** Held deliveries. */
  held: number;
}

const EXPECTING = "('ask','request','handoff','review_request')";

export type WaitOutcome =
  | { kind: "reply"; message: MessageRow }
  | { kind: "failed"; deliveries: DeliveryRow[] }
  | { kind: "timeout" };

/** How the mailbox reaches teammates (implemented by the relay client). */
export interface RemoteRouter {
  teamName: string;
  /** This device's handle in the team (how teammates address this machine). */
  selfHandle: string;
  /** Whether any device of a teammate is connected to the relay. */
  online(handle: string): boolean;
  /** Whether that teammate's agent session is running (its device is connected and says so). */
  agentOnline(handle: string, agent: string): boolean;
  /** Current name of a teammate's agent that used to be called `agent`. */
  aliasesOf(handle: string, agent: string): string | undefined;
  /** What a teammate's agent says it is (tool, host, model, title, project), from presence. */
  infoOf(handle: string, agent: string): RemoteInfo | undefined;
  /** All of a teammate's agents from presence (for facet and tag addresses). */
  agentInfos(handle: string): RemoteInfo[];
  connected(): boolean;
  handles(): string[];
  agentsOf(handle: string): string[];
  deliver(handle: string, envelope: Envelope): number;
  receipt(
    handle: string,
    receipt: { messageId: string; to: string; state: string; note?: string },
  ): void;
}

export type RemoteInfo = Pick<
  RemoteAgent,
  "name" | "tool" | "state" | "host" | "model" | "title" | "project" | "branch" | "sid"
>;

const UNREAD: DeliveryState[] = ["queued", "delivered"];

/** Delivery progress order; receipts never move a delivery backwards. */
const RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  held: 2,
  delivered: 3,
  seen: 4,
  acked: 5,
  replied: 6,
  refused: 6,
  expired: 6,
  failed: 6,
};

export const remoteHandleOf = (fromAddr: string): string | undefined =>
  fromAddr.startsWith("@")
    ? fromAddr.slice(1)
    : fromAddr.includes("/")
      ? fromAddr.split("/")[0]
      : undefined;

export class Mailbox {
  readonly #ctx: DaemonContext;
  readonly #registry: Registry;
  readonly #replyWaiters = new Map<string, Set<() => void>>();
  readonly #inboxWaiters = new Map<string, Set<() => void>>();
  remote: RemoteRouter | undefined;
  /** Full-text index available (SQLite FTS5); otherwise search uses LIKE. */
  readonly fts: boolean;

  constructor(ctx: DaemonContext, registry: Registry) {
    this.#ctx = ctx;
    this.#registry = registry;
    // AGENTLINK_NO_FTS=1 (tests) exercises the LIKE fallback.
    this.fts =
      process.env.AGENTLINK_NO_FTS !== "1" && ctx.store.tx(() => ensureSearchIndex(ctx.store.db));
  }

  /** How this machine is addressed: its team handle when in a team (it may differ from config). */
  get handle(): string {
    return this.remote?.selfHandle ?? this.#ctx.config.handle;
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

  /** With a `viewer`, messages it may not see don't exist (same error as an unknown id). */
  resolveMessage(idOrPrefix: string, viewer?: InboxTarget): MessageRow {
    const key = idOrPrefix.trim().toUpperCase();
    const [vis, vp]: [string, string[]] = viewer ? this.#visibleSql(viewer) : ["1", []];
    const exact = this.#ctx.store.get<MessageRow>(
      `SELECT m.* FROM messages m WHERE m.id = ? AND ${vis}`,
      key,
      ...vp,
    );
    if (exact) return exact;
    if (key.length < 4)
      throw invalid(`"${idOrPrefix}" is too short; use at least 4 characters of the message id`);
    const rows = this.#ctx.store.all<MessageRow>(
      `SELECT m.* FROM messages m WHERE m.id LIKE ? AND ${vis} ORDER BY m.id DESC LIMIT 2`,
      `${key}%`,
      ...vp,
    );
    if (rows.length === 0) {
      throw new AgentLinkError(
        "not_found",
        `no message "${idOrPrefix}" here (agentlink inbox and agentlink log show the ids you can use)`,
        404,
      );
    }
    if (rows.length > 1) {
      throw invalid(`"${idOrPrefix}" matches several messages; use more characters of the id`);
    }
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

  /** Policy overrides for a trust class (user/local/teammate/external) or a teammate's handle. */
  #overrides(scope: string): PolicyOverrides {
    const rows = this.#ctx.store.all<{ kind: Kind; action: PolicyAction }>(
      "SELECT kind, action FROM policy_overrides WHERE scope = ?",
      scope,
    );
    return Object.fromEntries(rows.map((r) => [r.kind, r.action]));
  }

  /**
   * Addresses copied from peers may carry a session tag: "claude #7f3a", "alice/codex#c01d", or
   * be just "#7f3a". The tag picks among the agents the rest matches; an exact name wins anyway.
   */
  #fromTag(input: string): { addr: string; tag?: string } {
    const m = /^\s*(\S*?)\s*#([a-z0-9]{1,8})\s*$/i.exec(input);
    if (!m) return { addr: input };
    const [, name, raw] = m as unknown as [string, string, string];
    const tag = raw.toLowerCase();
    if (name) return { addr: name, tag };
    const local = this.#registry
      .list({ includeOffline: true })
      .filter((a) => this.#registry.tagOf(a) === tag);
    const remote = (this.remote?.handles() ?? []).flatMap((h) =>
      (this.remote?.agentInfos(h) ?? []).filter((a) => a.sid === tag).map((a) => `${h}/${a.name}`),
    );
    const all = [...local.map((a) => a.name), ...remote];
    if (all.length === 1) return { addr: all[0] as string };
    if (all.length > 1)
      throw invalid(`#${tag} matches several agents; use one of: ${all.join(", ")}`);
    throw new AgentLinkError(
      "not_found",
      `no agent with session tag #${tag}; see: agentlink peers`,
      404,
    );
  }

  /** One running match (else one offline match), or a clear error listing who matches. */
  #pick<T extends { state?: string }>(
    query: string,
    found: T[],
    describe: (a: T) => string,
  ): T | undefined {
    const live = found.filter((a) => a.state === "busy" || a.state === "idle");
    const pool = live.length ? live : found;
    if (pool.length > 1) {
      throw invalid(
        `"${query}" matches ${pool.length} agents; use a full name: ${pool.slice(0, 8).map(describe).join("; ")}`,
      );
    }
    return pool[0];
  }

  #describeLocal(a: AgentRow): string {
    return identityLine({
      name: a.name,
      harness: toolLabel(a.tool),
      model: a.model,
      dir: a.cwd ? homeShort(a.cwd) : a.project,
      branch: a.branch,
    });
  }

  /** A teammate's agent by facets of its presence (model, project, …); title words last. */
  #remoteByFacets(member: string, query: string, tag?: string): string | undefined {
    const infos = (this.remote?.agentInfos(member) ?? []).filter((a) => !tag || a.sid === tag);
    const describe = (a: RemoteInfo) =>
      identityLine({
        name: `${member}/${a.name}`,
        harness: toolLabel(a.tool),
        model: a.model ?? null,
        dir: a.project ?? null,
        branch: a.branch ?? null,
        host: a.host ?? null,
      });
    for (const withTitle of [false, true]) {
      const found = infos.filter((a) => coversQuery(query, facetsOf(a, { withTitle })));
      if (found.length) return this.#pick(`${member}/${query}`, found, describe)?.name;
    }
    return undefined;
  }

  #noSuchAgent(name: string): AgentLinkError {
    const known = [
      ...this.#registry.list({ includeOffline: true }).map((a) => a.name),
      ...(this.remote?.handles() ?? []).flatMap((h) =>
        (this.remote?.agentsOf(h) ?? []).map((a) => `${h}/${a}`),
      ),
    ];
    return new AgentLinkError(
      "not_found",
      `no agent named "${name}"${didYouMean(name, known)}; see: agentlink peers`,
      404,
    );
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
    const remoteRecipient = (member: string, agent?: string, tag?: string): Recipient => {
      const remote = this.remote;
      if (!remote) throw teamNotReady(agent ? `${member}/${agent}` : `@${member}`);
      if (!remote.handles().includes(member)) {
        throw new AgentLinkError(
          "not_found",
          `no team member "${member}"${didYouMean(member, remote.handles())}; see: agentlink team`,
          404,
        );
      }
      // Presence lists a teammate's agents; catch typos before anything waits on them.
      // Exact names and aliases first, then facets of what they say they are ("alice/opus").
      const theirs = remote.agentsOf(member);
      if (agent && !theirs.includes(agent)) {
        const renamed = remote.aliasesOf(member, agent) ?? this.#remoteByFacets(member, agent, tag);
        if (renamed) agent = renamed;
      }
      if (agent && theirs.length > 0 && !theirs.includes(agent)) {
        throw new AgentLinkError(
          "not_found",
          `${member} has no agent named "${agent}"${didYouMean(agent, theirs)}; ${member}'s agents: ${theirs.join(", ")}`,
          404,
        );
      }
      return {
        addr: agent
          ? { member, agent, team: remote.teamName, role: "agent" }
          : { member, team: remote.teamName, role: "human" },
        toAddr: agent ? `${member}/${agent}` : `@${member}`,
        remote: member,
      };
    };

    if (to.length === 0) {
      if (!original) throw invalid("no recipient given");
      const author = original.from_agent_id
        ? this.#registry.byId(original.from_agent_id)
        : undefined;
      const origin = this.envelopeOf(original).from;
      if (author) out.push(agentRecipient(author));
      else if (original.from_addr === `@${this.handle}`) out.push(humanRecipient());
      else if (origin.member !== this.handle && origin.role !== "system") {
        out.push(
          remoteRecipient(origin.member, origin.role === "agent" ? origin.agent : undefined),
        );
      } else throw invalid(`cannot route a reply to ${original.from_addr}`);
    }

    // A local agent by exact name or alias, else by facets ("opus", "codex-api"); title words
    // count only after teammates' exact names, so a session title can't take someone's address.
    const localAgent = (name: string, tag?: string, beforeTitles?: () => boolean) => {
      const found = this.#registry.resolveName(name)?.agent;
      if (found) return found;
      for (const withTitle of [false, true]) {
        if (withTitle && beforeTitles?.()) return undefined;
        const facets = this.#registry.byFacets(name, { withTitle, ...(tag ? { tag } : {}) });
        const one = this.#pick(name, facets, (a) => this.#describeLocal(a));
        if (one) return one;
      }
      return undefined;
    };

    for (const input of to) {
      const { addr: raw, tag } = this.#fromTag(input);
      const spec = parseAddress(raw);
      switch (spec.kind) {
        case "name": {
          if (spec.name === this.handle && !this.#registry.resolveName(spec.name)) {
            out.push(humanRecipient());
            break;
          }
          // A bare name can also mean a teammate's agent (exact name only), when unambiguous.
          let owners: string[] = [];
          const found = localAgent(spec.name, tag, () => {
            owners = (this.remote?.handles() ?? []).filter((h) =>
              this.remote?.agentsOf(h).includes(spec.name),
            );
            return owners.length > 0;
          });
          if (found) out.push(agentRecipient(this.#registry.refreshLiveness(found)));
          else if (owners.length === 1) out.push(remoteRecipient(owners[0] as string, spec.name));
          else if (owners.length > 1) {
            throw invalid(
              `"${spec.name}" is ambiguous; use one of: ${owners.map((h) => `${h}/${spec.name}`).join(", ")}`,
            );
          } else throw this.#noSuchAgent(spec.name);
          break;
        }
        case "member":
          if (spec.member === this.handle) out.push(humanRecipient());
          else out.push(remoteRecipient(spec.member));
          break;
        case "member-agent": {
          if (spec.member !== this.handle) {
            out.push(remoteRecipient(spec.member, spec.agent, tag));
            break;
          }
          const found = localAgent(spec.agent, tag);
          if (!found) throw this.#noSuchAgent(spec.agent);
          out.push(agentRecipient(this.#registry.refreshLiveness(found)));
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

  #resolvable(sender: Sender, address: string): boolean {
    try {
      this.#resolveRecipients(sender, [address]);
      return true;
    } catch {
      return false;
    }
  }

  /** Only a recipient answers a message, and a handoff gets one final accept/decline. */
  #isAuthor(sender: Sender, original: MessageRow): boolean {
    return sender.kind === "agent"
      ? original.from_agent_id === sender.agent.id
      : original.from_agent_id === null && original.from_addr === `@${this.handle}`;
  }

  /**
   * Only a recipient answers a message (its author may follow up), a handoff gets one final
   * accept/decline, and in a group the first accept takes it.
   */
  #checkAnswerer(sender: Sender, original: MessageRow, ack?: AckValue): void {
    const deliveries = this.deliveriesOf(original.id);
    const mine = deliveries.find((d) =>
      sender.kind === "agent"
        ? d.to_agent_id === sender.agent.id
        : d.to_agent_id === null && d.to_addr === `@${this.handle}`,
    );
    if (!mine && !(this.#isAuthor(sender, original) && !ack)) {
      throw new AgentLinkError(
        "forbidden",
        `only a recipient of ${original.id} can answer it (it went to ${
          deliveries.map((d) => d.to_addr).join(", ") || "nobody here"
        })`,
        403,
      );
    }
    if (ack !== "accept" && ack !== "decline") return;
    if (original.kind !== "handoff") {
      throw invalid(
        `only a handoff can be accepted or declined; ${original.id} is ${original.kind === "ask" ? "an" : "a"} ${original.kind} (answer it with agentlink reply, or confirm with agentlink ack ${original.id})`,
      );
    }
    const decisions = this.#ctx.store
      .all<MessageRow>("SELECT * FROM messages WHERE reply_to = ? AND kind = 'ack'", original.id)
      .map((m) => ({ m, ack: this.envelopeOf(m).meta.ack }))
      .filter((d) => d.ack === "accept" || d.ack === "decline");
    const own = decisions.find(({ m }) =>
      sender.kind === "agent"
        ? m.from_agent_id === sender.agent.id
        : m.from_agent_id === null && m.from_addr === `@${this.handle}`,
    );
    if (own)
      throw invalid(`you already ${own.ack === "accept" ? "accepted" : "declined"} ${original.id}`);
    const taken = decisions.find((d) => d.ack === "accept");
    if (ack === "accept" && taken) {
      throw invalid(`${taken.m.from_addr} already accepted this handoff (${original.id})`);
    }
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
    // Applies to every sender, humans included: a full inbox means "wait until they catch up".
    for (const r of recipients) {
      if (r.remote) continue;
      const unread = this.#ctx.store.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM deliveries WHERE ${r.agent ? "to_agent_id = ?" : "to_agent_id IS NULL AND to_addr = ?"} AND state IN ('queued','delivered','held')`,
        r.agent ? r.agent.id : r.toAddr,
      )?.n;
      if ((unread ?? 0) >= LIMITS.maxUnreadPerRecipient) {
        throw limited(
          "inbox_full",
          `${r.toAddr} has ${unread} unread messages; wait until it catches up`,
        );
      }
    }
    if (sender.kind !== "agent") return; // humans are never throttled
    const { store } = this.#ctx;
    // Group conversations get proportionally more room than two agents ping-ponging.
    const extraPeople = original
      ? Math.max(0, this.participants(this.envelopeOf(original)).length - 2)
      : 0;
    // `agentlink thread <id> --allow N` (by a human) raises both the thread cap and reply depth.
    const allowance = thread
      ? (store.get<{ extra_allowance: number }>(
          "SELECT extra_allowance FROM thread_state WHERE thread_id = ?",
          thread,
        )?.extra_allowance ?? 0)
      : 0;
    if (thread) {
      const count = store.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?",
        thread,
      )?.n;
      if ((count ?? 0) >= LIMITS.threadMaxMessages + allowance + 10 * extraPeople) {
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
      if ((depth ?? 0) >= LIMITS.replyMaxDepth + allowance + 4 * extraPeople) {
        throw limited(
          "reply_depth",
          `reply chain is ${depth} deep (max ${LIMITS.replyMaxDepth + allowance + 4 * extraPeople}); summarise and start a new thread, or ask your user to allow more on this machine (agentlink thread ${original.thread_id} --allow 10)`,
        );
      }
    }
    const since = iso(new Date(this.#ctx.now().getTime() - LIMITS.pairRateWindowMs));
    for (const r of recipients) {
      if (!r.agent && !r.remote) continue;
      const n = store.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM messages m JOIN deliveries d ON d.message_id = m.id
         WHERE m.from_agent_id = ? AND ${r.agent ? "d.to_agent_id = ?" : "d.to_addr = ?"} AND m.created_at > ?`,
        sender.agent.id,
        r.agent ? r.agent.id : r.toAddr,
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
    // An agent can only answer or continue conversations it takes part in; others don't exist.
    const self: InboxTarget = sender.kind === "agent" ? { agent: sender.agent } : { human: true };
    const original = input.replyTo ? this.resolveMessage(input.replyTo, self) : undefined;
    if (!original && ["reply", "ack", "review_result"].includes(input.kind)) {
      throw invalid(`a ${input.kind} must answer a message (replyTo)`);
    }
    if (original && ["reply", "ack", "review_result"].includes(input.kind)) {
      this.#checkAnswerer(sender, original, input.ack);
    }
    let to = input.to ?? [];
    const groupDecision =
      !!original &&
      original.kind === "handoff" &&
      input.kind === "ack" &&
      input.ack === "accept" &&
      this.participants(this.envelopeOf(original)).length > 2;
    const authorFollowUp = !!original && !input.to?.length && this.#isAuthor(sender, original);
    // Seen in practice: an agent "clearing" an FYI with reply --all "processed" pings everyone.
    if (
      input.replyAll &&
      sender.kind === "agent" &&
      original?.kind === "info" &&
      /^\s*(ok(ay)?|processed|noted|ack(nowledged)?|got it|thanks?( you)?|received|done|seen|read)\W*$/i.test(
        text,
      )
    ) {
      throw invalid(
        `${original.id.slice(0, 12)} was an FYI: nobody needs an answer. Carry on (or confirm to the sender only: agentlink ack ${original.id.slice(0, 12)})`,
      );
    }
    if (input.replyAll || groupDecision || authorFollowUp) {
      if (!original) throw invalid("--all needs a message to answer");
      const me = sender.kind === "agent" ? sender.agent.name : `@${this.handle}`;
      // Everyone still reachable; a participant that no longer exists is skipped.
      to = this.participants(this.envelopeOf(original)).filter(
        (p) => p !== me && this.#resolvable(sender, p),
      );
      if (to.length === 0)
        throw invalid(`nobody else in the conversation of ${original.id} is reachable`);
    }
    const recipients = this.#resolveRecipients(sender, to, original);
    const thread =
      original?.thread_id ?? (input.thread ? this.resolveThread(input.thread, self) : undefined);
    const key = echoKey(`${input.kind}:${text}`);
    // What an agent sends during a headless run counts one hop further than what started it,
    // so runs that wake other runs stop at the hop limit.
    const runHops =
      sender.kind === "agent"
        ? store.get<{ h: number | null }>(
            "SELECT MAX(hops) AS h FROM runs WHERE agent_id = ? AND state = 'running'",
            sender.agent.id,
          )?.h
        : null;
    const hops = Math.max(input.hops ?? 0, runHops == null ? 0 : runHops + 1);
    this.#checkGuards(sender, recipients, thread, original, key, hops);
    if (sender.kind === "agent" && partsHaveInvite(parts)) {
      throw invalid(
        "that looks like a team invite code; invites are for people: show it to your user and let them share it",
      );
    }
    if (recipients.some((r) => r.remote)) {
      // Anything leaving this machine is scanned: text, file names and bytes, and data parts.
      const secrets = scanParts(input.parts ?? [{ kind: "text", text }]);
      if (secrets.length > 0 && (!input.force || sender.kind === "agent")) {
        throw invalid(
          sender.kind === "agent"
            ? `refusing to send what looks like a secret to a teammate (${secrets.join(", ")}); remove it (only your user can override this)`
            : `refusing to send what looks like a secret to a teammate (${secrets.join(", ")}); remove it, or resend with --force`,
        );
      }
    }

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
      hops,
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
        if (r.remote) {
          state = "queued";
          method = "relay";
        } else if (answersWaiter && isOriginalAuthor(r)) {
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
      this.#index(envelope.messageId);
      if (original) {
        this.#markAnswered(
          original,
          sender,
          envelope.messageId,
          input.kind,
          stamp,
          ackNote(input.ack, text),
        );
      }
      return ids;
    });

    // Teammates: one sealed copy per member (their daemon picks out its own recipients).
    for (const handle of new Set(recipients.flatMap((r) => (r.remote ? [r.remote] : [])))) {
      const devices = this.remote?.deliver(handle, envelope) ?? 0;
      const connected = this.remote?.connected() ?? false;
      store.run(
        `UPDATE deliveries SET state = ?, note = ? WHERE message_id = ? AND (to_addr = ? OR to_addr LIKE ?)`,
        devices === 0 ? "failed" : connected ? "sent" : "queued",
        devices === 0
          ? `${handle} has no devices in the team`
          : connected
            ? `sent to ${handle} (${devices} device${devices > 1 ? "s" : ""}) via the relay`
            : "relay offline: queued here; sends when agentlink reconnects",
        envelope.messageId,
        `@${handle}`,
        `${handle}/%`,
      );
    }

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
    if (original && input.kind === "ack" && input.ack === "accept")
      this.#settleHandoff(original, message);
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
    note: string | null = null,
  ): void {
    const isAck = kind === "ack";
    const state: DeliveryState = isAck ? "acked" : "replied";
    const column = isAck ? "acked_at" : "replied_at";
    const who = sender.kind === "agent" ? "to_agent_id = ?" : "to_agent_id IS NULL AND to_addr = ?";
    const whoParam = sender.kind === "agent" ? sender.agent.id : `@${this.handle}`;
    const updated = this.#ctx.store.run(
      `UPDATE deliveries SET state = ?, ${column} = ?, reply_id = COALESCE(reply_id, ?),
         seen_at = COALESCE(seen_at, ?), delivered_at = COALESCE(delivered_at, ?), note = COALESCE(?, note)
       WHERE message_id = ? AND ${who} AND state NOT IN ('refused','expired')
         ${isAck ? "AND state NOT IN ('replied')" : ""}`,
      state,
      stamp,
      replyId,
      stamp,
      stamp,
      note,
      original.id,
      whoParam,
    );
    if (updated.changes > 0) {
      for (const d of this.deliveriesOf(original.id)) this.#publishDelivery(d);
    }
  }

  // ---------------------------------------------------------------- teammates

  /**
   * Accepts a verified envelope from teammate `fromHandle` (the relay client checked the device
   * signature). Returns local deliveries to plan and "delivered/held/…" receipts to send back.
   */
  receiveRemote(
    raw: unknown,
    fromHandle: string,
  ): {
    queued: InboxItem[];
    receipts: { to: string; state: string; note?: string; deliveryId?: number }[];
    messageId?: string;
  } {
    const { store } = this.#ctx;
    const envelope = RemoteEnvelopeSchema.parse(raw);
    if (envelope.from.member !== fromHandle || envelope.from.role === "system") {
      throw invalid(
        `envelope claims to be from ${envelope.from.member}, but ${fromHandle} sent it`,
      );
    }
    if (store.get("SELECT 1 FROM messages WHERE id = ?", envelope.messageId)) {
      return { queued: [], receipts: [] }; // duplicate (relay retry)
    }
    const mine = envelope.to.filter((a) => a.member === this.handle);
    if (mine.length === 0) return { queued: [], receipts: [] };
    const text = textOf(envelope);
    const fromAddr =
      envelope.from.role === "agent" && envelope.from.agent
        ? `${envelope.from.member}/${envelope.from.agent}`
        : `@${envelope.from.member}`;
    const original = envelope.replyTo
      ? store.get<MessageRow>("SELECT * FROM messages WHERE id = ?", envelope.replyTo)
      : undefined;
    const answersWaiter =
      !!original &&
      ["reply", "review_result", "ack"].includes(envelope.kind) &&
      this.hasReplyWaiter(original.id);
    const overrides = { ...this.#overrides("teammate"), ...this.#overrides(fromHandle) };
    const stamp = iso(this.#ctx.now());
    const receipts: { to: string; state: string; note?: string; deliveryId?: number }[] = [];

    const ids = store.tx(() => {
      store.run(
        `INSERT INTO messages (id, thread_id, reply_to, task_id, kind, from_addr, from_agent_id, trust, envelope,
           preview, echo_key, wait, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 'teammate', ?, ?, ?, ?, ?, ?)`,
        envelope.messageId,
        envelope.contextId,
        envelope.replyTo ?? null,
        envelope.taskId ?? null,
        envelope.kind,
        fromAddr,
        JSON.stringify(envelope),
        preview(text),
        echoKey(`${envelope.kind}:${text}`),
        envelope.meta.wait ? 1 : 0,
        envelope.createdAt,
        envelope.meta.expiresAt,
      );
      const out: number[] = [];
      for (const addr of mine) {
        const human = addr.role === "human" || !addr.agent;
        const agent = human ? undefined : this.#registry.resolveName(addr.agent as string)?.agent;
        const theirAddr = human ? `@${this.handle}` : `${this.handle}/${addr.agent}`;
        if (!human && !agent) {
          receipts.push({
            to: theirAddr,
            state: "failed",
            note: `no agent named ${addr.agent} on ${this.handle}'s machine`,
          });
          continue;
        }
        let state: DeliveryState;
        let method: string | null = null;
        let note: string | null = null;
        if (answersWaiter && agent && agent.id === original?.from_agent_id) {
          state = "seen";
          method = "longpoll";
        } else if (human) {
          state = "delivered";
        } else {
          const action = decidePolicy("teammate", envelope.kind, overrides);
          state = action === "deliver" ? "queued" : action === "hold" ? "held" : "refused";
          if (action !== "deliver") note = `policy: ${action}`;
        }
        const res = store.run(
          `INSERT INTO deliveries (message_id, to_addr, to_agent_id, state, method, note, created_at, delivered_at, seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          envelope.messageId,
          human ? `@${this.handle}` : (agent as AgentRow).name,
          agent?.id ?? null,
          state,
          method,
          note,
          stamp,
          state === "delivered" || state === "seen" ? stamp : null,
          state === "seen" ? stamp : null,
        );
        out.push(res.lastInsertRowid);
        receipts.push({
          to: theirAddr,
          state: state === "queued" ? "delivered" : state,
          ...(note ? { note } : {}),
          deliveryId: res.lastInsertRowid,
        });
      }
      this.#index(envelope.messageId);
      if (original) {
        const isAck = envelope.kind === "ack";
        store.run(
          `UPDATE deliveries SET state = ?, ${isAck ? "acked_at" : "replied_at"} = ?, reply_id = COALESCE(reply_id, ?),
             note = COALESCE(?, note)
           WHERE message_id = ? AND to_addr = ? AND state NOT IN ('refused','expired','replied')`,
          isAck ? "acked" : "replied",
          stamp,
          envelope.messageId,
          isAck ? ackNote(envelope.meta.ack, text) : null,
          original.id,
          fromAddr,
        );
      }
      return out;
    });

    const message = store.get<MessageRow>(
      "SELECT * FROM messages WHERE id = ?",
      envelope.messageId,
    ) as MessageRow;
    const deliveries = ids.map(
      (id) => store.get<DeliveryRow>("SELECT * FROM deliveries WHERE id = ?", id) as DeliveryRow,
    );
    this.#ctx.events.publish({ type: "message", message: this.messageView(message) });
    for (const d of deliveries) this.#publishDelivery(d);
    if (original) {
      for (const d of this.deliveriesOf(original.id)) this.#publishDelivery(d);
      this.#resolveReplyWaiters(original.id, message);
      if (envelope.kind === "ack" && envelope.meta.ack === "accept")
        this.#settleHandoff(original, message);
    }
    for (const d of deliveries) this.#notifyInbox(d.to_agent_id ?? "human");
    return {
      queued: deliveries
        .filter((d) => d.state === "queued")
        .map((d) => ({ delivery: d, message, envelope })),
      receipts,
      messageId: envelope.messageId,
    };
  }

  /** The relay accepted our copy for `handle`: queued (relay was offline) becomes sent. */
  markRelaySent(messageId: string, handle: string): void {
    const res = this.#ctx.store.run(
      `UPDATE deliveries SET state = 'sent', note = NULL
       WHERE message_id = ? AND state = 'queued' AND to_agent_id IS NULL AND (to_addr = ? OR to_addr LIKE ?)`,
      messageId,
      `@${handle}`,
      `${handle}/%`,
    );
    if (res.changes > 0) for (const d of this.deliveriesOf(messageId)) this.#publishDelivery(d);
  }

  /**
   * The handoff's author settles races: when a second accept arrives, the late acceptor is told
   * who took it (the author's machine sees every accept).
   */
  #settleHandoff(original: MessageRow, accept: MessageRow): void {
    if (original.kind !== "handoff") return;
    const accepts = this.#ctx.store
      .all<MessageRow>(
        "SELECT * FROM messages WHERE reply_to = ? AND kind = 'ack' ORDER BY created_at, id",
        original.id,
      )
      .filter((m) => this.envelopeOf(m).meta.ack === "accept");
    const first = accepts[0];
    if (!first || first.id === accept.id) return;
    const text = `Automatic notice: ${first.from_addr} accepted this handoff before you (${original.id.slice(0, 12)} "${original.preview}"); it is theirs, so there is nothing for you to do.`;
    const late = accept.from_agent_id ? this.#registry.byId(accept.from_agent_id) : undefined;
    if (late) this.notify(late, text);
    else if (accept.from_addr.includes("/") && this.remote) {
      const handle = accept.from_addr.split("/")[0] as string;
      const agent = accept.from_addr.split("/")[1] as string;
      const author = original.from_agent_id
        ? this.#registry.byId(original.from_agent_id)
        : undefined;
      const envelope = newEnvelope({
        kind: "info",
        from: author
          ? { member: this.handle, agent: author.name, role: "agent" }
          : { member: this.handle, role: "human" },
        to: [{ member: handle, agent, role: "agent" }],
        parts: [{ kind: "text", text }],
        contextId: original.thread_id,
        now: this.#ctx.now(),
      });
      this.remote.deliver(handle, envelope);
    }
  }

  /** A teammate's daemon reports progress on a message we sent it. Never moves backwards. */
  applyReceipt(
    fromHandle: string,
    receipt: { messageId: string; to: string; state: string; note?: string },
  ): boolean {
    if (receipt.to !== `@${fromHandle}` && !receipt.to.startsWith(`${fromHandle}/`)) return false;
    const d = this.#ctx.store.get<DeliveryRow>(
      "SELECT * FROM deliveries WHERE message_id = ? AND to_addr = ?",
      receipt.messageId,
      receipt.to,
    );
    if (!d) return false;
    const rank = RANK[receipt.state] ?? -1;
    const current = RANK[d.state] ?? 0;
    if (
      rank < current ||
      (rank === current && (receipt.state !== d.state || receipt.note === (d.note ?? undefined)))
    ) {
      return false;
    }
    const stamp = iso(this.#ctx.now());
    const column: Record<string, string> = {
      delivered: "delivered_at",
      held: "delivered_at",
      seen: "seen_at",
      acked: "acked_at",
      replied: "replied_at",
    };
    const col = column[receipt.state];
    this.#ctx.store.run(
      `UPDATE deliveries SET state = ?, note = ?${col ? `, ${col} = COALESCE(${col}, ?)` : ""} WHERE id = ?`,
      ...([receipt.state, receipt.note ?? null, ...(col ? [stamp] : []), d.id] as (
        | string
        | number
        | null
      )[]),
    );
    const updated = this.#ctx.store.get<DeliveryRow>("SELECT * FROM deliveries WHERE id = ?", d.id);
    if (updated) this.#publishDelivery(updated);
    this.#checkFailed(receipt.messageId);
    if (["refused", "failed", "expired"].includes(receipt.state)) {
      const message = this.#ctx.store.get<MessageRow>(
        "SELECT * FROM messages WHERE id = ?",
        receipt.messageId,
      );
      const author = message?.from_agent_id
        ? this.#registry.byId(message.from_agent_id)
        : undefined;
      if (author && message) {
        // The note is the teammate's text inside an agentlink notice: one quoted, attributed line.
        const note = safeField(receipt.note, 200)?.replace(/"/g, "'");
        this.notify(
          author,
          `Your ${message.kind} ${message.id.slice(0, 12)} to ${receipt.to} was not delivered: ${receipt.state}${note ? ` (${fromHandle}'s machine says: "${note}")` : ""}.`,
        );
      }
    }
    return true;
  }

  /**
   * A thread id, or the id (or unique prefix) of any message in the thread. With a `viewer`, only
   * threads in which it can see a message exist.
   */
  resolveThread(idOrPrefix: string, viewer?: InboxTarget): string {
    const key = idOrPrefix.trim().toUpperCase();
    const [vis, vp]: [string, string[]] = viewer ? this.#visibleSql(viewer) : ["1", []];
    const direct = this.#ctx.store.get<{ thread_id: string }>(
      `SELECT m.thread_id FROM messages m WHERE (m.thread_id = ? OR m.id = ?) AND ${vis} LIMIT 1`,
      key,
      key,
      ...vp,
    );
    if (direct) return direct.thread_id;
    if (key.length < 4)
      throw invalid(`"${idOrPrefix}" is too short; use at least 4 characters of the id`);
    const rows = this.#ctx.store.all<{ thread_id: string }>(
      `SELECT DISTINCT m.thread_id FROM messages m WHERE (m.thread_id LIKE ? OR m.id LIKE ?) AND ${vis} LIMIT 2`,
      `${key}%`,
      `${key}%`,
      ...vp,
    );
    if (rows.length === 0) throw notFound(`thread or message "${idOrPrefix}"`);
    if (rows.length > 1)
      throw invalid(`"${idOrPrefix}" matches several threads; use more characters`);
    return (rows[0] as { thread_id: string }).thread_id;
  }

  // ---------------------------------------------------------------- reading

  #targetClause(target: InboxTarget): [string, string] {
    return "agent" in target
      ? ["d.to_agent_id = ?", target.agent.id]
      : ["d.to_agent_id IS NULL AND d.to_addr = ?", `@${this.handle}`];
  }

  inbox(target: InboxTarget, opts: { unreadOnly?: boolean; limit?: number } = {}): InboxItem[] {
    this.expireSweep(); // never hand out mail past its TTL
    const [clause, param] = this.#targetClause(target);
    const states = opts.unreadOnly ? UNREAD : null;
    const rows = this.#ctx.store.all<DeliveryRow & { m_envelope: string }>(
      `SELECT d.*, m.envelope AS m_envelope FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE ${clause} ${states ? `AND d.state IN (${states.map(() => "?").join(",")})` : "AND d.state NOT IN ('refused','held')"}
       ORDER BY d.id DESC LIMIT ?`,
      param,
      ...(states ?? []),
      opts.limit ?? 50,
    );
    return rows.reverse().map((r) => this.#item(r));
  }

  /** Asks, requests and handoffs addressed to `target` that it has not answered yet, oldest first. */
  todo(target: InboxTarget): InboxItem[] {
    this.expireSweep();
    const [clause, param] = this.#targetClause(target);
    return this.#ctx.store
      .all<DeliveryRow>(
        `SELECT d.* FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE ${clause} AND m.kind IN ('ask','request','handoff','review_request')
           AND d.state IN ('queued','delivered','seen') ORDER BY d.id LIMIT 100`,
        param,
      )
      .map((r) => this.#item(r));
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
    this.expireSweep();
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

  /** Puts handed-over deliveries back in the queue (a headless run ended before reading them). */
  requeue(deliveryIds: number[]): void {
    for (const id of deliveryIds) {
      const res = this.#ctx.store.run(
        "UPDATE deliveries SET state = 'queued', method = NULL, delivered_at = NULL WHERE id = ? AND state = 'delivered'",
        id,
      );
      const d = res.changes
        ? this.#ctx.store.get<DeliveryRow>("SELECT * FROM deliveries WHERE id = ?", id)
        : undefined;
      if (d) this.#publishDelivery(d);
    }
  }

  /** Whether this delivery answers a message whose sender expects a reply. */
  /** An answer to something this recipient asked (answers to others in a group don't wake). */
  answersExpecting(item: InboxItem): boolean {
    if (!item.message.reply_to) return false;
    const original = this.#ctx.store.get<MessageRow>(
      "SELECT kind, from_agent_id FROM messages WHERE id = ?",
      item.message.reply_to,
    );
    return (
      !!original &&
      EXPECTS_REPLY.has(original.kind) &&
      (original.from_agent_id === null || original.from_agent_id === item.delivery.to_agent_id)
    );
  }

  /** Everyone in a message's conversation (sender and recipients), as addressed from here. */
  participants(env: Pick<Envelope, "from" | "to">): string[] {
    const local = (a: Envelope["from"]): string | undefined => {
      if (a.role === "system") return undefined;
      const human = a.role === "human" || !a.agent;
      if (a.member === this.handle) return human ? `@${this.handle}` : a.agent;
      return human ? `@${a.member}` : `${a.member}/${a.agent}`;
    };
    return [...new Set([env.from, ...env.to].map(local).filter((x): x is string => !!x))];
  }

  renderItem(item: InboxItem): RenderItem {
    const env = item.envelope;
    const author = item.message.from_agent_id
      ? this.#registry.byId(item.message.from_agent_id)
      : undefined;
    const remoteInfo =
      !author && env.from.role === "agent" && env.from.agent
        ? this.remote?.infoOf(env.from.member, env.from.agent)
        : undefined;
    // Who is writing: "codex-api (Codex · gpt-5 · ~/work/api · on laptop)",
    // "alice/claude-web (Claude Code · opus-4.5 · web · 'fix login' · on alice-laptop)", "@alice".
    // Model, title and project are the sender's claims: shown, never trusted.
    const fromLabel = author
      ? fromLabelOf({
          name: author.name,
          harness: toolLabel(author.tool),
          model: author.model,
          dir: author.cwd ? homeShort(author.cwd) : author.project,
          branch: author.branch,
          title: author.title,
          host: hostname(),
        })
      : env.from.role === "system"
        ? "agentlink"
        : env.from.role === "human"
          ? `@${env.from.member}`
          : remoteInfo
            ? fromLabelOf({
                name: `${env.from.member}/${env.from.agent}`,
                harness: toolLabel(remoteInfo.tool),
                model: remoteInfo.model ?? null,
                dir: remoteInfo.project ?? null,
                branch: remoteInfo.branch ?? null,
                title: remoteInfo.title ?? null,
                host: remoteInfo.host ?? null,
              })
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
      others: this.participants(env).filter(
        (p) => p !== item.delivery.to_addr && p !== item.message.from_addr,
      ),
      ...(env.from.role === "human" ? { fromHuman: true } : {}),
      ...(env.from.role === "system" ? { fromSystem: true } : {}),
      ...(() => {
        if (!env.replyTo) return {};
        const original = this.#ctx.store.get<MessageRow>(
          "SELECT * FROM messages WHERE id = ?",
          env.replyTo,
        );
        if (!original || !this.#sees(item.delivery.to_agent_id, original)) return {};
        const readerIsAuthor = item.delivery.to_agent_id
          ? original.from_agent_id === item.delivery.to_agent_id
          : original.from_agent_id === null && original.from_addr === item.delivery.to_addr;
        return {
          replyToPreview: original.preview,
          ...(readerIsAuthor ? {} : { replyToAuthor: original.from_addr }),
        };
      })(),
      ...(() => {
        if (env.kind !== "handoff") return {};
        const taker = this.#ctx.store
          .all<MessageRow>(
            "SELECT * FROM messages WHERE reply_to = ? AND kind = 'ack'",
            env.messageId,
          )
          .find((m) => this.envelopeOf(m).meta.ack === "accept");
        return taker ? { takenBy: taker.from_addr } : {};
      })(),
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

  // ---------------------------------------------------------------- waiting

  /**
   * Waits for answers (reply / review_result / ack) to `messageId` from `expected` recipients.
   * Ends early when every recipient has answered or failed (unknown agent, refused, expired).
   */
  waitForReplies(
    messageId: string,
    expected: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ replies: MessageRow[]; failed: DeliveryRow[]; timedOut: boolean }> {
    const snapshot = () => {
      const replies = this.#ctx.store.all<MessageRow>(
        "SELECT * FROM messages WHERE reply_to = ? AND kind IN ('reply','review_result','ack') ORDER BY created_at",
        messageId,
      );
      const deliveries = this.deliveriesOf(messageId);
      const failed = deliveries.filter((d) => ["failed", "refused", "expired"].includes(d.state));
      const answered = new Set(replies.map((r) => r.from_agent_id ?? r.from_addr)).size;
      const done =
        (deliveries.length > 0 && failed.length === deliveries.length) ||
        answered >= Math.max(1, expected - failed.length);
      return { replies, failed, done };
    };
    const first = snapshot();
    if (first.done)
      return Promise.resolve({ replies: first.replies, failed: first.failed, timedOut: false });
    return new Promise((resolve) => {
      const set = this.#replyWaiters.get(messageId) ?? new Set();
      const finish = (timedOut: boolean) => {
        clearTimeout(timer);
        set.delete(poke);
        if (set.size === 0) this.#replyWaiters.delete(messageId);
        try {
          const { replies, failed } = snapshot();
          resolve({ replies, failed, timedOut });
        } catch {
          resolve({ replies: [], failed: [], timedOut: true }); // daemon shutting down
        }
      };
      const poke = () => {
        try {
          if (snapshot().done) finish(false);
        } catch {
          finish(true);
        }
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      signal?.addEventListener("abort", () => finish(true), { once: true });
      set.add(poke);
      this.#replyWaiters.set(messageId, set);
    });
  }

  /** Single-recipient form of waitForReplies. */
  async waitForReply(
    messageId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WaitOutcome> {
    const r = await this.waitForReplies(messageId, 1, timeoutMs, signal);
    if (r.replies[0]) return { kind: "reply", message: r.replies[0] };
    if (r.failed.length && !r.timedOut) return { kind: "failed", deliveries: r.failed };
    return { kind: "timeout" };
  }

  /** Re-checks waits on `messageId` (a delivery failed). */
  #checkFailed(messageId: string): void {
    for (const poke of [...(this.#replyWaiters.get(messageId) ?? [])]) poke();
  }

  #resolveReplyWaiters(originalId: string, reply: MessageRow): void {
    if (!["reply", "review_result", "ack"].includes(reply.kind)) return;
    for (const poke of [...(this.#replyWaiters.get(originalId) ?? [])]) poke();
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
    if (decision === "deny") {
      this.#checkFailed(updated.message_id);
      const message = this.#ctx.store.get<MessageRow>(
        "SELECT * FROM messages WHERE id = ?",
        updated.message_id,
      );
      const author = message?.from_agent_id
        ? this.#registry.byId(message.from_agent_id)
        : undefined;
      if (author && message) {
        this.notify(
          author,
          `Your ${message.kind} ${message.id} to ${updated.to_addr} was not delivered: ${by} denied it.`,
        );
      }
    }
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
    for (const id of new Set(rows.map((r) => r.message_id))) this.#checkFailed(id);
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
      const rowid = this.#ctx.store.run(
        "INSERT INTO deliveries (message_id, to_addr, to_agent_id, state, created_at) VALUES (?, ?, ?, 'queued', ?)",
        envelope.messageId,
        agent.name,
        agent.id,
        stamp,
      ).lastInsertRowid;
      this.#index(envelope.messageId);
      return rowid;
    });
    const delivery = this.#ctx.store.get<DeliveryRow>(
      "SELECT * FROM deliveries WHERE id = ?",
      id,
    ) as DeliveryRow;
    this.#publishDelivery(delivery);
    this.#notifyInbox(agent.id);
    return this.#item(delivery);
  }

  // ---------------------------------------------------------------- history

  /** Agents see what they sent or what reached them (not held or refused); you see everything. */
  visibleTo(viewer: InboxTarget, m: MessageRow): boolean {
    return this.#sees("agent" in viewer ? viewer.agent.id : null, m);
  }

  #sees(agentId: string | null, m: MessageRow): boolean {
    return (
      agentId === null ||
      m.from_agent_id === agentId ||
      this.deliveriesOf(m.id).some(
        (d) => d.to_agent_id === agentId && d.state !== "held" && d.state !== "refused",
      )
    );
  }

  /** visibleTo as SQL over messages aliased `a` (+: find deliveries by message, not by agent). */
  #visibleSql(viewer: InboxTarget, a = "m"): [string, string[]] {
    if (!("agent" in viewer)) return ["1", []];
    return [
      `(${a}.from_agent_id = ? OR EXISTS (SELECT 1 FROM deliveries vd WHERE vd.message_id = ${a}.id AND +vd.to_agent_id = ? AND vd.state NOT IN ('held','refused')))`,
      [viewer.agent.id, viewer.agent.id],
    ];
  }

  #index(id: string): void {
    if (!this.fts) return;
    const m = this.#ctx.store.get<MessageRow>(
      "SELECT from_addr, envelope FROM messages WHERE id = ?",
      id,
    );
    if (!m) return;
    const doc = searchDoc(
      m.from_addr,
      m.envelope,
      this.deliveriesOf(id).map((d) => d.to_addr),
    );
    this.#ctx.store.run(
      "INSERT INTO messages_fts (id, body, names, addrs) VALUES (?, ?, ?, ?)",
      id,
      doc.body,
      doc.names,
      doc.addrs,
    );
  }

  /** An address as typed ("alpha", "me/alpha", "@bob", a renamed agent's old name). */
  #addrKey(input: string): { addr: string; agentId: string | null } {
    let addr = input.trim().toLowerCase();
    if (addr.startsWith(`${this.handle}/`)) addr = addr.slice(this.handle.length + 1);
    const agent =
      addr.includes("/") || addr.startsWith("@")
        ? undefined
        : this.#registry.resolveName(addr)?.agent;
    if (!agent && addr === this.handle) addr = `@${addr}`;
    return { addr, agentId: agent?.id ?? null };
  }

  #filterSql(viewer: InboxTarget, f: MessageFilter): [string, (string | null)[]] {
    const [vis, params] = this.#visibleSql(viewer);
    const where: string[] = [vis];
    const out: (string | null)[] = [...params];
    const add = (sql: string, ...p: (string | null)[]) => {
      where.push(sql);
      out.push(...p);
    };
    if (f.from) {
      const k = this.#addrKey(f.from);
      add("(m.from_addr = ? OR m.from_agent_id = ?)", k.addr, k.agentId);
    }
    if (f.mine) {
      if ("agent" in viewer) add("m.from_agent_id = ?", viewer.agent.id);
      else add("(m.from_agent_id IS NULL AND m.from_addr = ?)", `@${this.handle}`);
    }
    if (f.to) {
      const k = this.#addrKey(f.to);
      add(
        "EXISTS (SELECT 1 FROM deliveries fd WHERE fd.message_id = m.id AND (fd.to_addr = ? OR fd.to_agent_id = ?))",
        k.addr,
        k.agentId,
      );
    }
    if (f.kinds?.length) add(`m.kind IN (${f.kinds.map(() => "?").join(",")})`, ...f.kinds);
    if (f.since) add("m.created_at >= ?", f.since);
    if (f.until) add("m.created_at <= ?", f.until);
    if (f.thread) add("m.thread_id = ?", f.thread);
    if (f.repo) {
      add(
        `(instr(lower(coalesce(json_extract(m.envelope, '$.meta.repo'), '')), lower(?)) > 0
          OR m.from_agent_id IN (SELECT id FROM agents WHERE instr(lower(coalesce(repo_root, '') || ' ' || coalesce(repo_remote, '')), lower(?)) > 0))`,
        f.repo,
        f.repo,
      );
    }
    return [where.join(" AND "), out];
  }

  /** The newest `limit` messages matching `f` that `viewer` may see, oldest first. */
  history(viewer: InboxTarget, f: MessageFilter, limit: number): MessageRow[] {
    const [where, params] = this.#filterSql(viewer, f);
    return this.#ctx.store
      .all<MessageRow>(
        `SELECT m.* FROM messages m WHERE ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
        ...params,
        limit,
      )
      .reverse();
  }

  /**
   * Compact search hits, newest first. `q` is plain words (all must match, as prefixes); no
   * query syntax reaches FTS5. Without `q`, lists what the filters match.
   */
  search(
    viewer: InboxTarget,
    f: MessageFilter,
    q: string | undefined,
    limit: number,
    offset: number,
  ): SearchRow[] {
    const { store } = this.#ctx;
    const [where, params] = this.#filterSql(viewer, f);
    const tail = "ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?";
    const text = q?.trim() ?? "";
    let words: string[] = [];
    let rows: (MessageRow & { snip?: string | null })[];
    if (!text) {
      rows = store.all(
        `SELECT m.* FROM messages m WHERE ${where} ${tail}`,
        ...params,
        limit,
        offset,
      );
    } else if (this.fts) {
      words = (text.match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).slice(0, 16).map((w) => w.slice(0, 64));
      if (words.length === 0) return [];
      try {
        rows = store.all(
          `SELECT m.*, snippet(messages_fts, 1, '«', '»', '…', 16) AS snip
           FROM messages_fts JOIN messages m ON m.id = messages_fts.id
           WHERE messages_fts MATCH ? AND ${where} ${tail}`,
          words.map((w) => `"${w}"*`).join(" "),
          ...params,
          limit,
          offset,
        );
      } catch (error) {
        throw invalid(`cannot search for that (${(error as Error).message})`);
      }
    } else {
      words = text.split(/\s+/).slice(0, 16);
      const like = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      rows = store.all(
        `SELECT m.* FROM messages m WHERE ${words.map(() => "(m.preview LIKE ? ESCAPE '\\' OR m.envelope LIKE ? ESCAPE '\\')").join(" AND ")}
           AND ${where} ${tail}`,
        ...words.flatMap((w) => [like(w), like(w)]),
        ...params,
        limit,
        offset,
      );
    }
    return rows.map((m) => {
      const env = this.envelopeOf(m);
      const full = textOf(env);
      return {
        id: m.id,
        thread: m.thread_id,
        kind: m.kind,
        from: m.from_addr,
        to: this.participants(env).filter((p) => p !== m.from_addr),
        createdAt: m.created_at,
        snippet: safeField(m.snip || highlight(full, words) || m.preview, 300) ?? "",
        tokens: Math.ceil(full.length / 4),
      };
    });
  }

  /** Conversations by last activity, built only from messages `viewer` may see. */
  threads(
    viewer: InboxTarget,
    opts: { limit: number; offset: number; with?: string; open?: boolean },
  ): (ThreadSummary & ThreadStatus)[] {
    const { store } = this.#ctx;
    const agentId = "agent" in viewer ? viewer.agent.id : null;
    // Unary + keeps SQLite on the per-thread/per-message indexes instead of scanning every
    // delivery or message of the caller once per thread.
    const toMe = (a: string) =>
      agentId ? `+${a}.to_agent_id = ?` : `+${a}.to_agent_id IS NULL AND ${a}.to_addr = ?`;
    const me = agentId ?? `@${this.handle}`;
    const byMe = agentId ? "+q.from_agent_id = ?" : "+q.from_agent_id IS NULL AND q.from_addr = ?";
    const [vis, visParams] = this.#visibleSql(viewer);
    const params: (string | number | null)[] = [me, me, me, ...visParams];
    let having = "";
    if (opts.with) {
      const k = this.#addrKey(opts.with);
      having = `HAVING SUM(m.from_addr = ? OR m.from_agent_id = ? OR EXISTS (SELECT 1 FROM deliveries wd
        WHERE wd.message_id = m.id AND (wd.to_addr = ? OR wd.to_agent_id = ?))) > 0`;
      params.push(k.addr, k.agentId, k.addr, k.agentId);
    }
    // Without the open filter, only the page's threads get the per-thread subqueries.
    const order = "ORDER BY last_at DESC, thread DESC";
    const page = `${order} LIMIT ? OFFSET ?`;
    // Open: an ask/request/handoff/review the caller still has to answer (yours), or still
    // waits on (theirs).
    const rows = store.all<{
      thread: string;
      n: number;
      last_at: string;
      yours: number;
      theirs: number;
      unread: number;
    }>(
      `SELECT * FROM (
         SELECT t.*,
           EXISTS (SELECT 1 FROM messages q JOIN deliveries d ON d.message_id = q.id
             WHERE q.thread_id = t.thread AND q.kind IN ${EXPECTING}
               AND ${toMe("d")} AND +d.state IN ('queued','delivered','seen')) AS yours,
           EXISTS (SELECT 1 FROM messages q JOIN deliveries d ON d.message_id = q.id
             WHERE q.thread_id = t.thread AND q.kind IN ${EXPECTING}
               AND ${byMe} AND +d.state IN ('queued','sent','held','delivered','seen')
               AND NOT EXISTS (SELECT 1 FROM deliveries x WHERE x.message_id = q.id AND x.state IN ('replied','acked'))
           ) AS theirs,
           (SELECT COUNT(*) FROM messages um JOIN deliveries u ON u.message_id = um.id
             WHERE um.thread_id = t.thread AND ${toMe("u")} AND +u.state IN ('queued','delivered')) AS unread
         FROM (
           SELECT m.thread_id AS thread, COUNT(*) AS n, MAX(m.created_at) AS last_at
           FROM messages m WHERE ${vis} GROUP BY m.thread_id ${having} ${opts.open ? "" : page}
         ) t
       ) ${opts.open ? `WHERE yours = 1 OR theirs = 1 ${page}` : order}`,
      ...params,
      opts.limit,
      opts.offset,
    );
    const edge = (dir: "" | " DESC", thread: string) =>
      store.get<{ preview: string; from_addr: string }>(
        `SELECT m.preview, m.from_addr FROM messages m WHERE m.thread_id = ? AND ${vis}
         ORDER BY m.created_at${dir}, m.id${dir} LIMIT 1`,
        thread,
        ...visParams,
      ) as { preview: string; from_addr: string };
    return rows.map((r) => {
      const first = edge("", r.thread);
      const last = edge(" DESC", r.thread);
      // Distinct sender/recipient sets in order of first appearance: the same participants, in
      // the same order, as walking every message, without loading each one into JS.
      const parties = store.all<{ p: string }>(
        `SELECT p FROM (
           SELECT json_extract(m.envelope, '$.from', '$.to') AS p,
             ROW_NUMBER() OVER (ORDER BY m.created_at, m.id) AS seq
           FROM messages m WHERE m.thread_id = ? AND ${vis}
         ) GROUP BY p ORDER BY MIN(seq)`,
        r.thread,
        ...visParams,
      );
      return {
        thread: r.thread,
        subject: first.preview,
        participants: [
          ...new Set(
            parties.flatMap(({ p }) => {
              const [from, to] = JSON.parse(p) as [unknown, unknown[]];
              return this.participants({
                from: AddrSchema.parse(from),
                to: to.map((a) => AddrSchema.parse(a)),
              });
            }),
          ),
        ],
        messages: r.n,
        lastAt: r.last_at,
        lastFrom: last.from_addr,
        lastPreview: last.preview,
        open: r.yours === 1 || r.theirs === 1,
        needsAnswer: r.yours === 1,
        waiting: r.theirs === 1,
        unread: r.unread,
        ...this.threadStatus(r.thread, viewer),
      };
    });
  }

  /** Who still owes answers in a thread and what is held, from the messages `viewer` sees. */
  threadStatus(threadId: string, viewer: InboxTarget): ThreadStatus {
    const [vis, visParams] = this.#visibleSql(viewer);
    const rows = this.#ctx.store.all<{
      to_addr: string;
      to_agent_id: string | null;
      state: string;
    }>(
      `SELECT d.to_addr, d.to_agent_id, d.state FROM messages m JOIN deliveries d ON d.message_id = m.id
       WHERE m.thread_id = ? AND ${vis} AND (d.state = 'held'
         OR (m.kind IN ${EXPECTING} AND d.state IN ('queued','sent','delivered','seen')))
       ORDER BY m.created_at, m.id, d.id`,
      threadId,
      ...visParams,
    );
    const held = rows.filter((d) => d.state === "held").length;
    const owing = rows.filter((d) => d.state !== "held");
    const awaiting = [...new Set(owing.map((d) => d.to_addr))];
    const you = owing.some((d) =>
      "agent" in viewer
        ? d.to_agent_id === viewer.agent.id
        : d.to_agent_id === null && d.to_addr === `@${this.handle}`,
    );
    const state = held
      ? "held"
      : you
        ? "waiting_on_you"
        : awaiting.length
          ? "awaiting"
          : "answered";
    return { state, awaiting, held };
  }

  /** Unread mail and unanswered asks/requests/handoffs for `target` (as in inbox and todo). */
  counts(target: InboxTarget): { unread: number; todo: number } {
    this.expireSweep();
    const [clause, param] = this.#targetClause(target);
    const n = (sql: string) => this.#ctx.store.get<{ n: number }>(sql, param)?.n ?? 0;
    return {
      unread: n(
        `SELECT COUNT(*) AS n FROM deliveries d WHERE ${clause} AND d.state IN ('queued','delivered')`,
      ),
      todo: n(
        `SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE ${clause} AND m.kind IN ${EXPECTING} AND d.state IN ('queued','delivered','seen')`,
      ),
    };
  }

  /**
   * Deletes messages older than `olderThanMs` whose every delivery is finished: read (and, for
   * asks/requests/handoffs/reviews, answered), refused, expired or failed. Never unread, held,
   * queued or in-flight mail, nor a message someone is blocked waiting on.
   */
  prune(
    olderThanMs: number,
    dryRun = false,
  ): {
    dryRun: boolean;
    cutoff: string;
    messages: number;
    deliveries: number;
    threads: number;
    kept: number;
  } {
    this.expireSweep();
    const { store } = this.#ctx;
    const cutoff = iso(new Date(this.#ctx.now().getTime() - olderThanMs));
    const old = store.all<{ id: string; thread_id: string; busy: number }>(
      `SELECT m.id, m.thread_id, EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND (
         d.state NOT IN ('seen','acked','replied','refused','expired','failed')
         OR (d.state = 'seen' AND m.kind IN ${EXPECTING}))) AS busy
       FROM messages m WHERE m.created_at < ?`,
      cutoff,
    );
    const doomed = old.filter((r) => !r.busy && !this.hasReplyWaiter(r.id));
    const perThread = new Map<string, number>();
    for (const r of doomed) perThread.set(r.thread_id, (perThread.get(r.thread_id) ?? 0) + 1);
    const emptied = [...perThread].filter(
      ([thread, n]) =>
        store.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?", thread)
          ?.n === n,
    );
    let deliveries = 0;
    store.tx(() => {
      for (let i = 0; i < doomed.length; i += 500) {
        const ids = doomed.slice(i, i + 500).map((r) => r.id);
        const marks = ids.map(() => "?").join(",");
        deliveries +=
          store.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM deliveries WHERE message_id IN (${marks})`,
            ...ids,
          )?.n ?? 0;
        if (dryRun) continue;
        if (this.fts) store.run(`DELETE FROM messages_fts WHERE id IN (${marks})`, ...ids);
        store.run(`DELETE FROM deliveries WHERE message_id IN (${marks})`, ...ids);
        store.run(`DELETE FROM messages WHERE id IN (${marks})`, ...ids);
      }
      if (!dryRun) {
        for (const [thread] of emptied)
          store.run("DELETE FROM thread_state WHERE thread_id = ?", thread);
      }
    });
    if (!dryRun && doomed.length) {
      this.#ctx.events.publish({
        type: "notice",
        level: "info",
        text: `agentlink pruned ${doomed.length} old message${doomed.length === 1 ? "" : "s"}`,
      });
    }
    return {
      dryRun,
      cutoff,
      messages: doomed.length,
      deliveries,
      threads: emptied.length,
      kept: old.length - doomed.length,
    };
  }

  // ---------------------------------------------------------------- views

  /** With a viewer, adds `re` (the parent message) when the viewer may see it. */
  messageView(m: MessageRow, viewer?: InboxTarget): Record<string, unknown> {
    const parent =
      viewer && m.reply_to
        ? this.#ctx.store.get<MessageRow>("SELECT * FROM messages WHERE id = ?", m.reply_to)
        : undefined;
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
      ...(parent && viewer && this.visibleTo(viewer, parent)
        ? { re: { id: parent.id, from: parent.from_addr, preview: parent.preview } }
        : {}),
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

/** A one-line window around the first of `words` found in `text`, marked «like this». */
function highlight(text: string, words: string[]): string | undefined {
  const flat = text.replace(/\s+/g, " ");
  const lower = flat.toLowerCase();
  for (const w of words) {
    const i = w ? lower.indexOf(w.toLowerCase()) : -1;
    if (i < 0) continue;
    const start = Math.max(0, i - 60);
    const end = i + w.length;
    return `${start > 0 ? "…" : ""}${flat.slice(start, i)}«${flat.slice(i, end)}»${flat.slice(end, end + 100)}${end + 100 < flat.length ? "…" : ""}`;
  }
  return undefined;
}

/** How an acknowledgement reads in receipts: "accepted: on it" / "declined: busy". */
function ackNote(ack: AckValue | undefined, text: string): string | null {
  if (ack !== "accept" && ack !== "decline") return null;
  const note = text && text !== ack ? `: ${text.slice(0, 120)}` : "";
  return `${ack === "accept" ? "accepted" : "declined"}${note}`;
}
