import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import type { Paths } from "../core/paths.ts";
import { ancestry } from "../core/proc.ts";
import { safeTerminal } from "../core/sanitize.ts";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export interface Health {
  ok: boolean;
  version: string;
  protocol: number;
  pid: number;
  home: string;
  handle: string;
  paused: boolean;
  agents: number;
}

export function callerHeader(opts: { as?: string } = {}): string {
  const chain = ancestry(process.pid).map((p) => ({
    pid: p.pid,
    ppid: p.ppid,
    ...(p.start ? { start: p.start } : {}),
    cmd: p.cmd.slice(0, 4).map((a) => a.slice(0, 200)),
  }));
  const payload = {
    pid: process.pid,
    chain,
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ...(opts.as ? { as: opts.as } : {}),
    ...(process.env.AGENTLINK_AGENT ? { envAgent: process.env.AGENTLINK_AGENT } : {}),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export class Client {
  readonly paths: Paths;
  readonly #as: string | undefined;
  readonly #timeoutMs: number;
  #caller: string | undefined;

  readonly #clean: boolean;

  /** `clean` makes every string in responses safe for a terminal (for human-readable output). */
  constructor(paths: Paths, opts: { as?: string; timeoutMs?: number; clean?: boolean } = {}) {
    this.paths = paths;
    this.#as = opts.as;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
    this.#clean = opts.clean ?? false;
  }

  #header(): string {
    this.#caller ??= callerHeader(this.#as ? { as: this.#as } : {});
    return this.#caller;
  }

  request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = request(
        {
          socketPath: this.paths.socket,
          path,
          method,
          headers: {
            "content-type": "application/json",
            "x-agentlink-caller": this.#header(),
            ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
          },
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let data: unknown = {};
            try {
              data = text ? JSON.parse(text) : {};
            } catch {
              return reject(
                new ApiError(
                  "bad_response",
                  `unexpected daemon response: ${text.slice(0, 200)}`,
                  502,
                ),
              );
            }
            if ((res.statusCode ?? 500) >= 400) {
              const err = (data as { error?: { code?: string; message?: string } }).error;
              if (err?.code === "no_route") {
                return reject(
                  new ApiError(
                    "daemon_outdated",
                    "the running agentlink daemon is older than this CLI; restart it: agentlink daemon restart",
                    res.statusCode ?? 404,
                  ),
                );
              }
              return reject(
                new ApiError(
                  err?.code ?? "error",
                  err?.message ?? `HTTP ${res.statusCode}`,
                  res.statusCode ?? 500,
                ),
              );
            }
            resolve((this.#clean ? cleanStrings(data) : data) as T);
          });
        },
      );
      const timeout = opts.timeoutMs ?? this.#timeoutMs;
      if (timeout > 0) {
        req.setTimeout(timeout, () =>
          req.destroy(new ApiError("timeout", "daemon did not answer in time", 504)),
        );
      }
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (error instanceof ApiError) return reject(error);
        if (error.name === "AbortError")
          return reject(new ApiError("aborted", "request aborted", 499));
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
          return reject(
            new ApiError(
              "daemon_down",
              "agentlink daemon is not running (start it: agentlink daemon start)",
              503,
            ),
          );
        }
        if (error.code === "ECONNRESET" || /socket hang up/.test(error.message)) {
          return reject(
            new ApiError(
              "daemon_restarted",
              "the agentlink daemon stopped while this was running; anything already sent is kept (check: agentlink status, agentlink inbox)",
              503,
            ),
          );
        }
        reject(error);
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  async health(timeoutMs = 1_500): Promise<Health | undefined> {
    try {
      return await this.request<Health>("GET", "/v1/health", undefined, { timeoutMs });
    } catch (error) {
      if (
        error instanceof ApiError &&
        !["daemon_down", "timeout", "bad_response"].includes(error.code)
      ) {
        throw error; // the daemon answered: it's up, but refused the request
      }
      return undefined;
    }
  }

  /** Makes sure a daemon answers on the socket, starting one in the background if needed. */
  async ensureDaemon(opts: { autoStart?: boolean; waitMs?: number } = {}): Promise<Health> {
    const up = await this.health();
    if (up) return up;
    if (opts.autoStart === false) {
      throw new ApiError(
        "daemon_down",
        "agentlink daemon is not running (start it: agentlink daemon start)",
        503,
      );
    }
    spawnDaemon(this.paths);
    const deadline = Date.now() + (opts.waitMs ?? 6_000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const h = await this.health(500);
      if (h) return h;
    }
    throw new ApiError("daemon_down", `daemon did not start; see ${this.paths.log}`, 503);
  }

  /** Streams daemon events (SSE) until the signal aborts. */
  events(onEvent: (event: Record<string, unknown>) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.paths.socket,
          path: "/v1/events",
          method: "GET",
          headers: { "x-agentlink-caller": this.#header() },
          signal,
        },
        (res) => {
          let buffer = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffer += chunk;
            let idx = buffer.indexOf("\n\n");
            while (idx >= 0) {
              const block = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              for (const line of block.split("\n")) {
                if (line.startsWith("data: ")) {
                  try {
                    onEvent(JSON.parse(line.slice(6)));
                  } catch {
                    // ignore malformed events
                  }
                }
              }
              idx = buffer.indexOf("\n\n");
            }
          });
          res.on("end", resolve);
        },
      );
      req.on("error", (e: Error) => (e.name === "AbortError" ? resolve() : reject(e)));
      req.end();
    });
  }
}

export function daemonEntry(): string {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`../daemon/run${ext}`, import.meta.url));
}

export function spawnDaemon(paths: Paths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const out = openSync(paths.log, "a", 0o600);
  const child = spawn(
    process.execPath,
    [...process.execArgv.filter((a) => !a.startsWith("--inspect")), daemonEntry()],
    {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, AGENTLINK_HOME: paths.home },
    },
  );
  child.unref();
}

function cleanStrings(value: unknown): unknown {
  if (typeof value === "string") return safeTerminal(value);
  if (Array.isArray(value)) return value.map(cleanStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanStrings(v)]));
  }
  return value;
}
