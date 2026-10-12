import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { z } from "zod";
import { KindSchema } from "../core/envelope.ts";
import { invalid } from "../core/errors.ts";
import { runSs, ssPids } from "../core/peer.ts";
import { ancestry } from "../core/proc.ts";
import { wslVersion } from "../core/wsl.ts";
import { ASSETS } from "../ui/assets.ts";
import type { DaemonContext } from "./context.ts";
import type { Registry } from "./registry.ts";
import type { Dispatch } from "./server.ts";

const TOKEN_TTL_MS = 2 * 60_000;
const SESSION_IDLE_MS = 12 * 3_600_000;
const MAX_BODY = 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TOO_LARGE = Symbol("too large");

const HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
};

// What the browser may do. Everything else the daemon offers (shutdown, team, policy changes,
// prune, registration, hooks, …) stays on the Unix socket.
interface Rule {
  method: "GET" | "POST";
  re: RegExp;
  /** Counts as a person at a terminal (the routes behind approve/deny, resume and mute). */
  tty?: boolean;
  /** Reads never mark mail seen, and never long-poll. */
  peek?: boolean;
  body?: z.ZodType;
}
const READS = "overview|agents|team|threads|log|search|todo|approvals|claims|policy|events";
const RULES: Rule[] = [
  { method: "GET", re: new RegExp(`^/v1/(${READS})$`) },
  { method: "GET", re: /^\/v1\/threads\/[^/]+$/ },
  { method: "GET", re: /^\/v1\/messages\/[^/]+$/, peek: true },
  { method: "GET", re: /^\/v1\/inbox$/, peek: true },
  {
    method: "POST",
    re: /^\/v1\/approvals\/[^/]+$/,
    tty: true,
    body: z.object({ decision: z.enum(["approve", "deny"]) }).strict(),
  },
  {
    method: "POST",
    re: /^\/v1\/control$/,
    tty: true,
    body: z
      .object({
        action: z.enum(["pause", "resume", "mute", "unmute"]),
        agent: z.string().min(1).max(200).optional(),
      })
      .strict(),
  },
  {
    // No --force (secret scan) and no blocking waits from the browser.
    method: "POST",
    re: /^\/v1\/messages$/,
    body: z
      .object({
        to: z.array(z.string().min(1).max(200)).max(50).optional(),
        kind: KindSchema.default("info"),
        text: z.string().min(1).max(200_000),
        replyTo: z.string().min(1).max(100).optional(),
        thread: z.string().min(1).max(100).optional(),
        replyAll: z.boolean().optional(),
      })
      .strict(),
  },
];

let ssMissing = process.platform !== "linux";
/** PIDs holding the client end of a loopback TCP connection, from the kernel (`ss`). Every pid in
 * the row is kept (a forged one only adds a process to check), so a crafted name cannot hide one. */
async function loopbackPeerPids(socket: Socket): Promise<PeerPids | undefined> {
  if (ssMissing) return undefined;
  const args = ["-tnpH", "src", `127.0.0.1:${socket.remotePort}`];
  args.push("dst", `127.0.0.1:${socket.localPort}`);
  const { stdout, error } = await runSs(args, 1024 * 1024);
  if (error?.code === "ENOENT") ssMissing = true;
  if (ssMissing) return undefined;
  return error ? { pids: [], failed: true } : { pids: ssPids(stdout ?? "").map((p) => p.pid) };
}
type PeerPids = { pids: number[]; failed?: boolean };

export interface UiOptions {
  /** WSL version (0 off WSL); a Windows browser reaches the UI through a process Linux can't see. */
  wsl?: number;
  peerPids?: (socket: Socket) => Promise<PeerPids | undefined>;
}

interface Secret {
  value: Buffer;
  at: number;
  /** Sessions only: the API key, kept by the page in origin-scoped storage. */
  key?: Buffer;
}
const fresh = () => randomBytes(32).toString("base64url");
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/**
 * The local web UI: a loopback-only HTTP listener started on demand by a person at a terminal.
 * One-time bootstrap tokens become HttpOnly session cookies; API calls run in-process as that
 * person through an allowlist of the daemon's routes.
 */
export class UiServer {
  readonly #dispatch: Dispatch;
  readonly #ctx: DaemonContext;
  readonly #registry: Registry;
  #server: Server | undefined;
  #listening: Promise<number> | undefined;
  #port = 0;
  #tokens: Secret[] = [];
  #sessions: Secret[] = [];
  #open = 0;
  #peers = new WeakMap<Socket, Promise<string | null>>();
  #warned = false;
  #warnedWsl = false;
  readonly #opts: UiOptions;

  constructor(dispatch: Dispatch, ctx: DaemonContext, registry: Registry, opts?: UiOptions) {
    this.#dispatch = dispatch;
    this.#ctx = ctx;
    this.#registry = registry;
    this.#opts = { wsl: wslVersion(), ...opts };
  }

  /** Open browser connections (they keep an idle daemon running). */
  get connections(): number {
    return this.#open;
  }

  async session(port?: number): Promise<{ url: string; port: number; expiresAt: string }> {
    this.#listening ??= this.#listen(port).catch((error) => {
      this.#listening = undefined;
      throw error;
    });
    this.#port = await this.#listening;
    const token = fresh();
    const now = this.#now();
    this.#tokens = [
      ...this.#tokens.filter((t) => t.at > now),
      { value: Buffer.from(token), at: now + TOKEN_TTL_MS },
    ].slice(-8);
    this.#ctx.log.info("web UI link issued", { port: this.#port });
    return {
      url: `http://127.0.0.1:${this.#port}/login?t=${token}`,
      port: this.#port,
      expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
    };
  }

  close(): Promise<void> {
    this.#tokens = [];
    this.#sessions = [];
    const server = this.#server;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  #now(): number {
    return this.#ctx.now().getTime();
  }

  #listen(port = 0): Promise<number> {
    const server = createServer((raw, res) => {
      this.#handle(raw, res).catch((error) => {
        this.#ctx.log.error("web UI request failed", { error: String(error) });
        this.#json(res, 500, "internal", "internal error");
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    server.on("connection", (socket: Socket) => {
      this.#open++;
      socket.once("close", () => this.#open--);
    });
    return new Promise((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) =>
        reject(error.code === "EADDRINUSE" ? invalid(`port ${port} is already in use`) : error),
      );
      server.listen(port, "127.0.0.1", () => {
        this.#server = server;
        const actual = (server.address() as { port: number }).port;
        this.#ctx.log.info("web UI listening", { url: `http://127.0.0.1:${actual}` });
        resolve(actual);
      });
    });
  }

  /** Refuses connections from another OS user or from inside an agent's process tree. */
  #checkPeer(socket: Socket): Promise<string | null> {
    let verdict = this.#peers.get(socket);
    if (!verdict) {
      verdict = (this.#opts.peerPids ?? loopbackPeerPids)(socket).then((peer) => {
        if (!peer) {
          if (!this.#warned) {
            this.#warned = true;
            this.#ctx.log.warn("web UI cannot identify connecting processes on this system");
          }
          return null;
        }
        const { pids } = peer;
        if (pids.length === 0 && !peer.failed && this.#opts.wsl === 2) {
          // A Windows browser reaches the UI through WSL's localhost forwarding (a root process, or
          // none in mirrored mode): Linux shows no process. It still needs the one-time login link.
          if (!this.#warnedWsl) {
            this.#warnedWsl = true;
            this.#ctx.log.warn(
              "web UI: allowing connections from no visible process (a Windows browser under WSL 2)",
            );
          }
          return null;
        }
        if (pids.length === 0) return "agentlink cannot tell which process is connecting; refusing";
        for (const pid of pids) {
          const agent = this.#registry.resolveCaller({
            pid,
            chain: ancestry(pid),
            tty: false,
            verified: true,
          });
          if (agent)
            return `this connection comes from inside the agent session "${agent.name}"; the web UI is for people (open it from your own browser)`;
        }
        return null;
      });
      this.#peers.set(socket, verdict);
    }
    return verdict;
  }

  #cookieName(): string {
    return `al_ui_${this.#port}`;
  }

  #session(raw: IncomingMessage): Secret | undefined {
    const now = this.#now();
    this.#sessions = this.#sessions.filter((s) => now - s.at < SESSION_IDLE_MS);
    const prefix = `${this.#cookieName()}=`;
    const value = (raw.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(prefix))
      ?.slice(prefix.length);
    if (!value || !TOKEN_RE.test(value)) return undefined;
    const candidate = Buffer.from(value);
    let hit: Secret | undefined;
    for (const s of this.#sessions) if (same(s.value, candidate)) hit = s;
    if (hit) hit.at = now;
    return hit;
  }

  #consumeToken(token: string): boolean {
    if (!TOKEN_RE.test(token)) return false;
    const candidate = Buffer.from(token);
    const now = this.#now();
    let hit: Secret | undefined;
    for (const t of this.#tokens) if (same(t.value, candidate)) hit = t;
    if (!hit) return false;
    this.#tokens = this.#tokens.filter((t) => t !== hit);
    return hit.at > now;
  }

  #json(res: ServerResponse, status: number, code: string, message: string): void {
    if (res.headersSent) return void res.end();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code, message } }));
  }

  #text(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(`${text}\n`);
  }

  async #handle(raw: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    // DNS rebinding: only our own loopback names, with our port.
    const host = raw.headers.host;
    if (host !== `127.0.0.1:${this.#port}` && host !== `localhost:${this.#port}`) {
      return this.#text(res, 403, "agentlink: unexpected Host header");
    }
    const refused = await this.#checkPeer(raw.socket);
    if (refused) return this.#text(res, 403, `agentlink: ${refused}`);
    if (raw.method !== "GET" && raw.method !== "POST") {
      return this.#text(res, 405, "agentlink: method not allowed");
    }
    const url = new URL(raw.url ?? "/", "http://ui");
    if (url.pathname === "/login" && raw.method === "GET") {
      if (!this.#consumeToken(url.searchParams.get("t") ?? "")) {
        return this.#text(
          res,
          403,
          "agentlink: this link has expired or was already used. Run `agentlink ui` in a terminal for a new one.",
        );
      }
      const sid = fresh();
      const key = fresh();
      this.#sessions = [
        ...this.#sessions,
        { value: Buffer.from(sid), key: Buffer.from(key), at: this.#now() },
      ].slice(-16);
      this.#ctx.log.info("web UI session started");
      res.writeHead(303, {
        // Cookies are not isolated by port, so API calls also carry this key. A fragment never
        // reaches a server; the page moves it into storage that is scoped to this origin.
        location: `/#k=${key}`,
        "set-cookie": `${this.#cookieName()}=${sid}; HttpOnly; SameSite=Strict; Path=/`,
      });
      return void res.end();
    }
    const api = url.pathname.startsWith("/api/");
    const session = this.#session(raw);
    if (!session) {
      return api
        ? this.#json(res, 401, "unauthorized", "session expired; run `agentlink ui` again")
        : this.#text(
            res,
            401,
            "agentlink: not signed in. Run `agentlink ui` in a terminal and open the link it prints.",
          );
    }
    if (api) return this.#api(raw, res, url, host, session);
    const asset = raw.method === "GET" ? ASSETS[url.pathname] : undefined;
    if (!asset) return this.#text(res, 404, "agentlink: not found");
    res.writeHead(200, { "content-type": asset.type });
    res.end(asset.body);
  }

  async #api(
    raw: IncomingMessage,
    res: ServerResponse,
    url: URL,
    host: string,
    session: Secret,
  ): Promise<void> {
    // Another localhost page is "same-site" (cookies flow), but never "same-origin".
    const site = raw.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") {
      return this.#json(res, 403, "forbidden", "cross-site request refused");
    }
    if (raw.method === "POST") {
      const type = String(raw.headers["content-type"] ?? "");
      if (raw.headers.origin !== `http://${host}` || raw.headers["x-agentlink-ui"] !== "1") {
        return this.#json(res, 403, "forbidden", "cross-site request refused");
      }
      if (!/^application\/json(;|$)/.test(type)) {
        return this.#json(res, 415, "invalid", "send JSON");
      }
    }
    // EventSource cannot send headers: only the event stream takes the key in its URL.
    const key =
      url.pathname === "/api/v1/events"
        ? url.searchParams.get("k")
        : raw.headers["x-agentlink-key"];
    if (typeof key !== "string" || !session.key || !same(session.key, Buffer.from(key))) {
      return this.#json(res, 401, "unauthorized", "session key missing; run `agentlink ui` again");
    }
    url.searchParams.delete("k");
    const path = url.pathname.slice(4);
    const rule = RULES.find((r) => r.method === raw.method && r.re.test(path));
    if (!rule) return this.#json(res, 404, "no_route", `${raw.method} ${url.pathname}`);
    let body: unknown = {};
    if (rule.body) {
      const input = await this.#readJson(raw);
      if (input === TOO_LARGE) {
        // Stop reading: answer once, then drop the connection with whatever is still incoming.
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        const error = { code: "too_large", message: "request body over 1 MB" };
        return void res.end(JSON.stringify({ error }), () => raw.socket.destroy());
      }
      const parsed = rule.body.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
          .join("; ");
        return this.#json(res, 400, "invalid", message);
      }
      body = parsed.data;
    }
    const target = new URL(path, "http://agentlink");
    target.search = url.search;
    if (rule.peek) {
      target.searchParams.set("peek", "1");
      target.searchParams.delete("waitMs");
    }
    await this.#dispatch(raw, res, target, {
      caller: { pid: 0, chain: [], tty: !!rule.tty, verified: true },
      body,
    });
  }

  #readJson(raw: IncomingMessage): Promise<unknown> {
    if (Number(raw.headers["content-length"] ?? 0) > MAX_BODY) return Promise.resolve(TOO_LARGE);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY) return void chunks.push(chunk);
        raw.off("data", onData).pause();
        resolve(TOO_LARGE);
      };
      raw.on("data", onData);
      raw.once("error", reject);
      raw.once("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(undefined);
        }
      });
      raw.once("close", () => resolve(undefined));
    });
  }
}
