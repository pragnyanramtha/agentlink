import { WebSocket } from "ws";
import {
  type DeviceKeys,
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
import { ulid } from "../core/ids.ts";
import {
  authPayload,
  type MemberRecord,
  type Sealable,
  type ServerFrame,
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
  at: string;
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

type Mode = { kind: "hello" } | { kind: "create" } | { kind: "join"; token: string };

const aad = (teamId: string, from: string, to: string) => `agentlink/v1|${teamId}|${from}|${to}`;

/** Keeps one authenticated WebSocket to the team relay; seals, verifies and routes traffic. */
export class RelayClient {
  readonly #ctx: DaemonContext;
  readonly #team: TeamState;
  readonly #keys: DeviceKeys;
  readonly #members = new Map<string, RemoteMember>();
  readonly #presence = new Map<string, { handle: string; agents: RemoteAgent[]; at: string }>();
  readonly #online = new Set<string>();
  readonly #waiters = new Map<string, (f: ServerFrame) => void>();
  #ws: WebSocket | undefined;
  #ready = false;
  #stopped = false;
  #backoff = 1_000;
  #mode: Mode;
  #onWelcome: ((error?: Error) => void) | undefined;
  onInbound?: (msg: Inbound) => void;
  /** The relay accepted a frame carrying `messageId` for `handle`. */
  onSent?: (messageId: string, handle: string) => void;
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
    return new Promise((resolve, reject) => {
      this.#onWelcome = (error) => (error ? reject(error) : resolve());
      this.#connect();
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#ws?.close();
  }

  #record(): SignedMember {
    const record: MemberRecord = {
      teamId: this.#team.teamId,
      handle: this.#team.handle,
      deviceId: this.#keys.deviceId,
      signPub: this.#keys.signPub,
      boxPub: this.#keys.boxPub,
      deviceName: this.#ctx.config.handle,
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
    return { ...frame, sig: signJson(this.#keys, authPayload(frame as never)) };
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
      try {
        this.#handle(JSON.parse(String(data)) as ServerFrame);
      } catch (error) {
        this.#ctx.log.warn("relay frame failed", { error: String(error) });
      }
    });
    ws.on("close", () => {
      const wasReady = this.#ready;
      this.#ready = false;
      this.#online.clear();
      if (wasReady) this.#ctx.log.info("relay disconnected");
      if (this.#stopped) return;
      setTimeout(() => this.#connect(), this.#backoff).unref();
      this.#backoff = Math.min(this.#backoff * 2, 30_000);
    });
    ws.on("error", (error) => {
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
        this.#setRoster(frame.roster);
        this.#ctx.log.info("relay connected", {
          relay: this.#team.relay,
          team: this.#team.teamName,
        });
        this.#onWelcome?.();
        this.#onWelcome = undefined;
        this.#flushOutbox();
        this.publishPresence();
        return;
      case "roster":
        this.#setRoster(frame.roster);
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
          ) as {
            agents: Omit<RemoteAgent, "member" | "deviceId" | "at">[];
          };
          this.#presence.set(frame.deviceId, {
            handle: member.handle,
            at: frame.at,
            agents: p.agents.slice(0, 100).map((a) => ({
              ...a,
              member: member.handle,
              deviceId: frame.deviceId,
              at: frame.at,
            })),
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
        this.#ctx.log.warn("relay error", { code: frame.code, message: frame.message });
        if (frame.ref) this.#waiters.get(frame.ref)?.(frame);
        if (
          this.#onWelcome &&
          (frame.code === "auth" ||
            frame.code === "invite" ||
            frame.code === "exists" ||
            frame.code === "unknown_device")
        ) {
          this.#onWelcome(new Error(`relay refused: ${frame.message}`));
          this.#onWelcome = undefined;
          this.#stopped = true;
          this.#ws?.close();
        }
        return;
      case "ok":
        this.#waiters.get(`op:${frame.op}`)?.(frame);
        return;
      case "sent": {
        const row = this.#ctx.store.get<{ message_id: string | null; handle: string | null }>(
          "SELECT message_id, handle FROM outbox WHERE id = ?",
          frame.id,
        );
        this.#ctx.store.run("DELETE FROM outbox WHERE id = ?", frame.id);
        if (row?.message_id && row.handle) this.onSent?.(row.message_id, row.handle);
        this.#waiters.get(frame.id)?.(frame);
        return;
      }
      default:
        return;
    }
  }

  #setRoster(roster: SignedMember[]): void {
    const seen = new Set<string>();
    for (const { record, mac } of roster) {
      if (record.teamId !== this.#team.teamId || !teamMacOk(this.#team.teamKey, record, mac)) {
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
    this.onRoster?.();
  }

  #onMsg(frame: Extract<ServerFrame, { t: "msg" }>): void {
    const member = this.#members.get(frame.from);
    if (!member) return; // unknown sender: leave it queued until the roster explains it
    let inner: Sealable;
    try {
      inner = JSON.parse(
        open(
          this.#keys,
          frame.blob,
          aad(this.#team.teamId, frame.from, this.#keys.deviceId),
        ).toString("utf8"),
      );
    } catch {
      this.#ctx.log.warn("dropping a message that failed to decrypt", { from: frame.from });
      this.#ack(frame.id);
      return;
    }
    const { sig, ...signed } = inner;
    if (!verifyJson(member.signPub, signed, sig)) {
      this.#ctx.log.warn("dropping a message with a bad signature", { from: member.handle });
      this.#ack(frame.id);
      return;
    }
    try {
      if (inner.kind === "envelope")
        this.onInbound?.({ kind: "envelope", envelope: inner.envelope, from: member });
      else {
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
      this.#ctx.log.warn("inbound handling failed", { error: String(error) });
    }
    this.#ack(frame.id);
  }

  #ack(id: string): void {
    this.#ws?.send(JSON.stringify({ t: "ack", ids: [id] }));
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
    if (this.#ready && this.#ws?.readyState === WebSocket.OPEN)
      this.#ws.send(JSON.stringify(frame));
  }

  #flushOutbox(): void {
    for (const row of this.#ctx.store.all<{ frame: string }>(
      "SELECT frame FROM outbox ORDER BY created_at",
    )) {
      this.#ws?.send(row.frame);
    }
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
        Buffer.from(JSON.stringify({ agents })),
        `presence|${this.#keys.deviceId}`,
      );
      this.#ws?.send(JSON.stringify({ t: "presence", box }));
    }, 300);
    this.#presenceTimer.unref();
  }

  async invite(uses: number, ttlMs: number): Promise<string> {
    if (!this.#ready) throw new Error("not connected to the relay");
    const token = randomToken(24);
    const done = new Promise<ServerFrame>((resolve) => {
      this.#waiters.set("op:invite", resolve);
      setTimeout(
        () => resolve({ t: "error", code: "timeout", message: "relay did not answer" }),
        10_000,
      ).unref();
    });
    this.#ws?.send(
      JSON.stringify({
        t: "invite",
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        uses,
      }),
    );
    const res = await done;
    this.#waiters.delete("op:invite");
    if (res.t === "error") throw new Error(res.message);
    return token;
  }

  removeSelf(): void {
    this.#ws?.send(JSON.stringify({ t: "remove", deviceId: this.#keys.deviceId }));
  }
}
