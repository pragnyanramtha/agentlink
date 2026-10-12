// Shared helpers for the agentlink simulation harness (scripts/sim). Nothing here touches the
// real ~/.agentlink: every path comes from the caller (a sandbox directory).
import { appendFileSync, readdirSync } from "node:fs";
import { request } from "node:http";
import type { EventLoopUtilization, IntervalHistogram } from "node:perf_hooks";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export type Json = Record<string, unknown>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** mulberry32: small, fast, seedable PRNG (deterministic workload choices per seed). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    chance: (p: number) => next() < p,
    shuffle: <T>(xs: readonly T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
    word: () => {
      const c = "bcdfghjklmnpqrstvwxz";
      const v = "aeiou";
      let w = "";
      for (let i = 0; i < 4; i++)
        w += `${c[Math.floor(next() * c.length)] ?? "b"}${v[Math.floor(next() * 5)] ?? "a"}`;
      return w;
    },
  };
}
export type Rng = ReturnType<typeof rng>;

export interface HttpResult<T = Json> {
  status: number;
  data: T;
  ms: number;
  error?: string;
}

/** One HTTP request over a Unix socket; never throws (errors come back as status 0). */
export function unixRequest<T = Json>(
  socket: string,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = 15_000,
  /** Reuse a kept-alive connection (like a plugin); default: a fresh one, like each CLI process. */
  keepAlive = false,
): Promise<HttpResult<T>> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let done = false;
    const finish = (r: Omit<HttpResult<T>, "ms">) => {
      if (done) return;
      done = true;
      resolve({ ...r, ms: performance.now() - t0 });
    };
    const req = request(
      {
        socketPath: socket,
        method,
        path,
        ...(keepAlive ? {} : { agent: false }),
        headers: {
          "content-type": "application/json",
          ...headers,
          ...(payload ? { "content-length": String(Buffer.byteLength(payload)) } : {}),
        },
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
            data = { text: text.slice(0, 500) };
          }
          finish({ status: res.statusCode ?? 0, data: data as T });
        });
        res.on("error", (e) => finish({ status: 0, data: {} as T, error: String(e) }));
      },
    );
    if (timeoutMs > 0)
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error("timeout"));
      });
    req.on("error", (e: NodeJS.ErrnoException) =>
      finish({
        status: 0,
        data: {} as T,
        error: e.message === "timeout" ? "timeout" : (e.code ?? e.message),
      }),
    );
    if (payload) req.write(payload);
    req.end();
  });
}

export const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Periodic process stats (memory, fds, event-loop delay and utilization) appended as JSONL. */
export function startStats(file: string, everyMs: number, extra?: () => Json): () => void {
  const h: IntervalHistogram = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  let elu: EventLoopUtilization = performance.eventLoopUtilization();
  const tick = () => {
    const m = process.memoryUsage();
    let fds = -1;
    try {
      fds = readdirSync("/proc/self/fd").length;
    } catch {}
    const now = performance.eventLoopUtilization();
    const u = performance.eventLoopUtilization(now, elu);
    elu = now;
    const line = {
      t: Date.now(),
      rss: m.rss,
      heap: m.heapUsed,
      ext: m.external,
      fds,
      handles: process.getActiveResourcesInfo().length,
      eld: {
        p50: h.percentile(50) / 1e6,
        p99: h.percentile(99) / 1e6,
        max: h.max / 1e6,
      },
      elu: Math.round(u.utilization * 1000) / 1000,
      ...(extra ? extra() : {}),
    };
    h.reset();
    try {
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch {}
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number;
}

/** Message ids in rendered injections (`<agentlink-msg-TOKEN id="…"`). */
export function injectedIds(text: string | undefined): string[] {
  if (!text) return [];
  // hook stdout is JSON, so the quotes may be escaped
  return [...text.matchAll(/<agentlink-msg-[A-Za-z0-9]+ id=\\?"([0-9A-Z]+)\\?"/g)].map(
    (m) => m[1] as string,
  );
}
