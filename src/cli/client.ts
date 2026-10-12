import { spawn } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
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
              const unnamed = /cannot tell which process is calling/.test(err?.message ?? "");
              return reject(
                new ApiError(
                  err?.code ?? "error",
                  `${err?.message ?? `HTTP ${res.statusCode}`}${unnamed ? " (check this system: agentlink doctor)" : ""}`,
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
    const offset = fileSize(this.paths.log);
    const child = spawnDaemon(this.paths);
    const deadline = Date.now() + (opts.waitMs ?? 6_000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const h = await this.health(500);
      if (h) return h;
      if (child.exitCode) break; // it gave up (0 means another daemon won the race: keep waiting)
    }
    throw new ApiError(
      "daemon_down",
      startFailure(this.paths, readFrom(this.paths.log, offset), child.exitCode),
      503,
    );
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

/** Starts the daemon in the background; its stdout and stderr (startup errors too) go to its log. */
export function spawnDaemon(paths: Paths): { readonly exitCode: number | null } {
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
  closeSync(out);
  child.on("error", () => {});
  child.unref();
  return child;
}

const fileSize = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/** Up to the last 64 KiB written to `path` after `offset`. */
function readFrom(path: string, offset: number): string {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(offset, size - 65_536);
      const buf = Buffer.alloc(Math.max(0, size - start));
      return buf.subarray(0, readSync(fd, buf, 0, buf.length, start)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** The error a daemon start logged ("agentlink daemon: …", or Node's own error), if any. */
export function startError(log: string): string | undefined {
  const lines = log.split("\n").map((l) => l.trim());
  const ours = lines.filter((l) => l.startsWith("agentlink daemon: ")).pop();
  if (ours) return ours.slice("agentlink daemon: ".length);
  return lines.filter((l) => /^(\w*Error\b|.*\bERR_[A-Z_]+)/.test(l)).pop();
}

/** A concrete next step for a known daemon start error. */
export function startHint(
  reason: string,
  paths: Paths,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (/AGENTLINK_HOME to a Linux path/.test(reason)) return undefined; // already says what to do
  if (/EOPNOTSUPP|ENOTSUP|operation not supported|\b9p\b|drvfs/i.test(reason))
    return `Unix sockets don't work on Windows drives (/mnt/c, …) under WSL: use a Linux path, e.g. export AGENTLINK_HOME=~/.agentlink (now ${paths.home})`;
  if (/not a directory owned by you/.test(reason))
    return `the socket directory belongs to someone else${env.XDG_RUNTIME_DIR ? ` (XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR}, e.g. WSLg's shared one)` : ""}: unset XDG_RUNTIME_DIR or use a shorter AGENTLINK_HOME`;
  if (/ENAMETOOLONG/.test(reason))
    return `the socket path is too long (${paths.socket}): use a shorter AGENTLINK_HOME`;
  if (/EACCES|EPERM|permission denied/i.test(reason))
    return `agentlink cannot create its files: check the owner and permissions of ${paths.home} (ls -ld ${paths.home})`;
  if (
    /ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension|node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE|SyntaxError/.test(
      reason,
    )
  )
    return `agentlink needs Node.js 22.13 or newer (the daemon ran ${process.execPath}, ${process.version}); e.g. nvm install 24`;
  if (/database is locked|SQLITE_BUSY|SQLITE_IOERR|disk I\/O error/i.test(reason))
    return "the database cannot be locked: keep AGENTLINK_HOME on a local Linux disk (not a network or Windows drive)";
  if (/EADDRINUSE/.test(reason)) return `something else holds ${paths.socket}`;
  if (/ENOSPC/.test(reason)) return "the disk is full";
  return undefined;
}

/** What to tell a person when the daemon did not come up. */
export function startFailure(paths: Paths, log: string, exitCode?: number | null): string {
  const reason = startError(log);
  const hint = reason ? startHint(reason, paths) : undefined;
  return [
    `the daemon did not start: ${
      reason ??
      (exitCode ? `it exited with code ${exitCode}` : "it did not answer within a few seconds")
    }`,
    ...(hint ? [`  ${hint}`] : []),
    `  (log: ${paths.log})`,
  ].join("\n");
}

/** The error from the most recent failed daemon start in its log (none once a start succeeded). */
export function lastStartError(paths: Paths): string | undefined {
  const tail = readFrom(paths.log, 0).split("\n");
  const started = tail.findLastIndex((l) => / daemon (started|stopped)\b/.test(l));
  const reason = startError(tail.slice(started + 1).join("\n"));
  return reason && !/already running/.test(reason) ? reason : undefined;
}

function cleanStrings(value: unknown): unknown {
  if (typeof value === "string") return safeTerminal(value);
  if (Array.isArray(value)) return value.map(cleanStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanStrings(v)]));
  }
  return value;
}
