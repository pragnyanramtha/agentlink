import { hostname } from "node:os";
import { slugify } from "../core/addr.ts";
import { fingerprint, newTeamKey, randomToken } from "../core/crypto.ts";
import { invalid } from "../core/errors.ts";
import { decodeInvite, encodeInvite } from "../relay/protocol.ts";
import type { DaemonContext } from "./context.ts";
import type { DeliveryEngine } from "./delivery.ts";
import { type Mailbox, remoteHandleOf } from "./mailbox.ts";
import { isLive, type Registry } from "./registry.ts";
import { RelayClient } from "./relay-client.ts";
import { clearTeam, deviceKeys, loadTeam, saveTeam, type TeamState } from "./team.ts";
import type { DeliveryRow, MessageRow } from "./types.ts";

const RECEIPT_STATES = new Set([
  "seen",
  "acked",
  "replied",
  "refused",
  "held",
  "expired",
  "failed",
]);
const RANK: Record<string, number> = {
  delivered: 2,
  held: 2,
  seen: 3,
  acked: 4,
  replied: 5,
  refused: 5,
  expired: 5,
  failed: 5,
};

/** Owns the team membership and the relay connection, and plugs them into the mailbox. */
export class TeamManager {
  readonly #ctx: DaemonContext;
  readonly #registry: Registry;
  readonly #mailbox: Mailbox;
  readonly #engine: DeliveryEngine;
  readonly #sentReceipts = new Map<number, string>();
  #client: RelayClient | undefined;
  #heartbeat: NodeJS.Timeout | undefined;

  constructor(ctx: DaemonContext, registry: Registry, mailbox: Mailbox, engine: DeliveryEngine) {
    this.#ctx = ctx;
    this.#registry = registry;
    this.#mailbox = mailbox;
    this.#engine = engine;
    ctx.events.subscribe((event) => {
      if (event.type === "agent") this.#client?.publishPresence();
      if (event.type === "delivery") this.#maybeReceipt(Number(event.delivery.id));
    });
  }

  get client(): RelayClient | undefined {
    return this.#client;
  }

  /** Reconnects to the team saved on disk, if any. */
  resume(): void {
    const team = loadTeam(this.#ctx.paths);
    if (team)
      void this.#attach(team, { kind: "hello" }).catch((e) =>
        this.#ctx.log.warn("relay attach failed", { error: String(e) }),
      );
  }

  async #attach(
    team: TeamState,
    mode: ConstructorParameters<typeof RelayClient>[3],
  ): Promise<void> {
    this.#client?.stop();
    const client = new RelayClient(this.#ctx, team, deviceKeys(this.#ctx.paths), mode);
    client.onInbound = (msg) => this.#inbound(msg);
    client.presenceSource = () =>
      this.#registry
        .list()
        .filter(isLive)
        .map((a) => ({
          name: a.name,
          tool: a.tool,
          state: a.state,
          repo: a.repo_remote ?? a.repo_root,
          branch: a.branch,
          status: a.status_text,
          stateAt: a.state_at,
        }));
    this.#client = client;
    this.#mailbox.remote = {
      teamName: team.teamName,
      connected: () => client.connected,
      handles: () => client.handles().filter((h) => h !== team.handle),
      agentsOf: (handle) =>
        client
          .remoteAgents()
          .filter((a) => a.member === handle)
          .map((a) => a.name),
      deliver: (handle, envelope) => client.sendTo(handle, { kind: "envelope", envelope }),
      receipt: (handle, r) => void client.sendTo(handle, { kind: "receipt", ...r }),
    };
    clearInterval(this.#heartbeat);
    this.#heartbeat = setInterval(() => client.publishPresence(), 60_000);
    this.#heartbeat.unref();
    if (mode?.kind === "hello") {
      void client.start().catch(() => undefined);
      return;
    }
    await client.start();
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
    this.#engine.onQueued(queued);
    if (messageId) {
      for (const r of receipts) this.#mailbox.remote?.receipt(msg.from.handle, { messageId, ...r });
    }
  }

  /** Tells a teammate how its message is doing here (seen, replied, …). */
  #maybeReceipt(deliveryId: number): void {
    if (!this.#client || !Number.isFinite(deliveryId)) return;
    const d = this.#ctx.store.get<DeliveryRow & { m_trust: string; m_from: string }>(
      "SELECT d.*, m.trust AS m_trust, m.from_addr AS m_from FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.id = ?",
      deliveryId,
    );
    if (!d || d.m_trust !== "teammate" || !RECEIPT_STATES.has(d.state)) return;
    const last = this.#sentReceipts.get(deliveryId);
    if (last && (RANK[last] ?? 0) >= (RANK[d.state] ?? 0)) return;
    const handle = remoteHandleOf(d.m_from);
    if (!handle) return;
    this.#sentReceipts.set(deliveryId, d.state);
    const me = this.#client.team.handle;
    const to = d.to_addr.startsWith("@") ? `@${me}` : `${me}/${d.to_addr}`;
    this.#mailbox.remote?.receipt(handle, { messageId: d.message_id, to, state: d.state });
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
      members: client?.members() ?? [],
      agents: client?.remoteAgents() ?? [],
    };
  }

  async create(name: string, relay: string, handle?: string): Promise<Record<string, unknown>> {
    if (loadTeam(this.#ctx.paths)) throw invalid("already in a team (agentlink team leave first)");
    const team: TeamState = {
      relay: normalizeRelay(relay),
      teamId: `${slugify(name, 24)}-${randomToken(6)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")}`.slice(0, 48),
      teamName: slugify(name, 32),
      teamKey: newTeamKey(),
      handle: slugify(handle ?? this.#ctx.config.handle, 32),
      admin: true,
      joinedAt: new Date().toISOString(),
    };
    await this.#attach(team, { kind: "create" });
    saveTeam(this.#ctx.paths, team);
    return this.status();
  }

  async invite(uses: number, ttlMs: number): Promise<string> {
    const team = loadTeam(this.#ctx.paths);
    if (!team || !this.#client)
      throw invalid("not in a team (agentlink team create <name> --relay <url>)");
    if (!team.admin) throw invalid("only the team admin can create invites");
    const token = await this.#client.invite(uses, ttlMs);
    const keys = deviceKeys(this.#ctx.paths);
    return encodeInvite({
      v: 1,
      relay: team.relay,
      teamId: team.teamId,
      teamName: team.teamName,
      token,
      teamKey: team.teamKey,
      by: { handle: team.handle, fingerprint: fingerprint(keys.signPub) },
    });
  }

  async join(inviteText: string, handle?: string): Promise<Record<string, unknown>> {
    if (loadTeam(this.#ctx.paths)) throw invalid("already in a team (agentlink team leave first)");
    const invite = decodeInvite(inviteText);
    // Handles must be unique per device; joining your own team from a second machine gets
    // "<you>-<hostname>" unless you pick a name.
    const base = slugify(this.#ctx.config.handle, 24);
    const fallback = base === invite.by.handle ? `${base}-${slugify(hostname(), 16)}` : base;
    const team: TeamState = {
      relay: invite.relay,
      teamId: invite.teamId,
      teamName: invite.teamName,
      teamKey: invite.teamKey,
      handle: slugify(handle ?? fallback, 40),
      admin: false,
      joinedAt: new Date().toISOString(),
    };
    await this.#attach(team, { kind: "join", token: invite.token });
    saveTeam(this.#ctx.paths, team);
    return { ...this.status(), invitedBy: invite.by };
  }

  leave(): void {
    this.#client?.removeSelf();
    setTimeout(() => this.#client?.stop(), 300).unref();
    this.#client = undefined;
    this.#mailbox.remote = undefined;
    clearInterval(this.#heartbeat);
    clearTeam(this.#ctx.paths);
    this.#ctx.store.run("DELETE FROM members");
    this.#ctx.store.run("DELETE FROM outbox");
  }

  stop(): void {
    clearInterval(this.#heartbeat);
    this.#client?.stop();
  }

  /** Messages from teammates carry this device's identity in their receipts. */
  originOf(message: MessageRow): string | undefined {
    return message.trust === "teammate" ? remoteHandleOf(message.from_addr) : undefined;
  }
}

function normalizeRelay(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (/^wss?:\/\//.test(u)) return u;
  if (/^https?:\/\//.test(u)) return u.replace(/^http/, "ws");
  return `ws://${u}`;
}
