import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ssPids } from "../../src/core/peer.ts";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";
import { mintToken, uiFetch, uiLogin } from "../ui-helpers.ts";

let t: TestDaemon;
afterEach(async () => {
  await t?.stop();
});

async function register(name: string) {
  const proc = t.fakeAgentProcess("generic");
  await t.client().request("POST", "/v1/agents/register", {
    tool: "generic",
    name,
    pid: proc.pid,
    ...(proc.start ? { pidStart: proc.start } : {}),
  });
  return proc;
}

describe("web UI session bootstrap", () => {
  it("only a person at a terminal can start a session", async () => {
    t = await startTestDaemon();
    const alpha = await register("alpha");
    const asAgent = await t.raw("POST", "/v1/ui/session", {}, { as: "alpha", tty: true });
    expect(asAgent.status).toBe(403);
    const inTree = await t.raw(
      "POST",
      "/v1/ui/session",
      {},
      { tty: true, chain: [{ pid: alpha.pid, ppid: 1, cmd: ["generic"] }] },
    );
    expect(inTree.status).toBe(403);
    const noTty = await t.raw("POST", "/v1/ui/session", {});
    expect(noTty.status).toBe(403);
    const ok = await t.raw<{ url: string }>("POST", "/v1/ui/session", {}, { tty: true });
    expect(ok.status).toBe(200);
    expect(ok.data.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/login\?t=[A-Za-z0-9_-]{43}$/);
  });

  it("bootstrap tokens work once, expire, and set a strict session cookie", async () => {
    let clock = Date.parse("2026-03-01T00:00:00Z");
    t = await startTestDaemon({ now: () => new Date(clock) });
    const { port, token } = await mintToken(t);
    const first = await uiFetch(port, `/login?t=${token}`);
    expect(first.status).toBe(303);
    // The API key travels in the fragment: browsers never send it to any server.
    expect(first.headers.location).toMatch(/^\/#k=[A-Za-z0-9_-]{43}$/);
    const cookie = String(first.headers["set-cookie"]?.[0]);
    expect(cookie).toMatch(/^al_ui_\d+=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie.toLowerCase()).not.toContain("domain");
    expect((await uiFetch(port, `/login?t=${token}`)).status).toBe(403);
    expect((await uiFetch(port, "/login?t=AAAA")).status).toBe(403);
    expect((await uiFetch(port, "/login")).status).toBe(403);

    const late = await mintToken(t);
    clock += 2 * 60_000 + 1_000;
    const expired = await uiFetch(late.port, `/login?t=${late.token}`);
    expect(expired.status).toBe(403);
    expect(expired.headers["set-cookie"]).toBeUndefined();
  });

  it("requires the session cookie for every page and API call, and sessions expire", async () => {
    let clock = Date.parse("2026-03-01T00:00:00Z");
    t = await startTestDaemon({ now: () => new Date(clock) });
    const s = await uiLogin(t);
    for (const path of ["/", "/app.js", "/app.css", "/api/v1/overview", "/api/v1/events"]) {
      expect((await uiFetch(s.port, path)).status, path).toBe(401);
      const wrong = `${s.cookie.split("=")[0]}=${"A".repeat(43)}`;
      expect((await uiFetch(s.port, path, { headers: { cookie: wrong } })).status, path).toBe(401);
    }
    expect((await s.get("/api/v1/overview")).status).toBe(200);
    // Cookies are shared by every port on 127.0.0.1, so the API also needs the session's key.
    const other = await uiLogin(t);
    for (const key of ["", "A".repeat(43), other.key]) {
      const res = await s.get("/api/v1/overview", { "x-agentlink-key": key });
      expect(res.status, key).toBe(401);
      expect(
        (await s.post("/api/v1/control", { action: "pause" }, { "x-agentlink-key": key })).status,
      ).toBe(401);
    }
    expect((await s.get(`/api/v1/overview?k=${s.key}`, { "x-agentlink-key": "" })).status).toBe(
      401,
    );
    expect((await s.get(`/api/v1/events?k=${other.key}`, { "x-agentlink-key": "" })).status).toBe(
      401,
    );
    expect((await s.get("/api/v1/overview")).json.paused).toBe(false);
    clock += 13 * 3_600_000;
    expect((await s.get("/api/v1/overview")).status).toBe(401);
  });

  it("refuses requests whose Host is not the loopback listener (DNS rebinding)", async () => {
    t = await startTestDaemon();
    const s = await uiLogin(t);
    for (const host of [
      "evil.example",
      `evil.example:${s.port}`,
      `127.0.0.1.evil.example:${s.port}`,
      "127.0.0.1",
      `127.0.0.1:${s.port + 1}`,
    ]) {
      const res = await s.get("/api/v1/overview", { host });
      expect(res.status, host).toBe(403);
    }
    expect((await s.get("/api/v1/overview", { host: `localhost:${s.port}` })).status).toBe(200);
    const { port, token } = await mintToken(t);
    expect((await uiFetch(port, `/login?t=${token}`, { headers: { host: "evil:1" } })).status).toBe(
      403,
    );
  });

  it("refuses writes without a same-origin Origin and the UI header (CSRF)", async () => {
    t = await startTestDaemon();
    await register("alpha");
    const s = await uiLogin(t);
    const body = { to: ["alpha"], text: "hello" };
    const origin = `http://127.0.0.1:${s.port}`;
    const bare = await uiFetch(s.port, "/api/v1/messages", {
      method: "POST",
      body,
      headers: { cookie: s.cookie },
    });
    expect(bare.status).toBe(403);
    expect(
      (
        await uiFetch(s.port, "/api/v1/messages", {
          method: "POST",
          body,
          headers: { cookie: s.cookie, origin },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await uiFetch(s.port, "/api/v1/messages", {
          method: "POST",
          body,
          headers: { cookie: s.cookie, "x-agentlink-ui": "1" },
        })
      ).status,
    ).toBe(403);
    expect((await s.post("/api/v1/messages", body, { origin: "http://evil.example" })).status).toBe(
      403,
    );
    expect(
      (await s.post("/api/v1/messages", body, { origin: `http://localhost:${s.port}` })).status,
    ).toBe(403);
    expect((await s.get("/api/v1/overview", { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await s.get("/api/v1/overview", { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await s.post("/api/v1/messages", body)).status).toBe(200);
    const log = await t.raw<{ messages: unknown[] }>("GET", "/v1/log");
    expect(log.data.messages).toHaveLength(1);
  });

  it("refuses bodies over 1 MB with 413, drops the connection and keeps serving", async () => {
    t = await startTestDaemon();
    await register("alpha");
    const s = await uiLogin(t);
    // Valid JSON once parsed (padding is whitespace), so only the size check stops it.
    const body = `{"to":["alpha"],"text":"hello"${" ".repeat(1024 * 1024 + 10)}}`;
    const post = (chunked: boolean) =>
      new Promise<number | string>((resolve) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: s.port,
            method: "POST",
            path: "/api/v1/messages",
            headers: {
              cookie: s.cookie,
              origin: `http://127.0.0.1:${s.port}`,
              "x-agentlink-ui": "1",
              "x-agentlink-key": s.key,
              "content-type": "application/json",
              ...(chunked ? {} : { "content-length": Buffer.byteLength(body) }),
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
            res.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
          },
        );
        req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
        if (chunked)
          for (let i = 0; i < body.length; i += 64 * 1024) req.write(body.slice(i, i + 64 * 1024));
        else req.write(body);
        req.end();
      });
    for (const chunked of [false, true]) {
      expect([413, "ECONNRESET", "EPIPE"]).toContain(await post(chunked));
      expect((await s.get("/api/v1/overview")).status).toBe(200);
    }
    const log = await t.raw<{ messages: unknown[] }>("GET", "/v1/log");
    expect(log.data.messages).toHaveLength(0);
    expect((await s.post("/api/v1/messages", { to: ["alpha"], text: "small" })).status).toBe(200);
  });

  it("exposes only the allowlisted routes", async () => {
    t = await startTestDaemon();
    await register("alpha");
    const s = await uiLogin(t);
    const refused: [string, string, unknown][] = [
      ["POST", "/api/v1/shutdown", {}],
      ["POST", "/api/v1/prune", { olderThanMs: 3_600_000 }],
      ["POST", "/api/v1/team/leave", {}],
      ["POST", "/api/v1/team/create", { name: "x" }],
      ["POST", "/api/v1/policy", { scope: "local", kind: "request", action: "deliver" }],
      ["POST", "/api/v1/ui/session", {}],
      ["POST", "/api/v1/config/reload", {}],
      ["POST", "/api/v1/agents/register", { tool: "generic", name: "evil" }],
      ["POST", "/api/v1/agents/rename", { name: "x", agent: "alpha" }],
      ["POST", "/api/v1/hooks/claude/stop", {}],
      ["POST", "/api/v1/threads/x/allow", { extra: 5 }],
      ["POST", "/api/v1/messages/%2e%2e/shutdown", {}],
      ["POST", "/api/v1/messages/x/../../shutdown", {}],
      ["DELETE", "/api/v1/agents/alpha", undefined],
      ["GET", "/api/v1/health", undefined],
      ["GET", "/api/v1/adapters/opencode/poll?agent=alpha", undefined],
      ["GET", "/v1/overview", undefined],
    ];
    for (const [method, path, body] of refused) {
      const res = await uiFetch(s.port, path, {
        method,
        ...(body !== undefined ? { body } : {}),
        headers: {
          cookie: s.cookie,
          origin: `http://127.0.0.1:${s.port}`,
          "x-agentlink-ui": "1",
          "x-agentlink-key": s.key,
        },
      });
      expect([403, 404, 405], `${method} ${path} → ${res.status}`).toContain(res.status);
    }
    const health = await t.raw<{ ok: boolean }>("GET", "/v1/health");
    expect(health.data.ok).toBe(true);
    const agents = await t.raw<{ agents: { name: string }[] }>("GET", "/v1/agents");
    expect(agents.data.agents.map((a) => a.name)).toEqual(["alpha"]);
    // Sends cannot override guards or block the daemon.
    expect(
      (await s.post("/api/v1/messages", { to: ["alpha"], text: "x", force: true })).status,
    ).toBe(400);
    expect(
      (await s.post("/api/v1/messages", { to: ["alpha"], text: "x", waitMs: 60_000 })).status,
    ).toBe(400);
  });

  it("reading through the UI never marks mail seen", async () => {
    t = await startTestDaemon();
    await register("alpha");
    const sent = await t.raw<{ message: { id: string } }>(
      "POST",
      "/v1/messages",
      { to: ["@tester"], kind: "ask", text: "for the human" },
      { as: "alpha" },
    );
    const s = await uiLogin(t);
    const inbox = await s.get("/api/v1/inbox");
    expect(inbox.json.items).toHaveLength(1);
    expect((await s.get(`/api/v1/messages/${sent.data.message.id}`)).status).toBe(200);
    expect((await s.get(`/api/v1/messages/${sent.data.message.id}?peek=0`)).status).toBe(200);
    expect((await s.get("/api/v1/inbox?peek=0")).json.items).toHaveLength(1);
    const overview = await t.raw<{ unread: number }>("GET", "/v1/overview");
    expect(overview.data.unread).toBe(1);
  });

  it("serves strict security headers and a script with no HTML injection sinks", async () => {
    t = await startTestDaemon();
    const s = await uiLogin(t);
    for (const path of ["/", "/api/v1/overview"]) {
      const res = await s.get(path);
      expect(res.status).toBe(200);
      const csp = String(res.headers["content-security-policy"]);
      for (const directive of [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'none'",
      ])
        expect(csp).toContain(directive);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["cache-control"]).toContain("no-store");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
    const html = (await s.get("/")).text;
    expect(html).not.toMatch(/<script>|<style|\sstyle=|\son[a-z]+=/i);
    expect(html).not.toMatch(/https?:\/\//);
    const js = await s.get("/app.js");
    expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(js.text).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(js.text).not.toMatch(/new Function|https?:\/\/(?!www\.w3\.org)/);
    const css = await s.get("/app.css");
    expect(css.headers["content-type"]).toMatch(/^text\/css/);
    expect(css.text).not.toMatch(/@import|url\(\s*["']?https?:/);
  });
});

describe.skipIf(process.platform !== "linux")(
  "web UI connections are identified by the kernel",
  () => {
    it("keeps every pid from the socket table, so a crafted process name cannot hide one", () => {
      // ss does not escape process names: this one is named `x",pid=1,fd=1`.
      const row = 'ESTAB 0 0 127.0.0.1:5 127.0.0.1:6 users:(("x",pid=1,fd=1",pid=4242,fd=3))';
      expect(ssPids(row).map((p) => p.pid)).toEqual([1, 4242]);
    });

    it("refuses a connection from inside an agent's process tree", async () => {
      t = await startTestDaemon({ verifyCallers: true });
      const ui = t.daemon.services.ui;
      if (!ui) throw new Error("no ui service");
      const { url } = await ui.session();
      const port = Number(new URL(url).port);
      // This test process registers itself as an agent: every connection it makes is the agent's.
      await t.client().request("POST", "/v1/agents/register", {
        tool: "generic",
        name: "sneaky",
        pid: process.pid,
      });
      const res = await uiFetch(port, new URL(url).pathname + new URL(url).search);
      expect(res.status).toBe(403);
      expect(res.text).toContain("sneaky");
    });
  },
);
