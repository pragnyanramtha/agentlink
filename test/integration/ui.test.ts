import { createContext, Script } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { squeeze } from "../../src/ui/app.ts";
import { CORE } from "../../src/ui/core.ts";
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

  it("serves the tower shell and the data its views read", async () => {
    t = await startTestDaemon();
    const proc = t.fakeAgentProcess("claude");
    await t.client().request("POST", "/v1/agents/register", {
      tool: "claude",
      name: "claude-api",
      pid: proc.pid,
      ...(proc.start ? { pidStart: proc.start } : {}),
      cwd: t.home,
      model: "claude-opus-4-5-20251101",
      title: "fix login",
      state: "busy",
    });
    await register("beta");
    await register("gamma");
    const ask = await t.raw<{ message: { id: string; thread: string } }>(
      "POST",
      "/v1/messages",
      { to: ["beta"], kind: "ask", text: "which port?" },
      { as: "claude-api" },
    );
    await t.raw(
      "POST",
      "/v1/messages",
      { to: ["beta", "gamma"], kind: "info", text: "fyi" },
      {
        as: "claude-api",
      },
    );
    const s = await uiLogin(t);

    // Shell: ribbon views, tab bar, explorer, inspector and status bar, filled in by the script.
    const html = (await s.get("/")).text;
    for (const view of ["airspace", "graph", "threads", "agents", "approvals", "search"])
      expect(html).toContain(`data-view="${view}"`);
    for (const id of ["explorer", "tabs", "panes", "inspector", "statusbar", "announce"])
      expect(html).toContain(`id="${id}"`);
    const js = (await s.get("/app.js")).text;
    for (const part of [
      "function Airspace(",
      "function Graph(",
      "function ThreadView(",
      "function palette(",
    ])
      expect(js).toContain(part);
    const css = (await s.get("/app.css")).text;
    expect(css).toContain(":root[data-theme=light]");
    expect(css).toContain("prefers-reduced-motion:reduce");
    const total = ["/", "/app.js", "/app.css", "/favicon.svg"].map(
      async (p) => (await s.get(p)).text,
    );
    const bytes = (await Promise.all(total)).reduce((n, b) => n + Buffer.byteLength(b), 0);
    expect(bytes).toBeLessThan(170 * 1024);

    // Airspace blips and the inspector: identity fields for each agent.
    const agents = await s.get("/api/v1/agents?all=1");
    const api = agents.json.agents.find((a: { name: string }) => a.name === "claude-api");
    expect(api).toMatchObject({
      harness: "Claude Code",
      modelShort: "opus-4.5",
      title: "fix login",
      state: "busy",
      local: true,
    });
    expect(api.host).toBeTruthy();
    expect(api.tag).toMatch(/^[0-9a-f]{4}$/);
    // Strips, log and graph: messages with every delivery's receipts.
    const log = await s.get("/api/v1/log?limit=500");
    expect(log.json.messages).toHaveLength(2);
    const group = log.json.messages.find(
      (r: { message: { kind: string } }) => r.message.kind === "info",
    );
    expect(group.deliveries.map((d: { to: string }) => d.to).sort()).toEqual(["beta", "gamma"]);
    for (const d of group.deliveries) expect(d).toHaveProperty("state");
    // Agent note: its conversations. Conversation note: messages with re: links.
    const mine = await s.get("/api/v1/threads?limit=20&with=beta");
    expect(mine.json.threads.map((x: { thread: string }) => x.thread)).toContain(
      ask.data.message.thread,
    );
    expect((await s.get("/api/v1/threads?limit=60")).json.threads).toHaveLength(2);
    expect((await s.get("/api/v1/team")).json.team).toBeNull();
    expect((await s.get("/api/v1/approvals")).json.items).toEqual([]);
    // Conversation state, when the daemon reports it, is one of the four the UI labels.
    const one = await s.get(`/api/v1/threads/${ask.data.message.thread}`);
    if ("state" in one.json)
      expect(["held", "waiting_on_you", "awaiting", "answered"]).toContain(one.json.state);
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

// The browser script's store, run on its own: no DOM is touched until a view renders.
// biome-ignore lint/suspicious/noExplicitAny: the script is plain JavaScript
function uiCore(): any {
  const store = new Map<string, string>();
  const ctx = createContext({
    location: { hash: "", pathname: "/" },
    history: { replaceState() {} },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
    document: {},
    Intl,
    setTimeout,
    clearTimeout,
    views: new Map(),
  });
  new Script(
    `${squeeze(CORE)}\nglobalThis.ui = { convState, threadState, flight, S, views };`,
  ).runInContext(ctx);
  return (ctx as { ui: unknown }).ui;
}
const row = (kind: string, ...ds: [string, string][]) => ({
  message: { id: `m${Math.random()}`, kind, from: "alpha" },
  deliveries: ds.map(([to, state], i) => ({ id: i, to, state })),
});

describe("web UI conversation state", () => {
  it("uses the daemon's state when it sends one", () => {
    const ui = uiCore();
    expect(ui.convState({ state: "awaiting", awaiting: ["beta", "gamma"] })).toMatchObject({
      label: "awaiting beta +1",
      cls: "await",
    });
    expect(ui.convState({ state: "held", held: 2 })).toMatchObject({
      label: "2 held",
      cls: "held",
    });
    expect(ui.convState({ state: "waiting_on_you" })).toMatchObject({
      label: "waiting on you",
      cls: "you",
    });
    expect(ui.convState({ state: "answered", needsAnswer: true })).toMatchObject({
      label: "answered",
      cls: "done",
    });
  });

  it("derives the same four states from the messages when the daemon does not", () => {
    const ui = uiCore();
    ui.S.you = { handle: "tester", host: "h" };
    const rows = (...xs: ReturnType<typeof row>[]) =>
      xs.map((x) => ({ m: x.message, ds: x.deliveries }));
    expect(ui.convState({}, rows(row("ask", ["beta", "delivered"]))).label).toBe("awaiting beta");
    expect(ui.convState({}, rows(row("ask", ["@tester", "seen"]))).label).toBe("waiting on you");
    expect(
      ui.convState({}, rows(row("request", ["beta", "held"]), row("ask", ["@tester", "queued"])))
        .label,
    ).toBe("held");
    expect(ui.convState({}, rows(row("ask", ["beta", "replied"]))).label).toBe("answered");
    expect(ui.convState({}, rows(row("info", ["beta", "seen"]))).label).toBe("answered");
    // A hold on a teammate's machine is theirs to decide: here it is awaited, with nothing to review.
    const there = row("ask", ["bob/codex", "held"]);
    (there.deliveries[0] as { method?: string }).method = "relay";
    expect(ui.convState({}, rows(there)).label).toBe("awaiting bob/codex");
    const e = (x: ReturnType<typeof row>) => ({
      m: { ...x.message, createdAt: new Date().toISOString() },
      d: new Map(x.deliveries.map((d) => [d.id, d])),
    });
    expect(ui.flight(e(there)).held).toBe(false);
    expect(ui.flight(e(row("ask", ["beta", "held"]))).held).toBe(true);
    // Without messages, the summary's flags still give one of the four.
    expect(ui.convState({ needsAnswer: true }).st).toBe("waiting_on_you");
    expect(ui.convState({ open: true }).label).toBe("awaiting a reply");
  });

  it("reads a loaded conversation over the viewer's summary flags", () => {
    const ui = uiCore();
    ui.S.threads = [
      { thread: "T1", open: false, needsAnswer: false, waiting: false, participants: [] },
    ];
    expect(ui.threadState("T1").label).toBe("answered");
    ui.views.set("thread/T1", {
      data: { thread: "T1", messages: [row("ask", ["teo/claude-data", "seen"])] },
    });
    expect(ui.threadState("T1")).toMatchObject({ label: "awaiting teo/claude-data", cls: "await" });
    ui.views.get("thread/T1").data.state = "answered";
    expect(ui.threadState("T1").label).toBe("answered");
  });
});
