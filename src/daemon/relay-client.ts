import { hostname } from "node:os";
import { WebSocket } from "ws";
import { NAME_RE } from "../core/addr.ts";
import {
  type DeviceKeys,
  deviceIdOf,
  fingerprint,
  open,
  publicPart,
  randomToken,
  seal,
  sha256,
  signJson,
  teamDecrypt,
  teamEncrypt,
  teamMac,
  teamMacOk,
  verifyJson,
} from "../core/crypto.ts";
import { AgentLinkError } from "../core/errors.ts";
import { LIMITS } from "../core/identity.ts";
import { ulid } from "../core/ids.ts";
import { safeField } from "../core/sanitize.ts";
import {
  authPayload,
  type MemberRecord,
  type Sealable,
  SealableSchema,
  type ServerFrame,
  ServerFrameSchema,
  type SignedMember,
} from "../relay/protocol.ts";
import type { DaemonContext } from "./context.ts";
import type { TeamState } from "./team.ts";

export interface RemoteMember {
  handle: string;
  deviceId: string;
  signPub: string;
  boxPub: string;
  deviceName?: string;
  fingerprint: string;
  online: boolean;
  self: boolean;
}

export interface RemoteAgent {
  member: string;
  deviceId: string;
  name: string;
  tool: string;
  state: string;
  repo?: string | null;
  branch?: string | null;
  status?: string | null;
  stateAt?: string;
  /** How messages reach it on its own machine, e.g. "wake,mid-turn". */
  reach?: string;
  /** Host name of the machine it runs on. */
  host?: string;
  /** Short session tag (a hash of host, tool and session id on its own machine). */
  sid?: string;
  /** Names it had before a rename (still accepted as addresses). */
  aliases?: string[];
  /** Claims for display and addressing: active model, session title, project (repo name). */
  model?: string | null;
  title?: string | null;
  project?: string | null;
  at: string;
}

/** Presence comes from another machine: keep only well-formed, bounded, printable fields. */
export function sanitizeRemoteAgent(
  raw: unknown,
  meta: { member: string; deviceId: string; at: string; host?: string | undefined },
): RemoteAgent | undefined {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (typeof a.name !== "string" || !NAME_RE.test(a.name)) return undefined;
  const reach = safeField(a.reach, 40);
  return {
    name: a.name,
    tool: safeField(a.tool, 32) ?? "unknown",
    state:
      typeof a.state === "string" && ["busy", "idle", "offline", "stale"].includes(a.state)
        ? a.state
        : "offline",
    repo: safeField(a.repo, 200),
    branch: safeField(a.branch, 100),
    status: safeField(a.status, 200),
    model: safeField(a.model, LIMITS.model),
    title: safeField(a.title, LIMITS.title),
    project: safeField(a.project, LIMITS.project),
    ...(typeof a.stateAt === "string" ? { stateAt: a.stateAt.slice(0, 40) } : {}),
    ...(reach ? { reach } : {}),
    ...(typeof a.sid === "string" && /^[a-z0-9]{1,8}$/.test(a.sid) ? { sid: a.sid } : {}),
    ...(Array.isArray(a.aliases)
      ? {
          aliases: (a.aliases as unknown[])
            .filter((x): x is string => typeof x === "string" && NAME_RE.test(x))
            .slice(0, 5),
        }
      : {}),
    member: meta.member,
    deviceId: meta.deviceId,
    at: meta.at,
    ...(meta.host ? { host: meta.host } : {}),
  };
}

export type Inbound =
  | { kind: "envelope"; envelope: unknown; from: RemoteMember }
  | {
      kind: "receipt";
      messageId: string;
      to: string;
      state: string;
      note?: string;
      from: RemoteMember;
    };

type Mode =
  | { kind: "hello" }
  | { kind: "create"; createToken?: string }
  | { kind: "join"; token: string };

const aad = (teamId: string, from: string, to: string) => `agentlink/v1|${teamId}|${from}|${to}`;
/** Sends awaiting the relay's answer at a time; outbox flushes go out in steps of this. */
const SEND_WINDOW = 100;
/** Unanswered sends are sent again after this (and the outbox is re-checked as often). */
const RESEND_MS = 30_000;
/** Receipts kept for devices off the team, and for how long. */
const WAITING_MAX = 1_000;
const WAITING_MS = 15 * 60_000;
/** Accepted frames remembered until answered (the relay reports drops by frame id), at most. */
const SENT_MAX = 50_000;
const SENT_MS = 8 * 24 * 3600_000;
/** Messages from devices missing from the roster, held at the relay for at most this long. */
const UNKNOWN_MAX = 1_000;
const UNKNOWN_SENDER_MS = 10 * 60_000;

/** Keeps one authenticated WebSocket to the team relay; seals, verifies and routes traffic. */
export class RelayClient {
  readonly #ctx: DaemonContext;
  readonly #team: TeamState;
  readonly #keys: DeviceKeys;
  readonly #members = new Map<string, RemoteMember>();
  readonly #presence = new Map<
    string,
    { handle: string; agents: RemoteAgent[]; at: string; host?: string }
  >();
  readonly #online = new Set<string>();
  readonly #waiters = new Map<string, (f: ServerFrame) => void>();
  #ws: WebSocket | undefined;
  #ready = false;
  #stopped = false;
  #backoff = 1_000;
  #mode: Mode;
  #onWelcome: ((error?: Error) => void) | undefined;
  /** Outbox rows sent on this connection and not answered yet (id → when). */
  readonly #pending = new Map<string, number>();
  /** After a rate refusal: nothing goes out before `#holdUntil`, then one frame at a time. */
  #rateBackoff = 0;
  #holdUntil = 0;
  #pumpTimer: NodeJS.Timeout | undefined;
  #tick: NodeJS.Timeout | undefined;
  #acks: string[] = [];
  /** Receipts refused because their device had left the team, oldest first. */
  #waiting: { id: string; frame: string; to: string; at: number }[] = [];
  #ackTimer: NodeJS.Timeout | undefined;
  /** Messages (relay id) from devices missing from the roster: sender and when first seen. */
  readonly #unknown = new Map<string, { from: string; at: number }>();
  #unknownTimer: NodeJS.Timeout | undefined;
  /** How long a message from a device missing from the roster may wait for it (tests). */
  unknownSenderMs = UNKNOWN_SENDER_MS;
  onInbound?: (msg: Inbound) => void;
  /** The relay accepted a frame carrying `messageId` for `handle`. */
  onSent?: (messageId: string, handle: string) => void;
  /** The relay refused (or dropped unread) a frame carrying `messageId` for `handle` for good. */
  onFailed?: (messageId: string, handle: string, note: string) => void;
  onRoster?: () => void;
  presenceSource?: () => Omit<RemoteAgent, "member" | "deviceId" | "at">[];

  constructor(
    ctx: DaemonContext,
    team: TeamState,
    keys: DeviceKeys,
    mode: Mode = { kind: "hello" },
  ) {
    this.#ctx = ctx;
    this.#team = team;
    this.#keys = keys;
    this.#mode = mode;
    for (const row of ctx.store.all<{
      device_id: string;
      handle: string;
      sign_pub: string;
      box_pub: string;
      device_name: string | null;
    }>("SELECT * FROM members")) {
      this.#members.set(row.device_id, {
        handle: row.handle,
        deviceId: row.device_id,
        signPub: row.sign_pub,
        boxPub: row.box_pub,
        ...(row.device_name ? { deviceName: row.device_name } : {}),
        fingerprint: fingerprint(row.sign_pub),
        online: false,
        self: row.device_id === keys.deviceId,
      });
    }
  }

  get team(): TeamState {
    return this.#team;
  }

  get connected(): boolean {
    return this.#ready;
  }

  get deviceId(): string {
    return this.#keys.deviceId;
  }

  members(): RemoteMember[] {
    return [...this.#members.values()].map((m) => ({
      ...m,
      online: m.self ? this.#ready : this.#online.has(m.deviceId),
    }));
  }

  /** Host name a device last reported, falling back to the name in its member record. */
  hostOf(deviceId: string): string | undefined {
    return this.#presence.get(deviceId)?.host ?? this.#members.get(deviceId)?.deviceName;
  }

  handles(): string[] {
    return [...new Set(this.members().map((m) => m.handle))];
  }

  remoteAgents(): RemoteAgent[] {
    const out: RemoteAgent[] = [];
    for (const [deviceId, p] of this.#presence) {
      if (deviceId === this.#keys.deviceId) continue;
      const online = this.#online.has(deviceId);
      for (const a of p.agents) out.push({ ...a, state: online ? a.state : "offline" });
    }
    return out;
  }

  /** Starts (and keeps) the connection. For create/join, resolves once the relay welcomed us. */
  start(): Promise<void> {
    this.#stopped = false;
    clearInterval(this.#tick);
    this.#tick = setInterval(() => this.#resendStale(), RESEND_MS);
    this.#tick.unref();
    return new Promise((resolve, reject) => {
      this.#onWelcome = (error) => (error ? reject(error) : resolve());
      this.#connect();
    });
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#tick);
    clearTimeout(this.#pumpTimer);
    clearTimeout(this.#unknownTimer);
    this.#unknownTimer = undefined;
    this.#flushAcks();
    this.#ws?.close();
  }

  #record(): SignedMember {
    const record: MemberRecord = {
      teamId: this.#team.teamId,
      handle: this.#team.handle,
      deviceId: this.#keys.deviceId,
      signPub: this.#keys.signPub,
      boxPub: this.#keys.boxPub,
      deviceName: hostname().slice(0, 64),
      joinedAt: this.#team.joinedAt,
    };
    return { record, mac: teamMac(this.#team.teamKey, record) };
  }

  #firstFrame(): Record<string, unknown> {
    const base = { teamId: this.#team.teamId, ts: Date.now(), nonce: randomToken(12) };
    let frame: Record<string, unknown>;
    if (this.#mode.kind === "hello") frame = { t: "hello", ...base, deviceId: this.#keys.deviceId };
    else if (this.#mode.kind === "create")
      frame = { t: "create", ...base, device: publicPart(this.#keys), member: this.#record() };
    else
      frame = {
        t: "join",
        ...base,
        token: this.#mode.token,
        device: publicPart(this.#keys),
        member: this.#record(),
      };
    const signed = { ...frame, sig: signJson(this.#keys, authPayload(frame as never)) };
    return this.#mode.kind === "create" && this.#mode.createToken
      ? { ...signed, createToken: this.#mode.createToken }
      : signed;
  }

  #connect(): void {
    if (this.#stopped) return;
    const ws = new WebSocket(this.#team.relay, {
      handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024,
    });
    this.#ws = ws;
    ws.on("open", () => ws.send(JSON.stringify(this.#firstFrame())));
    ws.on("message", (data) => {
      if (ws !== this.#ws) return; // a replaced socket
      try {
        const frame = ServerFrameSchema.safeParse(JSON.parse(String(data)));
        if (!frame.success) {
          this.#ctx.log.warn("ignoring a malformed relay frame", {
            error: frame.error.issues[0]?.message,
          });
          return;
        }
        this.#handle(frame.data);
      } catch (error) {
        this.#ctx.log.warn("relay frame failed", { error: String(error) });
      }
    });
    ws.on("close", (code) => {
      if (ws !== this.#ws) return; // a replaced socket
      const wasReady = this.#ready;
      this.#ready = false;
      this.#online.clear();
      this.#pending.clear();
      this.#acks = [];
      if (this.#stopped) return;
      if (wasReady) this.#ctx.log.info("relay disconnected");
      if (code === 4000) {
        // The relay keeps one connection per device: another daemon with this device key took over.
        this.#ctx.log.warn(
          "another agentlink daemon is using this device's relay connection; this one stops",
        );
        this.#stopped = true;
        return;
      }
      setTimeout(() => this.#connect(), this.#backoff).unref();
      this.#backoff = Math.min(this.#backoff * 2, 30_000);
    });
    ws.on("error", (error) => {
      if (ws !== this.#ws) return;
      this.#ctx.log.debug("relay connection error", { error: String(error) });
      if (this.#mode.kind !== "hello") {
        this.#onWelcome?.(new Error(`cannot reach relay ${this.#team.relay}: ${error.message}`));
        this.#onWelcome = undefined;
        this.#stopped = true;
      }
    });
  }

  #handle(frame: ServerFrame): void {
    switch (frame.t) {
      case "welcome":
        this.#ready = true;
        this.#backoff = 1_000;
        this.#mode = { kind: "hello" };
        for (const id of frame.online ?? []) this.#online.add(id);
        // Before the roster: what it queues (receipts for devices that are back) goes out once.
        this.#pending.clear();
        this.#rateBackoff = 0;
        this.#holdUntil = 0;
        this.#setRoster(frame.roster);
        this.#ctx.log.info("relay connected", {
          relay: this.#team.relay,
          team: this.#team.teamName,
        });
        this.#onWelcome?.();
        this.#onWelcome = undefined;
        this.#pump();
        this.publishPresence();
        return;
      case "roster":
        this.#setRoster(frame.roster);
        this.#pump(); // receipts waiting for a device that is back
        this.#replay(); // messages waiting for their sender to appear (a welcome resends them all)
        return;
      case "online":
        if (frame.online) this.#online.add(frame.deviceId);
        else this.#online.delete(frame.deviceId);
        this.onRoster?.();
        return;
      case "presence": {
        const member = this.#members.get(frame.deviceId);
        if (!member) return;
        try {
          const p = JSON.parse(
            teamDecrypt(this.#team.teamKey, frame.box, `presence|${frame.deviceId}`).toString(
              "utf8",
            ),
          ) as { agents?: unknown; host?: unknown };
          const host = safeField(p.host, 64) ?? undefined;
          const meta = { member: member.handle, deviceId: frame.deviceId, at: frame.at, host };
          this.#presence.set(frame.deviceId, {
            handle: member.handle,
            at: frame.at,
            ...(host ? { host } : {}),
            agents: (Array.isArray(p.agents) ? p.agents : [])
              .slice(0, 100)
              .map((a) => sanitizeRemoteAgent(a, meta))
              .filter((a): a is RemoteAgent => !!a),
          });
          this.onRoster?.();
        } catch {
          this.#ctx.log.warn("undecryptable presence", { deviceId: frame.deviceId });
        }
        return;
      }
      case "msg":
        this.#onMsg(frame);
        return;
      case "error":
        this.#ctx.log[frame.code === "rate" ? "debug" : "warn"]("relay error", {
          code: frame.code,
          message: frame.message,
        });
        if (frame.ref) this.#waiters.get(`ref:${frame.ref}`)?.(frame);
        if (this.#ready && (frame.code === "rate" || frame.ref)) this.#refused(frame);
        // Before the welcome, any refusal (bad invite, handle taken, …) ends a create/join.
        if (
          this.#onWelcome &&
          (!this.#ready || frame.code === "auth" || frame.code === "unknown_device")
        ) {
          this.#onWelcome(new Error(frame.message));
          this.#onWelcome = undefined;
          this.#stopped = true;
          this.#ws?.close();
        }
        return;
      case "ok":
        if (frame.ref) this.#waiters.get(`ref:${frame.ref}`)?.(frame);
        return;
      case "sent": {
        const row = this.#ctx.store.get<{ message_id: string | null; handle: string | null }>(
          "SELECT message_id, handle FROM outbox WHERE id = ?",
          frame.id,
        );
        this.#ctx.store.run("DELETE FROM outbox WHERE id = ?", frame.id);
        this.#pending.delete(frame.id);
        if (Date.now() >= this.#holdUntil) this.#rateBackoff = 0;
        if (row?.message_id && row.handle) {
          this.#ctx.store.run(
            "INSERT OR REPLACE INTO sent_frames (id, message_id, handle, at) VALUES (?, ?, ?, ?)",
            frame.id,
            row.message_id,
            row.handle,
            new Date().toISOString(),
          );
          this.onSent?.(row.message_id, row.handle);
        }
        this.#pump();
        return;
      }
      case "dropped": {
        // Applied reports are acked so the relay forgets them; the rest come back at the
        // next welcome (each is a no-op once its sent_frames row is gone).
        for (const id of frame.ids) {
          const row = this.#ctx.store.get<{ message_id: string; handle: string }>(
            "SELECT message_id, handle FROM sent_frames WHERE id = ?",
            id,
          );
          if (!row) continue;
          this.#ctx.store.run("DELETE FROM sent_frames WHERE id = ?", id);
          this.onFailed?.(
            row.message_id,
            row.handle,
            frame.reason === "removed"
              ? `not delivered: ${row.handle}'s device left the team before reading it`
              : `not delivered: ${row.handle}'s device did not collect it from the relay within 7 days`,
          );
        }
        if (this.#ws?.readyState === WebSocket.OPEN)
          this.#ws.send(JSON.stringify({ t: "dropped_ack", ids: frame.ids }));
        return;
      }
      default:
        return;
    }
  }

  #setRoster(roster: SignedMember[]): void {
    const seen = new Set<string>();
    for (const { record, mac } of roster) {
      if (
        record.teamId !== this.#team.teamId ||
        record.deviceId !== deviceIdOf(record.signPub) ||
        !teamMacOk(this.#team.teamKey, record, mac)
      ) {
        this.#ctx.log.warn("ignoring roster entry with a bad team MAC", {
          deviceId: record.deviceId,
        });
        continue;
      }
      const known = this.#members.get(record.deviceId);
      if (known && (known.signPub !== record.signPub || known.boxPub !== record.boxPub)) {
        this.#ctx.log.warn("refusing changed keys for a known device", {
          deviceId: record.deviceId,
        });
        continue;
      }
      seen.add(record.deviceId);
      if (!known) {
        this.#ctx.store.run(
          "INSERT OR IGNORE INTO members (device_id, handle, sign_pub, box_pub, device_name, first_seen) VALUES (?, ?, ?, ?, ?, ?)",
          record.deviceId,
          record.handle,
          record.signPub,
          record.boxPub,
          record.deviceName ?? null,
          new Date().toISOString(),
        );
      }
      this.#members.set(record.deviceId, {
        handle: record.handle,
        deviceId: record.deviceId,
        signPub: record.signPub,
        boxPub: record.boxPub,
        ...(record.deviceName ? { deviceName: record.deviceName } : {}),
        fingerprint: fingerprint(record.signPub),
        online: false,
        self: record.deviceId === this.#keys.deviceId,
      });
    }
    for (const id of [...this.#members.keys()]) {
      if (!seen.has(id)) {
        this.#members.delete(id);
        this.#presence.delete(id);
        this.#ctx.store.run("DELETE FROM members WHERE device_id = ?", id);
      }
    }
    this.#release();
    this.onRoster?.();
  }

  /** Queues waiting receipts for devices back in the team; drops those that stayed away. */
  #release(): void {
    if (this.#waiting.length === 0) return;
    const waiting = this.#waiting;
    this.#waiting = [];
    let gone = 0;
    for (const w of waiting) {
      if (this.#members.has(w.to)) {
        this.#ctx.store.run(
          "INSERT OR REPLACE INTO outbox (id, frame, created_at) VALUES (?, ?, ?)",
          w.id,
          w.frame,
          new Date().toISOString(),
        );
      } else if (Date.now() - w.at > WAITING_MS) gone++;
      else this.#waiting.push(w);
    }
    if (gone) this.#ctx.log.info("dropped receipts for devices that left the team", { gone });
  }

  /** Sends again the held messages whose sender the roster now lists. */
  #replay(): void {
    const ids = [...this.#unknown].filter(([, u]) => this.#members.has(u.from)).map(([id]) => id);
    for (let i = 0; i < ids.length && this.#ws?.readyState === WebSocket.OPEN; i += 500)
      this.#ws.send(JSON.stringify({ t: "replay", ids: ids.slice(i, i + 500) }));
  }

  /**
   * A message from a device missing from the roster stays at the relay (it can't be verified yet)
   * until the roster lists the device; one that is still unknown after `unknownSenderMs` is dropped.
   */
  #hold(frame: Extract<ServerFrame, { t: "msg" }>): void {
    if (!this.#unknown.has(frame.id)) {
      if (this.#unknown.size >= UNKNOWN_MAX) return; // waits for the next connection
      this.#unknown.set(frame.id, { from: frame.from, at: Date.now() });
    }
    this.#unknownTimer ??= setTimeout(() => this.#expireUnknown(), this.unknownSenderMs);
    this.#unknownTimer.unref();
  }

  #expireUnknown(): void {
    this.#unknownTimer = undefined;
    let next = Number.POSITIVE_INFINITY;
    let dropped = 0;
    for (const [id, u] of this.#unknown) {
      const wait = u.at + this.unknownSenderMs - Date.now();
      if (wait > 0 || !this.#ready) next = Math.min(next, wait > 0 ? wait : 1_000);
      else if (this.#members.has(u.from)) {
        this.#unknown.delete(id); // a replay went missing: the next connection brings it
      } else {
        this.#unknown.delete(id);
        this.#ack(id);
        dropped++;
      }
    }
    if (dropped)
      this.#ctx.log.warn("dropped messages from devices that never joined the team", { dropped });
    if (next < Number.POSITIVE_INFINITY) {
      this.#unknownTimer = setTimeout(() => this.#expireUnknown(), next);
      this.#unknownTimer.unref();
    }
  }

  #onMsg(frame: Extract<ServerFrame, { t: "msg" }>): void {
    const member = this.#members.get(frame.from);
    if (!member) {
      this.#hold(frame);
      return;
    }
    this.#unknown.delete(frame.id);
    let raw: Record<string, unknown>;
    let inner: Sealable;
    try {
      raw = JSON.parse(
        open(
          this.#keys,
          frame.blob,
          aad(this.#team.teamId, frame.from, this.#keys.deviceId),
        ).toString("utf8"),
      );
      inner = SealableSchema.parse(raw);
    } catch {
      this.#ctx.log.warn("dropping a message that failed to decrypt", { from: frame.from });
      this.#ack(frame.id);
      return;
    }
    // The signature covers the payload as sent (the parsed copy drops unknown fields).
    const { sig: _, ...signed } = raw;
    if (!verifyJson(member.signPub, signed, inner.sig)) {
      this.#ctx.log.warn("dropping a message with a bad signature", { from: member.handle });
      this.#ack(frame.id);
      return;
    }
    try {
      if (inner.kind === "envelope")
        this.onInbound?.({ kind: "envelope", envelope: inner.envelope, from: member });
      else {
        // Its device has our frame, so the relay can no longer drop it.
        this.#ctx.store.run(
          "DELETE FROM sent_frames WHERE message_id = ? AND handle = ?",
          inner.messageId,
          member.handle,
        );
        this.onInbound?.({
          kind: "receipt",
          messageId: inner.messageId,
          to: inner.to,
          state: inner.state,
          ...(inner.note ? { note: inner.note } : {}),
          from: member,
        });
      }
    } catch (error) {
      // A message we can never take is dropped; anything else stays at the relay for a retry.
      const lasting =
        error instanceof AgentLinkError || (error as Error | undefined)?.name === "ZodError";
      this.#ctx.log.warn("inbound handling failed", { error: String(error), dropped: lasting });
      if (!lasting) return;
    }
    this.#ack(frame.id);
  }

  /** Acks go out in batches (up to 500 ids a frame). */
  #ack(id: string): void {
    this.#acks.push(id);
    if (this.#acks.length >= 500) this.#flushAcks();
    else this.#ackTimer ??= setTimeout(() => this.#flushAcks(), 50);
  }

  #flushAcks(): void {
    clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
    const ids = this.#acks.splice(0, 500);
    if (ids.length && this.#ws?.readyState === WebSocket.OPEN)
      this.#ws.send(JSON.stringify({ t: "ack", ids }));
    if (this.#acks.length) this.#flushAcks();
  }

  #frame(
    frame: Record<string, unknown> & { id: string },
    meta?: { messageId: string; handle: string },
  ): void {
    this.#ctx.store.run(
      "INSERT OR REPLACE INTO outbox (id, frame, created_at, message_id, handle) VALUES (?, ?, ?, ?, ?)",
      frame.id,
      JSON.stringify(frame),
      new Date().toISOString(),
      meta?.messageId ?? null,
      meta?.handle ?? null,
    );
    this.#pump();
  }

  /**
   * Sends waiting outbox rows, oldest first, keeping at most SEND_WINDOW unanswered (one while
   * recovering from a rate refusal). Receipts and messages share the outbox and its pace.
   */
  #pump(): void {
    if (!this.#ready || this.#ws?.readyState !== WebSocket.OPEN) return;
    const wait = this.#holdUntil - Date.now();
    if (wait > 0) {
      clearTimeout(this.#pumpTimer);
      this.#pumpTimer = setTimeout(() => this.#pump(), wait);
      this.#pumpTimer.unref();
      return;
    }
    const room = (this.#rateBackoff ? 1 : SEND_WINDOW) - this.#pending.size;
    if (room <= 0) return;
    const rows = this.#ctx.store
      .all<{ id: string; frame: string }>(
        "SELECT id, frame FROM outbox ORDER BY created_at, id LIMIT ?",
        this.#pending.size + room,
      )
      .filter((r) => !this.#pending.has(r.id))
      .slice(0, room);
    for (const row of rows) {
      this.#pending.set(row.id, Date.now());
      this.#ws.send(row.frame);
    }
  }

  /** The relay refused a frame: a rate refusal is retried after a pause, anything else fails. */
  #refused(frame: Extract<ServerFrame, { t: "error" }>): void {
    const row = frame.ref
      ? this.#ctx.store.get<{ message_id: string | null; handle: string | null; frame: string }>(
          "SELECT message_id, handle, frame FROM outbox WHERE id = ?",
          frame.ref,
        )
      : undefined;
    if (frame.ref) this.#pending.delete(frame.ref);
    if (frame.code === "rate") {
      // One step per pause (a burst gets many refusals at once).
      if (Date.now() >= this.#holdUntil) {
        this.#rateBackoff = Math.min(Math.max(this.#rateBackoff * 2, 2_000), 60_000);
        this.#holdUntil = Date.now() + this.#rateBackoff;
      }
      this.#pump();
      return;
    }
    if (!row) return;
    this.#ctx.store.run("DELETE FROM outbox WHERE id = ?", frame.ref as string);
    // A receipt for a device that left the team waits for it to come back (e.g. re-joining).
    if (frame.code === "unknown_device" && !row.message_id) {
      const to = String((JSON.parse(row.frame) as { to?: unknown }).to);
      this.#waiting.push({ id: frame.ref as string, frame: row.frame, to, at: Date.now() });
      if (this.#waiting.length > WAITING_MAX) this.#waiting.shift();
    } else if (row.message_id && row.handle)
      this.onFailed?.(
        row.message_id,
        row.handle,
        `not sent: the relay refused it: ${frame.message}`,
      );
    this.#pump();
  }

  /** Sends again what the relay never answered (e.g. dropped as over its frame budget); prunes. */
  #resendStale(): void {
    for (const [id, at] of this.#pending)
      if (Date.now() - at >= RESEND_MS) this.#pending.delete(id);
    this.#pump();
    this.#ctx.store.run(
      "DELETE FROM sent_frames WHERE at < ?",
      new Date(Date.now() - SENT_MS).toISOString(),
    );
    this.#ctx.store.run(
      "DELETE FROM sent_frames WHERE id IN (SELECT id FROM sent_frames ORDER BY at DESC LIMIT -1 OFFSET ?)",
      SENT_MAX,
    );
  }

  /** Seals a signed payload to every device of `handle`; returns how many devices it went to. */
  sendTo(
    handle: string,
    payload:
      | Omit<Extract<Sealable, { kind: "envelope" }>, "sig">
      | Omit<Extract<Sealable, { kind: "receipt" }>, "sig">,
  ): number {
    const targets = this.members().filter((m) => m.handle === handle && !m.self);
    const sig = signJson(this.#keys, payload);
    const body = Buffer.from(JSON.stringify({ ...payload, sig }));
    const messageId =
      payload.kind === "envelope"
        ? String((payload.envelope as { messageId?: string }).messageId ?? "")
        : "";
    for (const m of targets) {
      const blob = seal(m.boxPub, body, aad(this.#team.teamId, this.#keys.deviceId, m.deviceId));
      this.#frame(
        { t: "send", id: ulid(), to: m.deviceId, blob },
        messageId ? { messageId, handle } : undefined,
      );
    }
    return targets.length;
  }

  #presenceTimer: NodeJS.Timeout | undefined;

  /** Shares this device's agent list with the team (encrypted with the team key). */
  publishPresence(): void {
    if (this.#presenceTimer) return;
    this.#presenceTimer = setTimeout(() => {
      this.#presenceTimer = undefined;
      if (!this.#ready || !this.presenceSource) return;
      const agents = this.presenceSource();
      const box = teamEncrypt(
        this.#team.teamKey,
        Buffer.from(JSON.stringify({ agents, host: hostname() })),
        `presence|${this.#keys.deviceId}`,
      );
      this.#ws?.send(JSON.stringify({ t: "presence", box }));
    }, 300);
    this.#presenceTimer.unref();
  }

  /** Sends a frame that the relay answers with ok/error carrying `ref`, and waits for that answer. */
  async #request(frame: Record<string, unknown>, refField: "id" | "ref"): Promise<void> {
    if (!this.#ready) throw new Error("not connected to the relay");
    const ref = randomToken(12);
    const done = new Promise<ServerFrame>((resolve) => {
      this.#waiters.set(`ref:${ref}`, resolve);
      setTimeout(
        () => resolve({ t: "error", code: "timeout", message: "relay did not answer" }),
        10_000,
      ).unref();
    });
    this.#ws?.send(JSON.stringify({ ...frame, [refField]: ref }));
    const res = await done;
    this.#waiters.delete(`ref:${ref}`);
    if (res.t === "error") throw new Error(res.message);
  }

  async invite(uses: number, ttlMs: number): Promise<string> {
    const token = randomToken(24);
    await this.#request(
      {
        t: "invite",
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        uses,
      },
      "id",
    );
    return token;
  }

  /** Stores a sealed invite under a short code's id on the relay (fetchable once). */
  async putCode(id: string, box: { nonce: string; ct: string }, expiresAt: string): Promise<void> {
    await this.#request({ t: "code_put", id, box, expiresAt }, "ref");
  }

  removeSelf(): void {
    if (this.#ws?.readyState === WebSocket.OPEN)
      this.#ws.send(JSON.stringify({ t: "remove", deviceId: this.#keys.deviceId }));
  }
}

/**
 * Says goodbye for a team this machine left while the relay was unreachable: connects with a
 * signed hello, sends `remove` for this device, and keeps retrying (backoff, and across daemon
 * restarts via the caller's record) until the relay says the device is gone — then `onDone`.
 */
export class LeaveClient {
  readonly #ctx: DaemonContext;
  readonly #leave: { relay: string; teamId: string; teamName?: string };
  readonly #keys: DeviceKeys;
  #ws: WebSocket | undefined;
  #stopped = false;
  #backoff = 1_000;
  /** The relay took the remove (or the device was already gone): the record can be deleted. */
  onDone?: () => void;
  /** Checked before sending remove (a re-join of this team makes the leave obsolete). */
  wanted?: () => boolean;

  constructor(
    ctx: DaemonContext,
    leave: { relay: string; teamId: string; teamName?: string },
    keys: DeviceKeys,
  ) {
    this.#ctx = ctx;
    this.#leave = leave;
    this.#keys = keys;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#ws?.close();
  }

  #connect(): void {
    if (this.#stopped) return;
    const ws = new WebSocket(this.#leave.relay, {
      handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024,
    });
    this.#ws = ws;
    ws.on("open", () => {
      const frame = {
        t: "hello",
        teamId: this.#leave.teamId,
        ts: Date.now(),
        nonce: randomToken(12),
        deviceId: this.#keys.deviceId,
      };
      ws.send(JSON.stringify({ ...frame, sig: signJson(this.#keys, authPayload(frame)) }));
    });
    ws.on("message", (data) => {
      if (ws !== this.#ws) return;
      let frame: ServerFrame;
      try {
        frame = ServerFrameSchema.parse(JSON.parse(String(data)));
      } catch {
        return;
      }
      if (frame.t === "welcome") {
        if (this.wanted && !this.wanted()) return this.#finish(); // re-joined meanwhile
        ws.send(JSON.stringify({ t: "remove", deviceId: this.#keys.deviceId }));
      } else if (frame.t === "ok" && frame.op === "remove") this.#finish();
      else if (frame.t === "error") frame.code === "unknown_device" ? this.#finish() : ws.close();
    });
    ws.on("close", (code) => {
      if (ws !== this.#ws || this.#stopped) return;
      if (code === 4001) return this.#finish(); // the relay removed this device
      setTimeout(() => this.#connect(), this.#backoff).unref();
      this.#backoff = Math.min(this.#backoff * 2, 30_000);
    });
    ws.on("error", () => undefined); // the close event follows
  }

  #finish(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#ctx.log.info("leave reached the relay", { team: this.#leave.teamName });
    this.#ws?.close();
    this.onDone?.();
  }
}

/** Redeems a short invite code: fetches the sealed invite once, without joining anything. */
export function fetchCode(relayUrl: string, id: string): Promise<{ nonce: string; ct: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl, { handshakeTimeout: 10_000, maxPayload: 1024 * 1024 });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`the relay ${relayUrl} did not answer`));
    }, 15_000);
    ws.on("open", () => ws.send(JSON.stringify({ t: "code_get", id })));
    ws.on("message", (data) => {
      clearTimeout(timer);
      ws.close();
      let frame: ServerFrame;
      try {
        frame = ServerFrameSchema.parse(JSON.parse(String(data)));
      } catch {
        reject(new Error("unexpected answer from the relay"));
        return;
      }
      if (frame.t === "code") resolve(frame.box);
      else
        reject(new Error(frame.t === "error" ? frame.message : "unexpected answer from the relay"));
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`cannot reach the relay ${relayUrl}: ${error.message}`));
    });
  });
}
