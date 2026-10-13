import { hostname } from "node:os";
import { slugify } from "../core/addr.ts";
import { defaultRelay } from "../core/config.ts";
import { fingerprint, newTeamKey, randomToken } from "../core/crypto.ts";
import { invalid } from "../core/errors.ts";
import {
  codeId,
  INVITE_CODE_RE,
  newInviteCode,
  normalizeCode,
  openInvite,
  sealInvite,
} from "../core/invite-code.ts";
import { safeField } from "../core/sanitize.ts";
import { decodeInvite, encodeInvite } from "../relay/protocol.ts";
import type { DaemonContext } from "./context.ts";
import type { DeliveryEngine } from "./delivery.ts";
import { type Mailbox, remoteHandleOf } from "./mailbox.ts";
import { isLive, type Registry } from "./registry.ts";
import { fetchCode, LeaveClient, RelayClient } from "./relay-client.ts";
import { clearTeam, deviceKeys, loadTeam, saveTeam, type TeamState } from "./team.ts";
import {
  type AgentRow,
  type Capabilities,
  type DeliveryRow,
  type MessageRow,
  parseJson,
} from "./types.ts";

const RECEIPT_STATES = new Set([
  "seen",
  "acked",
  "replied",
  "refused",
  "held",
  "expired",
  "failed",
]);
/** Receipts held while off the team (or for a teammate off the roster), and for how long. */
const HELD_MAX = 1_000;
const HELD_MS = 24 * 3600_000;
type Receipt = Parameters<NonNullable<Mailbox["remote"]>["receipt"]>[1];
/** A leave that still has to reach its relay: everything a signed hello needs. */
type PendingLeave = { relay: string; teamId: string; teamName?: string; handle?: string };
const RANK: Record<string, number> = {
  held: 2,
  delivered: 3,
  seen: 4,
  acked: 5,
  replied: 6,
  refused: 6,
  expired: 6,
  failed: 6,
};

/** Owns the team membership and the relay connection, and plugs them into the mailbox. */
export class TeamManager {
  readonly #ctx: DaemonContext;
  readonly #registry: Registry;
  readonly #mailbox: Mailbox;
  readonly #engine: DeliveryEngine;
  readonly #sentReceipts = new Map<number, string>();
  /** The team this machine last left (receipts wait for a re-join); survives restarts. */
  #left: string | undefined;
  #client: RelayClient | undefined;
  /** Retries for leaves that could not reach the relay yet, by team id. */
  readonly #leavers = new Map<string, LeaveClient>();
  #stopped = false;
  #heartbeat: NodeJS.Timeout | undefined;

  constructor(ctx: DaemonContext, registry: Registry, mailbox: Mailbox, engine: DeliveryEngine) {
    this.#ctx = ctx;
    this.#registry = registry;
    this.#mailbox = mailbox;
    this.#engine = engine;
    this.#left = ctx.store.getMeta("left_team");
    ctx.events.subscribe((event) => {
      if (event.type === "agent") this.#client?.publishPresence();
      if (event.type === "delivery") this.#maybeReceipt(Number(event.delivery.id));
    });
  }

  get client(): RelayClient | undefined {
    return this.#client;
  }

  /** Reconnects to the team saved on disk, if any, and resumes leaves that never reached it. */
  resume(): void {
    const team = loadTeam(this.#ctx.paths);
    if (team)
      void this.#attach(team, { kind: "hello" }).catch((e) =>
        this.#ctx.log.warn("relay attach failed", { error: String(e) }),
      );
    for (const row of this.#ctx.store.all<{ team_id: string; record: string }>(
      "SELECT team_id, record FROM pending_leaves",
    )) {
      if (row.team_id === team?.teamId) {
        this.#ctx.store.run("DELETE FROM pending_leaves WHERE team_id = ?", row.team_id);
        continue; // back on that team already
      }
      try {
        this.#startLeaver(JSON.parse(row.record) as PendingLeave);
      } catch {
        this.#ctx.store.run("DELETE FROM pending_leaves WHERE team_id = ?", row.team_id);
      }
    }
  }

  /** Starts (once) the retry that takes a leave to its relay; `onDone` deletes the record. */
  #startLeaver(leave: PendingLeave): void {
    if (this.#stopped || this.#leavers.has(leave.teamId)) return;
    if (!this.#ctx.store.get("SELECT 1 FROM pending_leaves WHERE team_id = ?", leave.teamId))
      return; // cancelled while it waited to start (e.g. a quick re-join)
    const leaver = new LeaveClient(this.#ctx, leave, deviceKeys(this.#ctx.paths));
    leaver.wanted = () =>
      !!this.#ctx.store.get("SELECT 1 FROM pending_leaves WHERE team_id = ?", leave.teamId);
    leaver.onDone = () => {
      this.#leavers.delete(leave.teamId);
      this.#ctx.store.run("DELETE FROM pending_leaves WHERE team_id = ?", leave.teamId);
    };
    this.#leavers.set(leave.teamId, leaver);
    leaver.start();
  }

  /** Records a leave that still has to reach the relay (the retry is started by the caller). */
  #leavePending(team: TeamState): PendingLeave {
    const leave: PendingLeave = {
      relay: team.relay,
      teamId: team.teamId,
      teamName: team.teamName,
      handle: team.handle,
    };
    this.#ctx.store.run(
      "INSERT OR REPLACE INTO pending_leaves (team_id, record, at) VALUES (?, ?, ?)",
      team.teamId,
      JSON.stringify(leave),
      new Date().toISOString(),
    );
    return leave;
  }

  /**
   * Stops a leave retry for `teamId` and deletes its record (the machine joined it again),
   * returning the record so a failed join can put it back.
   */
  #cancelLeave(teamId: string): PendingLeave | undefined {
    const leaver = this.#leavers.get(teamId);
    this.#leavers.delete(teamId);
    leaver?.stop();
    const row = this.#ctx.store.get<{ record: string }>(
      "SELECT record FROM pending_leaves WHERE team_id = ?",
      teamId,
    );
    this.#ctx.store.run("DELETE FROM pending_leaves WHERE team_id = ?", teamId);
    try {
      return row ? (JSON.parse(row.record) as PendingLeave) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Puts a leave back on record and resumes its retry (a re-join of that team failed). */
  #oweLeave(leave: PendingLeave): void {
    this.#ctx.store.run(
      "INSERT OR REPLACE INTO pending_leaves (team_id, record, at) VALUES (?, ?, ?)",
      leave.teamId,
      JSON.stringify(leave),
      new Date().toISOString(),
    );
    this.#startLeaver(leave);
  }

  async #attach(
    team: TeamState,
    mode: ConstructorParameters<typeof RelayClient>[3],
  ): Promise<void> {
    this.#client?.stop();
    const client = new RelayClient(this.#ctx, team, deviceKeys(this.#ctx.paths), mode);
    client.onInbound = (msg) => this.#inbound(msg);
    client.onSent = (messageId, handle) => this.#mailbox.markRelaySent(messageId, handle);
    client.onFailed = (messageId, handle, note) => this.#failed(messageId, handle, note);
    // Recently offline agents are listed too, so teammates can still queue mail for them.
    client.presenceSource = () =>
      this.#registry
        .list({ includeOffline: true })
        .filter((a) => isLive(a) || Date.now() - Date.parse(a.last_seen_at) < 7 * 24 * 3600_000)
        .slice(0, 100)
        .map((a) => ({
          name: a.name,
          tool: a.tool,
          state: a.state,
          // Never local paths: the remote URL (if any) and the project's name.
          repo: a.repo_remote,
          project: a.project,
          branch: a.branch,
          model: a.model,
          title: a.title,
          status: a.status_text,
          stateAt: a.state_at,
          reach: this.#reach(a),
          sid: this.#registry.tagOf(a),
          aliases: this.#registry.aliasesOf(a.id),
        }));
    this.#client = client;
    this.#mailbox.remote = {
      teamName: team.teamName,
      selfHandle: team.handle,
      online: (handle) => client.members().some((m) => m.handle === handle && m.online),
      agentOnline: (handle, agent) =>
        client.members().some((m) => m.handle === handle && m.online) &&
        client
          .remoteAgents()
          .some(
            (r) =>
              r.member === handle && r.name === agent && (r.state === "busy" || r.state === "idle"),
          ),
      infoOf: (handle, agent) =>
        client.remoteAgents().find((r) => r.member === handle && r.name === agent),
      agentInfos: (handle) => client.remoteAgents().filter((a) => a.member === handle),
      connected: () => client.connected,
      handles: () => client.handles().filter((h) => h !== team.handle),
      aliasesOf: (handle, agent) =>
        client.remoteAgents().find((a) => a.member === handle && (a.aliases ?? []).includes(agent))
          ?.name,
      agentsOf: (handle) =>
        client
          .remoteAgents()
          .filter((a) => a.member === handle)
          .map((a) => a.name),
      deliver: (handle, envelope) => client.sendTo(handle, { kind: "envelope", envelope }),
      receipt: (handle, r) => {
        if (client.sendTo(handle, { kind: "receipt", ...r }) === 0) this.#park(handle, r);
      },
    };
    client.onRoster = () => this.#unpark(client);
    clearInterval(this.#heartbeat);
    this.#heartbeat = setInterval(() => client.publishPresence(), 60_000);
    this.#heartbeat.unref();
    if (mode?.kind === "hello") {
      void client.start().catch(() => undefined);
      return;
    }
    try {
      await client.start();
    } catch (error) {
      // A refused create/join leaves no trace: agents keep their local addresses.
      client.stop();
      if (this.#client === client) {
        this.#client = undefined;
        this.#mailbox.remote = undefined;
        clearInterval(this.#heartbeat);
      }
      throw error;
    }
  }

  /**
   * Tells running agents about this machine's team change at their next hook (an `info` notice
   * never wakes anyone). Teammates' agents are listed once their presence arrives (≤1.5s).
   */
  #announce(change: "created" | "joined" | "left" | "relay", team: TeamState): void {
    this.#notice(change, team).catch((error) =>
      this.#ctx.log.warn("team notice failed", { error: String(error) }),
    );
  }

  async #notice(change: "created" | "joined" | "left" | "relay", team: TeamState) {
    const client = this.#client;
    // Agents that start later learn their address at session start.
    const ids = this.#registry
      .list()
      .filter(isLive)
      .map((a) => a.id);
    if (ids.length === 0) return;
    if (change === "joined" && client) {
      const deadline = Date.now() + 1_500;
      const others = () => client.members().filter((m) => !m.self);
      while (
        others().some((m) => m.online) &&
        client.remoteAgents().length === 0 &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 50));
      if (this.#client !== client) return;
    }
    const name = (s: unknown) => safeField(s, 64) ?? "?";
    const teamName = name(team.teamName);
    const remote = (client?.remoteAgents() ?? []).map((a) => `${name(a.member)}/${name(a.name)}`);
    const mates = [
      ...new Set((client?.members() ?? []).filter((m) => !m.self).map((m) => m.handle)),
    ];
    const teammates = remote.length
      ? ` Teammates' agents: ${remote.slice(0, 6).join(", ")}${remote.length > 6 ? ", …" : ""} (all: agentlink peers).`
      : mates.length
        ? ` Teammates: ${mates
            .slice(0, 6)
            .map((h) => `@${name(h)}`)
            .join(", ")} (their agents: agentlink peers).`
        : "";
    for (const agent of ids.map((id) => this.#registry.byId(id)).filter((a) => !!a)) {
      const me = `${team.handle}/${agent.name}`;
      const text =
        change === "left"
          ? `agentlink: this machine left team ${teamName}; agents on other machines can no longer reach you (you are still ${agent.name} here).`
          : change === "relay"
            ? `agentlink: this machine now reaches team ${teamName} through ${safeField(team.relay, 200)}; you are still ${me}.`
            : `agentlink: this machine ${change} team ${teamName} as @${team.handle}; agents on other machines ${change === "joined" ? "now reach" : "will reach"} you as ${me}.${teammates} No restart needed.`;
      this.#mailbox.notify(agent, text);
    }
  }

  #inbound(msg: Parameters<NonNullable<RelayClient["onInbound"]>>[0]): void {
    if (msg.kind === "receipt") {
      this.#mailbox.applyReceipt(msg.from.handle, msg);
      return;
    }
    const { queued, receipts, messageId } = this.#mailbox.receiveRemote(
      msg.envelope,
      msg.from.handle,
    );
    const notes = this.#engine.onQueued(queued);
    if (!messageId) return;
    const me = this.#client?.team.handle ?? this.#ctx.config.handle;
    for (const { deliveryId, ...r } of receipts) {
      // "delivered" only if the agent is running here; otherwise it waits in our queue.
      const d = deliveryId
        ? this.#ctx.store.get<DeliveryRow>("SELECT * FROM deliveries WHERE id = ?", deliveryId)
        : undefined;
      const agent = d?.to_agent_id ? this.#registry.byId(d.to_agent_id) : undefined;
      const receipt =
        r.state === "delivered" && agent && !isLive(agent)
          ? {
              ...r,
              state: "sent",
              note: `on ${me}'s machine; ${agent.name} is offline, queued there`,
            }
          : r.state === "delivered" && deliveryId && notes.get(deliveryId)
            ? { ...r, note: notes.get(deliveryId) as string }
            : r;
      this.#mailbox.remote?.receipt(msg.from.handle, { messageId, ...receipt });
    }
  }

  /** Our copy for `handle` will never reach its machine: its deliveries fail, authors are told. */
  #failed(messageId: string, handle: string, note: string): void {
    for (const d of this.#ctx.store.all<{ to_addr: string }>(
      "SELECT to_addr FROM deliveries WHERE message_id = ? AND to_agent_id IS NULL AND (to_addr = ? OR to_addr LIKE ?) AND state IN ('queued', 'sent')",
      messageId,
      `@${handle}`,
      `${handle}/%`,
    ))
      this.#mailbox.applyReceipt(
        handle,
        { messageId, to: d.to_addr, state: "failed", note },
        { local: true },
      );
  }

  #reach(a: AgentRow): string {
    const caps = parseJson<Capabilities>(a.capabilities, {});
    const bits: string[] = [];
    const via = this.#engine.delivererFor(a);
    if (caps.push || via?.pushAlways) bits.push("push");
    else if (via || caps.wake) bits.push("wake");
    if (caps.midTurn) bits.push("mid-turn");
    else if (caps.nextTurn) bits.push("next-turn");
    return bits.join(",") || "cli";
  }

  /** Tells a teammate how its message is doing here (seen, replied, …). */
  #maybeReceipt(deliveryId: number): void {
    if ((!this.#client && !this.#left) || !Number.isFinite(deliveryId)) return;
    const d = this.#ctx.store.get<
      DeliveryRow & { m_trust: string; m_from: string; m_envelope: string }
    >(
      "SELECT d.*, m.trust AS m_trust, m.from_addr AS m_from, m.envelope AS m_envelope FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.id = ?",
      deliveryId,
    );
    if (d?.m_trust !== "teammate") return;
    if (!this.#client) {
      // This machine is off the team (e.g. re-joining): reported once it is back. The hold
      // is on disk, so a restart loses neither the receipt nor which team it is for.
      if (this.#left) this.#hold(deliveryId);
      return;
    }
    // A message released from hold (approved) is reported as delivered.
    const state = d.state === "queued" && d.decided_by ? "delivered" : d.state;
    const last = this.#sentReceipts.get(deliveryId);
    if (state === "delivered" ? last !== "held" : !RECEIPT_STATES.has(state)) return;
    if (last && (RANK[last] ?? 0) >= (RANK[state] ?? 0)) return;
    const handle = remoteHandleOf(d.m_from);
    if (!handle) return;
    // Most recently reported last; the oldest is forgotten beyond 5000 (at worst a repeat receipt).
    this.#sentReceipts.delete(deliveryId);
    this.#sentReceipts.set(deliveryId, state);
    if (this.#sentReceipts.size > 5_000)
      this.#sentReceipts.delete(this.#sentReceipts.keys().next().value as number);
    const me = this.#client.team.handle;
    const to = d.to_addr.startsWith("@") ? `@${me}` : `${me}/${this.#addressedAs(d, me)}`;
    this.#mailbox.remote?.receipt(handle, {
      messageId: d.message_id,
      to,
      state,
      ...(state === "delivered" ? { note: `approved by ${me}` } : {}),
    });
  }

  /** Holds `deliveryId`'s receipt for a re-join of the team this machine left. */
  #hold(deliveryId: number): void {
    this.#pruneHeld();
    this.#ctx.store.run(
      "INSERT OR REPLACE INTO held_receipts (delivery_id, team_id, at) VALUES (?, ?, ?)",
      deliveryId,
      this.#left as string,
      new Date().toISOString(),
    );
  }

  /** A receipt for a teammate missing from the roster is held on disk until it is back. */
  #park(handle: string, r: Receipt): void {
    const teamId = this.#client?.team.teamId ?? this.#left;
    if (!teamId) return;
    this.#pruneHeld();
    this.#ctx.store.run(
      "INSERT INTO held_receipts (team_id, handle, receipt, at) VALUES (?, ?, ?, ?)",
      teamId,
      handle,
      JSON.stringify(r),
      new Date().toISOString(),
    );
  }

  #pruneHeld(): void {
    this.#ctx.store.run(
      "DELETE FROM held_receipts WHERE at < ?",
      new Date(Date.now() - HELD_MS).toISOString(),
    );
    this.#ctx.store.run(
      `DELETE FROM held_receipts WHERE id IN
         (SELECT id FROM held_receipts ORDER BY id DESC LIMIT -1 OFFSET ?)`,
      HELD_MAX,
    );
  }

  #unpark(client: RelayClient): void {
    if (client !== this.#client) return;
    const teamId = client.team.teamId;
    for (const row of this.#ctx.store.all<{ id: number; delivery_id: number }>(
      "SELECT id, delivery_id FROM held_receipts WHERE team_id = ? AND delivery_id IS NOT NULL",
      teamId,
    )) {
      this.#ctx.store.run("DELETE FROM held_receipts WHERE id = ?", row.id);
      this.#maybeReceipt(row.delivery_id);
    }
    const here = new Set(client.handles());
    let expired = 0;
    for (const row of this.#ctx.store.all<{
      id: number;
      handle: string;
      receipt: string;
      at: string;
    }>(
      "SELECT id, handle, receipt, at FROM held_receipts WHERE team_id = ? AND handle IS NOT NULL ORDER BY id",
      teamId,
    )) {
      const stale = Date.now() - Date.parse(row.at) > HELD_MS;
      if (stale) expired++;
      if (
        stale ||
        (here.has(row.handle) &&
          client.sendTo(row.handle, {
            kind: "receipt",
            ...(JSON.parse(row.receipt) as Receipt),
          }) > 0)
      )
        this.#ctx.store.run("DELETE FROM held_receipts WHERE id = ?", row.id);
    }
    if (expired)
      this.#ctx.log.info("dropped receipts for teammates that did not come back", { expired });
    if (teamId === this.#left) {
      // Back on the team these receipts waited for: nothing is owed to it anymore.
      this.#left = undefined;
      this.#ctx.store.setMeta("left_team", undefined);
    }
  }

  /** The name the sender used for this delivery's agent (filed under its new name if renamed). */
  #addressedAs(d: DeliveryRow & { m_envelope: string }, me: string): string {
    const to = parseJson<{ to?: { member?: string; agent?: string }[] }>(d.m_envelope, {}).to;
    const names = (Array.isArray(to) ? to : []).flatMap((a) =>
      a?.member === me && typeof a.agent === "string" ? [a.agent] : [],
    );
    return (
      names.find((n) => n === d.to_addr) ??
      names.find((n) => this.#registry.resolveName(n)?.agent.id === d.to_agent_id) ??
      (names.length === 1 ? names[0] : undefined) ??
      d.to_addr
    );
  }

  status(): Record<string, unknown> {
    const team = loadTeam(this.#ctx.paths);
    if (!team) return { team: null };
    const client = this.#client;
    const keys = deviceKeys(this.#ctx.paths);
    return {
      team: {
        name: team.teamName,
        id: team.teamId,
        relay: team.relay,
        handle: team.handle,
        admin: team.admin,
        connected: client?.connected ?? false,
        device: { id: keys.deviceId, fingerprint: fingerprint(keys.signPub) },
      },
      members: (client?.members() ?? []).map((m) => ({
        ...m,
        host: m.self ? hostname() : (client?.hostOf(m.deviceId) ?? m.deviceName ?? null),
      })),
      agents: client?.remoteAgents() ?? [],
    };
  }

  async create(
    name: string,
    relay: string | undefined,
    handle?: string,
    createToken?: string,
  ): Promise<Record<string, unknown>> {
    alreadyInTeam(loadTeam(this.#ctx.paths));
    const team: TeamState = {
      relay: normalizeRelay(relay ?? defaultRelay(this.#ctx.config)),
      teamId: `${slugify(name, 24)}-${randomToken(6)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")}`.slice(0, 48),
      teamName: slugify(name, 32),
      teamKey: newTeamKey(),
      handle: slugify(handle ?? this.#ctx.config.handle, 32),
      admin: true,
      joinedAt: new Date().toISOString(),
    };
    this.#leftovers(team.teamId);
    // Creating that team again makes a pending leave obsolete; if the create fails it is owed.
    const owed = this.#cancelLeave(team.teamId);
    try {
      await this.#attach(team, { kind: "create", ...(createToken ? { createToken } : {}) });
    } catch (error) {
      if (owed) this.#oweLeave(owed);
      throw error;
    }
    saveTeam(this.#ctx.paths, team);
    this.#announce("created", team);
    return this.status();
  }

  /**
   * A long invite (al1…, self-contained) and, unless disabled, a short code for the same invite
   * that the relay hands out once (sealed under a key derived from the code).
   */
  async invite(
    uses: number,
    ttlMs: number,
    opts: { code?: boolean; codeTtlMs?: number } = {},
  ): Promise<{
    invite: string;
    code?: string;
    codeExpiresAt?: string;
    relay: string;
    communityRelay: boolean;
  }> {
    // Inviting someone is how you start: without a team, one is created on the default relay.
    if (!loadTeam(this.#ctx.paths))
      await this.create(`${slugify(this.#ctx.config.handle, 20)}-team`, undefined);
    const team = loadTeam(this.#ctx.paths);
    if (!team || !this.#client) throw invalid("not connected to a team relay");
    if (!team.admin) throw invalid("only the team admin can create invites");
    const token = await this.#client.invite(uses, ttlMs);
    const keys = deviceKeys(this.#ctx.paths);
    const invite = encodeInvite({
      v: 1,
      relay: team.relay,
      teamId: team.teamId,
      teamName: team.teamName,
      token,
      teamKey: team.teamKey,
      by: { handle: team.handle, fingerprint: fingerprint(keys.signPub) },
    });
    const base = {
      invite,
      relay: team.relay,
      communityRelay: team.relay === defaultRelay(this.#ctx.config),
    };
    if (opts.code === false) return base;
    const code = newInviteCode();
    const codeExpiresAt = new Date(
      Date.now() + Math.min(opts.codeTtlMs ?? 15 * 60_000, ttlMs),
    ).toISOString();
    await this.#client.putCode(codeId(code), sealInvite(code, invite), codeExpiresAt);
    return { ...base, code, codeExpiresAt };
  }

  /** `relay` overrides the invite's address (same relay, reached differently, e.g. via a tunnel). */
  async join(
    inviteText: string,
    handle?: string,
    relay?: string,
  ): Promise<Record<string, unknown>> {
    alreadyInTeam(loadTeam(this.#ctx.paths));
    // A short code is redeemed at the relay (once) for the full invite.
    if (INVITE_CODE_RE.test(normalizeCode(inviteText))) {
      const code = normalizeCode(inviteText);
      const at = normalizeRelay(relay ?? defaultRelay(this.#ctx.config));
      const box = await fetchCode(at, codeId(code)).catch((error: Error) => {
        throw invalid(
          `${error.message}${relay ? "" : ` (if the team uses another relay: --relay <url>)`}`,
        );
      });
      inviteText = openInvite(code, box);
      relay = at;
    }
    let invite: ReturnType<typeof decodeInvite>;
    try {
      invite = decodeInvite(inviteText);
    } catch {
      throw invalid("that invite is incomplete or damaged; copy the whole al1.… string again");
    }
    // Handles must be unique per device; joining your own team from a second machine gets
    // "<you>-<hostname>" unless you pick a name.
    const base = slugify(this.#ctx.config.handle, 24);
    const fallback = base === invite.by.handle ? `${base}-${slugify(hostname(), 16)}` : base;
    const team: TeamState = {
      relay: relay ? normalizeRelay(relay) : invite.relay,
      teamId: invite.teamId,
      teamName: invite.teamName,
      teamKey: invite.teamKey,
      handle: slugify(handle ?? fallback, 40),
      admin: false,
      joinedAt: new Date().toISOString(),
    };
    this.#leftovers(team.teamId);
    // Rejoining makes a pending remove for this team obsolete; the record goes first so a
    // retry already in flight sees it gone. If the join is refused, the leave is still owed.
    const owed = this.#cancelLeave(team.teamId);
    try {
      await this.#attach(team, { kind: "join", token: invite.token });
    } catch (error) {
      if (owed) this.#oweLeave(owed);
      throw error;
    }
    saveTeam(this.#ctx.paths, team);
    this.#announce("joined", team);
    return { ...this.status(), invitedBy: invite.by };
  }

  /** Points this device at another address for the team's relay (e.g. after moving it). */
  async setRelay(url: string): Promise<Record<string, unknown>> {
    const team = loadTeam(this.#ctx.paths);
    if (!team) throw invalid("not in a team");
    const next = { ...team, relay: normalizeRelay(url) };
    saveTeam(this.#ctx.paths, next);
    await this.#attach(next, { kind: "hello" });
    const deadline = Date.now() + 8_000;
    while (!this.#client?.connected && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    this.#announce("relay", next);
    return this.status();
  }

  leave(): void {
    const team = loadTeam(this.#ctx.paths);
    // Stop this client even if a new one is attached before the timer fires.
    const old = this.#client;
    old?.removeSelf();
    // The leave may not have reached the relay (outage, backoff): a retry takes it there as
    // soon as the relay is reachable, even after a restart. It starts once the old client is
    // down, so the relay does not take its hello for a reconnect and replace the old socket.
    const pending = team ? this.#leavePending(team) : undefined;
    setTimeout(() => {
      old?.stop();
      try {
        if (pending) this.#startLeaver(pending);
      } catch {
        // daemon is closing: the retry resumes at its next start
      }
    }, 300).unref();
    this.#client = undefined;
    this.#mailbox.remote = undefined;
    // Receipts wait (in the outbox and held) in case this machine re-joins the same team.
    if (team) {
      this.#left = team.teamId;
      this.#ctx.store.setMeta("left_team", team.teamId);
    }
    clearInterval(this.#heartbeat);
    clearTeam(this.#ctx.paths);
    this.#ctx.store.run("DELETE FROM members");
    const unsent = this.#ctx.store.all<{ message_id: string; handle: string }>(
      "SELECT DISTINCT message_id, handle FROM outbox WHERE message_id IS NOT NULL AND handle IS NOT NULL",
    );
    this.#ctx.store.run("DELETE FROM outbox WHERE message_id IS NOT NULL");
    const note = `not sent: this machine left team ${safeField(team?.teamName, 64) ?? "?"}`;
    for (const r of unsent) this.#failed(r.message_id, r.handle, note);
    if (team) this.#announce("left", team);
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#heartbeat);
    this.#client?.stop();
    for (const leaver of this.#leavers.values()) leaver.stop();
  }

  /** Receipts left from a team this machine left are dropped unless it re-joins that team. */
  #leftovers(teamId: string): void {
    if (teamId === this.#left) return;
    this.#ctx.store.run("DELETE FROM outbox");
    this.#ctx.store.run("DELETE FROM sent_frames");
    this.#ctx.store.run("DELETE FROM held_receipts");
    this.#left = undefined;
    this.#ctx.store.setMeta("left_team", undefined);
  }

  /** Messages from teammates carry this device's identity in their receipts. */
  originOf(message: MessageRow): string | undefined {
    return message.trust === "teammate" ? remoteHandleOf(message.from_addr) : undefined;
  }
}

/** Leaving is for people only, so an agent is told to ask for it. */
function alreadyInTeam(team: TeamState | undefined): void {
  if (team)
    throw invalid(
      `this machine is already in team ${safeField(team.teamName, 64)}; to switch, ask your user to run \`agentlink team leave\` in a terminal (agents cannot), then try again`,
    );
}

function normalizeRelay(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (/^wss?:\/\//.test(u)) return u;
  if (/^https?:\/\//.test(u)) return u.replace(/^http/, "ws");
  return `ws://${u}`;
}
