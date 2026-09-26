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
import { ulid } from "../core/ids.ts";
import { safeField } from "../core/sanitize.ts";
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
  /** Host name of the machine it runs on. */
  host?: string;
  /** Short session tag (last characters of its id on its own machine). */
  sid?: string;
  /** Names it had before a rename (still accepted as addresses). */
  aliases?: string[];
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

type Mode =
  | { kind: "hello" }
  | { kind: "create"; createToken?: string }
  | { kind: "join"; token: string };

const aad = (teamId: string, from: string, to: string) => `agentlink/v1|${teamId}|${from}|${to}`;

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
        this.#handle(JSON.parse(String(data)) as ServerFrame);
      } catch (error) {
        this.#ctx.log.warn("relay frame failed", { error: String(error) });
      }
    });
    ws.on("close", (code) => {
      if (ws !== this.#ws) return; // a replaced socket
      const wasReady = this.#ready;
      this.#ready = false;
      this.#online.clear();
      if (wasReady) this.#ctx.log.info("relay disconnected");
      if (code === 4000) {
        // The relay keeps one connection per device: another daemon with this device key took over.
        this.#ctx.log.warn(
          "another agentlink daemon is using this device's relay connection; this one stops",
        );
        this.#stopped = true;
      }
      if (this.#stopped) return;
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
            host?: string;
          };
          const host = safeField(p.host, 64) ?? undefined;
          this.#presence.set(frame.deviceId, {
            handle: member.handle,
            at: frame.at,
            ...(host ? { host } : {}),
            // Presence comes from another machine: keep only well-formed, bounded, printable fields.
            agents: (Array.isArray(p.agents) ? p.agents : [])
              .slice(0, 100)
              .filter((a) => typeof a?.name === "string" && NAME_RE.test(a.name))
              .map((a) => ({
                name: a.name,
                tool: safeField(a.tool, 32) ?? "unknown",
                state: ["busy", "idle", "offline", "stale"].includes(a.state) ? a.state : "offline",
                repo: safeField(a.repo, 200),
                branch: safeField(a.branch, 100),
                status: safeField(a.status, 200),
                ...(typeof a.stateAt === "string" ? { stateAt: a.stateAt.slice(0, 40) } : {}),
                ...(safeField(a.reach, 40) ? { reach: safeField(a.reach, 40) as string } : {}),
                ...(typeof a.sid === "string" && /^[a-z0-9]{1,8}$/.test(a.sid)
                  ? { sid: a.sid }
                  : {}),
                ...(Array.isArray(a.aliases)
                  ? {
                      aliases: (a.aliases as unknown[])
                        .filter((x): x is string => typeof x === "string" && NAME_RE.test(x))
                        .slice(0, 5),
                    }
                  : {}),
                member: member.handle,
                deviceId: frame.deviceId,
                at: frame.at,
                ...(host ? { host } : {}),
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
        if (this.#ready) {
          for (const op of ["op:code_put", "op:invite"]) this.#waiters.get(op)?.(frame);
        }
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
        Buffer.from(JSON.stringify({ agents, host: hostname() })),
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

  /** Stores a sealed invite under a short code's id on the relay (fetchable once). */
  async putCode(id: string, box: { nonce: string; ct: string }, expiresAt: string): Promise<void> {
    if (!this.#ready) throw new Error("not connected to the relay");
    const done = new Promise<ServerFrame>((resolve) => {
      this.#waiters.set("op:code_put", resolve);
      setTimeout(
        () => resolve({ t: "error", code: "timeout", message: "relay did not answer" }),
        10_000,
      ).unref();
    });
    this.#ws?.send(JSON.stringify({ t: "code_put", id, box, expiresAt }));
    const res = await done;
    this.#waiters.delete("op:code_put");
    if (res.t === "error") throw new Error(res.message);
  }

  removeSelf(): void {
    this.#ws?.send(JSON.stringify({ t: "remove", deviceId: this.#keys.deviceId }));
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
      const frame = JSON.parse(String(data)) as ServerFrame;
      ws.close();
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
