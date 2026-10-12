import { afterEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon, until } from "../helpers.ts";
import { uiEvents, uiLogin } from "../ui-helpers.ts";

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
    state: "idle",
  });
  return proc;
}

describe("web UI", () => {
  it("serves the viewer and the read API to a signed-in person", async () => {
    t = await startTestDaemon();
    await register("alpha");
    await register("beta");
    const ask = await t.raw<{ message: { id: string; thread: string } }>(
      "POST",
      "/v1/messages",
      { to: ["beta"], kind: "ask", text: "where is the zebra config?" },
      { as: "alpha" },
    );
    await t.raw(
      "POST",
      "/v1/messages",
      { kind: "reply", replyTo: ask.data.message.id, text: "in zebra.toml" },
      { as: "beta" },
    );
    const s = await uiLogin(t);

    const page = await s.get("/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    expect(page.text).toContain('src="/app.js"');
    expect(page.text).toContain('href="/app.css"');
    expect((await s.get("/app.js")).text.length).toBeGreaterThan(1_000);

    const overview = await s.get("/api/v1/overview");
    expect(overview.json).toMatchObject({ handle: "tester", agents: { local: { idle: 2 } } });
    const agents = await s.get("/api/v1/agents?all=1");
    expect(agents.json.agents.map((a: { name: string }) => a.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    const threads = await s.get("/api/v1/threads?limit=10");
    expect(threads.json.threads).toHaveLength(1);
    expect(threads.json.threads[0].messages).toBe(2);
    const thread = await s.get(`/api/v1/threads/${ask.data.message.thread}`);
    expect(thread.json.messages).toHaveLength(2);
    expect(thread.json.messages[1].message.re.id).toBe(ask.data.message.id);
    const search = await s.get("/api/v1/search?q=zebra&kind=ask");
    expect(search.json.results).toHaveLength(1);
    expect(search.json.results[0].snippet).toContain("«zebra»");
    const log = await s.get("/api/v1/log?limit=5");
    expect(log.json.messages).toHaveLength(2);
    for (const path of ["/api/v1/team", "/api/v1/todo", "/api/v1/claims", "/api/v1/policy"]) {
      expect((await s.get(path)).status, path).toBe(200);
    }
  });

  it("approves a held delivery, controls delivery and sends as the person", async () => {
    t = await startTestDaemon();
    await register("alpha");
    await register("beta");
    await t.raw(
      "POST",
      "/v1/policy",
      { scope: "local", kind: "request", action: "hold" },
      { tty: true },
    );
    await t.raw(
      "POST",
      "/v1/messages",
      { to: ["beta"], kind: "request", text: "please run the migration" },
      { as: "alpha" },
    );
    const s = await uiLogin(t);
    const held = await s.get("/api/v1/approvals");
    expect(held.json.items).toHaveLength(1);
    const id = held.json.items[0].delivery.id;
    const approved = await s.post(`/api/v1/approvals/${id}`, { decision: "approve" });
    expect(approved.status, approved.text).toBe(200);
    expect((await s.get("/api/v1/approvals")).json.items).toHaveLength(0);
    const inbox = await t.raw<{ items: unknown[] }>("GET", "/v1/inbox?peek=1", undefined, {
      as: "beta",
    });
    expect(inbox.data.items).toHaveLength(1);

    expect((await s.post("/api/v1/control", { action: "pause" })).json.paused).toBe(true);
    expect((await s.get("/api/v1/overview")).json.paused).toBe(true);
    expect((await s.post("/api/v1/control", { action: "resume" })).json.paused).toBe(false);
    const muted = await s.post("/api/v1/control", { action: "mute", agent: "beta" });
    expect(muted.json.agent.muted).toBe(true);
    await s.post("/api/v1/control", { action: "unmute", agent: "beta" });

    const sent = await s.post("/api/v1/messages", { to: ["alpha"], kind: "info", text: "hi" });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.json.asHuman).toBe(true);
    const alphaInbox = await t.raw<{ items: { message: { from: string } }[] }>(
      "GET",
      "/v1/inbox?peek=1",
      undefined,
      { as: "alpha" },
    );
    expect(alphaInbox.data.items.map((i) => i.message.from)).toContain("@tester");
  });

  it("streams live events over SSE", async () => {
    t = await startTestDaemon();
    await register("alpha");
    await register("beta");
    const s = await uiLogin(t);
    const events = uiEvents(s);
    try {
      expect(await events.ready).toBe(200);
      await t.raw("POST", "/v1/messages", { to: ["beta"], text: "live one" }, { as: "alpha" });
      const msg = (await events.next((e) => e.type === "message")) as {
        message: { preview: string; from: string };
      };
      expect(msg.message.preview).toContain("live one");
      expect(msg.message.from).toBe("alpha");
      const delivery = await events.next((e) => e.type === "delivery");
      expect(delivery).toMatchObject({ delivery: { to: "beta" } });
    } finally {
      events.close();
    }
    // The UI listener keeps the daemon's idle timer alive while connected, then lets go.
    expect(await until(() => t.daemon.services.ui?.connections === 0, 10_000)).toBe(true);
  });
});
