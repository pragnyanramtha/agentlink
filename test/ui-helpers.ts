import { type IncomingHttpHeaders, request } from "node:http";
import type { TestDaemon } from "./helpers.ts";

export interface UiResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: test convenience
  json: any;
}

/** One HTTP request to the web UI listener (Host defaults to 127.0.0.1:<port>). */
export function uiFetch(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<UiResponse> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path,
        headers: {
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Mints a session as a person at a terminal and returns the bootstrap URL parts. */
export async function mintToken(
  t: TestDaemon,
  body: Record<string, unknown> = {},
): Promise<{ port: number; token: string; url: string }> {
  const res = await t.raw<{ url: string }>("POST", "/v1/ui/session", body, { tty: true });
  if (res.status !== 200) throw new Error(`ui session → ${res.status} ${JSON.stringify(res.data)}`);
  const url = new URL(res.data.url);
  return { port: Number(url.port), token: url.searchParams.get("t") ?? "", url: res.data.url };
}

export interface UiSession {
  port: number;
  cookie: string;
  key: string;
  get(path: string, headers?: Record<string, string>): Promise<UiResponse>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<UiResponse>;
}

/** Full bootstrap: mint a token, exchange it for the session cookie. */
export async function uiLogin(t: TestDaemon): Promise<UiSession> {
  const { port, token } = await mintToken(t);
  const res = await uiFetch(port, `/login?t=${token}`);
  if (res.status !== 303) throw new Error(`login → ${res.status} ${res.text}`);
  const cookie = String(res.headers["set-cookie"]?.[0] ?? "").split(";")[0] as string;
  const key = /^\/#k=([A-Za-z0-9_-]+)$/.exec(String(res.headers.location))?.[1] ?? "";
  const origin = `http://127.0.0.1:${port}`;
  return {
    port,
    cookie,
    key,
    get: (path, headers = {}) =>
      uiFetch(port, path, { headers: { cookie, "x-agentlink-key": key, ...headers } }),
    post: (path, body, headers = {}) =>
      uiFetch(port, path, {
        method: "POST",
        body,
        headers: { cookie, origin, "x-agentlink-ui": "1", "x-agentlink-key": key, ...headers },
      }),
  };
}

/** Reads server-sent events from the UI until `close()`. */
export function uiEvents(s: UiSession): {
  next(match: (e: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<unknown>;
  ready: Promise<number>;
  close(): void;
} {
  const events: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let buffer = "";
  let markReady: (status: number) => void = () => {};
  const ready = new Promise<number>((r) => {
    markReady = r;
  });
  const req = request(
    {
      host: "127.0.0.1",
      port: s.port,
      path: `/api/v1/events?k=${s.key}`,
      headers: { cookie: s.cookie },
    },
    (res) => {
      res.on("data", (c: Buffer) => {
        buffer += c.toString("utf8");
        if (buffer.includes(": connected")) markReady(res.statusCode ?? 0);
        let i = buffer.indexOf("\n\n");
        while (i >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
          }
          i = buffer.indexOf("\n\n");
        }
        for (const w of waiters.splice(0)) w();
      });
      if (res.statusCode !== 200) markReady(res.statusCode ?? 0);
    },
  );
  req.on("error", () => markReady(0));
  req.end();
  return {
    ready,
    async next(match, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = events.find(match);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error("no matching event");
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
    },
    close: () => req.destroy(),
  };
}
