import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import { sha256, verifyJson } from "../core/crypto.ts";
import { ulid } from "../core/ids.ts";
import type { Logger } from "../core/log.ts";
import { VERSION } from "../version.ts";
import {
  authPayload,
  CLOCK_SKEW_MS,
  type ClientFrame,
  ClientFrameSchema,
  MAX_FRAME_BYTES,
  type ServerFrame,
  type SignedMember,
} from "./protocol.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
  team_id TEXT NOT NULL, device_id TEXT NOT NULL, sign_pub TEXT NOT NULL, member TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL, removed_at TEXT,
  PRIMARY KEY (team_id, device_id)
);
CREATE TABLE IF NOT EXISTS invites (
  team_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, uses_left INTEGER NOT NULL,
  created_by TEXT NOT NULL, PRIMARY KEY (team_id, token_hash)
);
CREATE TABLE IF NOT EXISTS queue (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, to_device TEXT NOT NULL, from_device TEXT NOT NULL,
  blob TEXT NOT NULL, bytes INTEGER NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS queue_to ON queue(team_id, to_device, at);
CREATE TABLE IF NOT EXISTS presence (
  team_id TEXT NOT NULL, device_id TEXT NOT NULL, box TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (team_id, device_id)
);
CREATE TABLE IF NOT EXISTS seen_nonces (nonce TEXT PRIMARY KEY, at INTEGER NOT NULL);
`;

const QUEUE_TTL_MS = 7 * 24 * 3600_000;
const MAX_QUEUE_PER_DEVICE = 5_000;
const RATE_PER_MINUTE = 600;

interface Conn {
  ws: WebSocket;
  teamId?: string;
  deviceId?: string;
  sentThisMinute: number;
  minute: number;
}

export interface RelayOptions {
  dataDir: string;
  host?: string;
  port?: number;
  logger: Logger;
}

export interface RunningRelay {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Self-hostable store-and-forward relay for sealed agentlink traffic. */
export async function startRelay(opts: RelayOptions): Promise<RunningRelay> {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(opts.dataDir, "relay.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  const log = opts.logger;
  const conns = new Set<Conn>();
  const q = <T>(sql: string, ...p: (string | number | null)[]) => db.prepare(sql).all(...p) as T[];
  const one = <T>(sql: string, ...p: (string | number | null)[]) =>
    db.prepare(sql).get(...p) as T | undefined;
  const run = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).run(...p);

  const send = (c: Conn, frame: ServerFrame) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(frame));
  };
  const peersOf = (teamId: string) => [...conns].filter((c) => c.teamId === teamId && c.deviceId);
  const roster = (teamId: string): { roster: SignedMember[]; admins: string[] } => {
    const rows = q<{ member: string; admin: number; device_id: string }>(
      "SELECT member, admin, device_id FROM devices WHERE team_id = ? AND removed_at IS NULL ORDER BY joined_at",
      teamId,
    );
    return {
      roster: rows.map((r) => JSON.parse(r.member) as SignedMember),
      admins: rows.filter((r) => r.admin === 1).map((r) => r.device_id),
    };
  };
  const broadcastRoster = (teamId: string) => {
    const r = roster(teamId);
    for (const c of peersOf(teamId)) send(c, { t: "roster", ...r });
  };

  const verifySigned = (
    frame: ClientFrame & { ts: number; nonce: string; sig: string },
    signPub: string,
  ) => {
    if (Math.abs(Date.now() - frame.ts) > CLOCK_SKEW_MS) return "clock skew too large";
    if (one("SELECT 1 FROM seen_nonces WHERE nonce = ?", frame.nonce)) return "replayed nonce";
    if (!verifyJson(signPub, authPayload(frame as never), frame.sig)) return "bad signature";
    run("INSERT INTO seen_nonces (nonce, at) VALUES (?, ?)", frame.nonce, Date.now());
    return undefined;
  };

  const flushQueue = (c: Conn) => {
    const rows = q<{ id: string; from_device: string; blob: string; at: string }>(
      "SELECT id, from_device, blob, at FROM queue WHERE team_id = ? AND to_device = ? ORDER BY at LIMIT 500",
      c.teamId as string,
      c.deviceId as string,
    );
    for (const r of rows)
      send(c, { t: "msg", id: r.id, from: r.from_device, blob: JSON.parse(r.blob), at: r.at });
  };

  const welcome = (c: Conn) => {
    const teamId = c.teamId as string;
    send(c, { t: "welcome", teamId, deviceId: c.deviceId as string, ...roster(teamId) });
    for (const p of q<{ device_id: string; box: string; at: string }>(
      "SELECT device_id, box, at FROM presence WHERE team_id = ? AND device_id != ?",
      teamId,
      c.deviceId as string,
    )) {
      send(c, { t: "presence", deviceId: p.device_id, box: JSON.parse(p.box), at: p.at });
    }
    for (const other of peersOf(teamId)) {
      if (other !== c) {
        send(other, { t: "online", deviceId: c.deviceId as string, online: true });
        send(c, { t: "online", deviceId: other.deviceId as string, online: true });
      }
    }
    flushQueue(c);
  };

  const handle = (c: Conn, frame: ClientFrame) => {
    const now = new Date().toISOString();
    if (frame.t === "ping") return send(c, { t: "pong" });
    if (frame.t === "hello") {
      const dev = one<{ sign_pub: string }>(
        "SELECT sign_pub FROM devices WHERE team_id = ? AND device_id = ? AND removed_at IS NULL",
        frame.teamId,
        frame.deviceId,
      );
      if (!dev)
        return send(c, {
          t: "error",
          code: "unknown_device",
          message: "device is not a member of this team",
        });
      const bad = verifySigned(frame, dev.sign_pub);
      if (bad) return send(c, { t: "error", code: "auth", message: bad });
      c.teamId = frame.teamId;
      c.deviceId = frame.deviceId;
      return welcome(c);
    }
    if (frame.t === "create" || frame.t === "join") {
      if (
        frame.member.record.deviceId !== frame.device.deviceId ||
        frame.member.record.signPub !== frame.device.signPub
      ) {
        return send(c, {
          t: "error",
          code: "invalid",
          message: "member record does not match device",
        });
      }
      const bad = verifySigned(frame, frame.device.signPub);
      if (bad) return send(c, { t: "error", code: "auth", message: bad });
      if (frame.t === "create") {
        if (one("SELECT 1 FROM teams WHERE id = ?", frame.teamId)) {
          return send(c, { t: "error", code: "exists", message: "team already exists" });
        }
        run("INSERT INTO teams (id, created_at) VALUES (?, ?)", frame.teamId, now);
      } else {
        const inv = one<{ uses_left: number; expires_at: string }>(
          "SELECT uses_left, expires_at FROM invites WHERE team_id = ? AND token_hash = ?",
          frame.teamId,
          sha256(frame.token),
        );
        if (!inv || inv.uses_left < 1 || inv.expires_at < now) {
          return send(c, {
            t: "error",
            code: "invite",
            message: "invite is invalid, used up or expired",
          });
        }
        run(
          "UPDATE invites SET uses_left = uses_left - 1 WHERE team_id = ? AND token_hash = ?",
          frame.teamId,
          sha256(frame.token),
        );
      }
      run(
        `INSERT INTO devices (team_id, device_id, sign_pub, member, admin, joined_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, device_id) DO UPDATE SET member = excluded.member, removed_at = NULL`,
        frame.teamId,
        frame.device.deviceId,
        frame.device.signPub,
        JSON.stringify(frame.member),
        frame.t === "create" ? 1 : 0,
        now,
      );
      c.teamId = frame.teamId;
      c.deviceId = frame.device.deviceId;
      log.info(
        `${frame.t}: ${frame.member.record.handle} (${frame.device.deviceId}) in ${frame.teamId}`,
      );
      welcome(c);
      return broadcastRoster(frame.teamId);
    }
    if (!c.teamId || !c.deviceId)
      return send(c, { t: "error", code: "auth", message: "say hello first" });
    const teamId = c.teamId;
    const isAdmin = !!one(
      "SELECT 1 FROM devices WHERE team_id = ? AND device_id = ? AND admin = 1 AND removed_at IS NULL",
      teamId,
      c.deviceId,
    );
    switch (frame.t) {
      case "invite": {
        if (!isAdmin)
          return send(c, { t: "error", code: "forbidden", message: "only team admins can invite" });
        run(
          "INSERT OR REPLACE INTO invites (team_id, token_hash, expires_at, uses_left, created_by) VALUES (?, ?, ?, ?, ?)",
          teamId,
          frame.tokenHash,
          frame.expiresAt,
          frame.uses,
          c.deviceId,
        );
        return send(c, { t: "ok", op: "invite" });
      }
      case "send": {
        const minute = Math.floor(Date.now() / 60_000);
        if (c.minute !== minute) {
          c.minute = minute;
          c.sentThisMinute = 0;
        }
        if (++c.sentThisMinute > RATE_PER_MINUTE) {
          return send(c, { t: "error", code: "rate", message: "rate limited", ref: frame.id });
        }
        if (
          !one(
            "SELECT 1 FROM devices WHERE team_id = ? AND device_id = ? AND removed_at IS NULL",
            teamId,
            frame.to,
          )
        ) {
          return send(c, {
            t: "error",
            code: "unknown_device",
            message: "recipient is not in this team",
            ref: frame.id,
          });
        }
        const queued =
          one<{ n: number }>(
            "SELECT COUNT(*) AS n FROM queue WHERE team_id = ? AND to_device = ?",
            teamId,
            frame.to,
          )?.n ?? 0;
        if (queued >= MAX_QUEUE_PER_DEVICE) {
          return send(c, {
            t: "error",
            code: "full",
            message: "recipient queue is full",
            ref: frame.id,
          });
        }
        const id = ulid();
        const blob = JSON.stringify(frame.blob);
        run(
          "INSERT INTO queue (id, team_id, to_device, from_device, blob, bytes, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id,
          teamId,
          frame.to,
          c.deviceId,
          blob,
          blob.length,
          now,
        );
        const targets = peersOf(teamId).filter((p) => p.deviceId === frame.to);
        for (const t of targets)
          send(t, { t: "msg", id, from: c.deviceId, blob: frame.blob, at: now });
        return send(c, { t: "sent", id: frame.id, queued: targets.length === 0 });
      }
      case "ack": {
        for (const id of frame.ids)
          run(
            "DELETE FROM queue WHERE id = ? AND team_id = ? AND to_device = ?",
            id,
            teamId,
            c.deviceId,
          );
        return;
      }
      case "presence": {
        run(
          "INSERT INTO presence (team_id, device_id, box, at) VALUES (?, ?, ?, ?) ON CONFLICT(team_id, device_id) DO UPDATE SET box = excluded.box, at = excluded.at",
          teamId,
          c.deviceId,
          JSON.stringify(frame.box),
          now,
        );
        for (const p of peersOf(teamId)) {
          if (p !== c) send(p, { t: "presence", deviceId: c.deviceId, box: frame.box, at: now });
        }
        return;
      }
      case "remove": {
        if (!isAdmin && frame.deviceId !== c.deviceId) {
          return send(c, {
            t: "error",
            code: "forbidden",
            message: "only admins can remove other devices",
          });
        }
        run(
          "UPDATE devices SET removed_at = ? WHERE team_id = ? AND device_id = ?",
          now,
          teamId,
          frame.deviceId,
        );
        run("DELETE FROM queue WHERE team_id = ? AND to_device = ?", teamId, frame.deviceId);
        for (const p of peersOf(teamId))
          if (p.deviceId === frame.deviceId) p.ws.close(4001, "removed");
        send(c, { t: "ok", op: "remove" });
        return broadcastRoster(teamId);
      }
    }
  };

  const http: Server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, relay: "agentlink", version: VERSION, connections: conns.size }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("agentlink relay: connect with a WebSocket client (agentlink team join)\n");
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_FRAME_BYTES });
  wss.on("connection", (ws) => {
    const c: Conn = { ws, sentThisMinute: 0, minute: 0 };
    conns.add(c);
    ws.on("message", (data) => {
      let frame: ClientFrame;
      try {
        frame = ClientFrameSchema.parse(JSON.parse(String(data)));
      } catch (error) {
        return send(c, {
          t: "error",
          code: "invalid",
          message: `bad frame: ${String((error as Error).message).slice(0, 200)}`,
        });
      }
      try {
        handle(c, frame);
      } catch (error) {
        log.error("relay frame failed", { error: String(error) });
        send(c, { t: "error", code: "internal", message: "relay error" });
      }
    });
    ws.on("close", () => {
      conns.delete(c);
      if (c.teamId && c.deviceId && !peersOf(c.teamId).some((p) => p.deviceId === c.deviceId)) {
        for (const p of peersOf(c.teamId))
          send(p, { t: "online", deviceId: c.deviceId, online: false });
      }
    });
    ws.on("error", () => ws.close());
  });

  const gc = setInterval(() => {
    const cutoff = new Date(Date.now() - QUEUE_TTL_MS).toISOString();
    run("DELETE FROM queue WHERE at < ?", cutoff);
    run("DELETE FROM seen_nonces WHERE at < ?", Date.now() - 2 * CLOCK_SKEW_MS);
  }, 60_000);
  gc.unref();

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port ?? 7700, opts.host ?? "127.0.0.1", () => resolve());
  });
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 7700);
  const url = `ws://${opts.host && opts.host !== "0.0.0.0" ? opts.host : "127.0.0.1"}:${port}`;
  log.info(`agentlink relay listening on ${url}`);
  return {
    url,
    port,
    close: () =>
      new Promise((resolve) => {
        clearInterval(gc);
        for (const c of conns) c.ws.terminate();
        wss.close(() =>
          http.close(() => {
            db.close();
            resolve();
          }),
        );
      }),
  };
}
