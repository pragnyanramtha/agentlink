import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sleep, startTestDaemon, type TestDaemon, until } from "../helpers.ts";

type Json = Record<string, unknown>;
interface SendRes {
  message: { id: string; thread: string; kind: string };
  deliveries: { id: number; to: string; state: string; note: string; method?: string }[];
  reply?: { message: { id: string; from: string; kind: string }; text: string; ack?: string };
}

let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon();
});
afterEach(async () => {
  await t.stop();
});

async function register(name: string, tool = "generic", extra: Json = {}) {
  const proc = t.fakeAgentProcess(tool);
  const res = await t.client().request<{ agent: Json }>("POST", "/v1/agents/register", {
    tool,
    name,
    pid: proc.pid,
    ...(proc.start ? { pidStart: proc.start } : {}),
    cwd: t.home,
    ...extra,
  });
  return { proc, agent: res.agent };
}

describe("registry & presence", () => {
  it("registers, lists and renames agents", async () => {
    await register("alpha");
    await register("beta");
    const { agents } = await t.client().request<{ agents: Json[] }>("GET", "/v1/agents");
    expect(agents.map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
    const renamed = await t.client("alpha").request<{ agent: Json }>("POST", "/v1/agents/rename", {
      name: "api-worker",
    });
    expect(renamed.agent.name).toBe("api-worker");
    // an agent cannot rename another one
    const res = await t.raw(
      "POST",
      "/v1/agents/rename",
      { name: "x", agent: "beta" },
      { as: "api-worker" },
    );
    expect(res.status).toBe(403);
  });

  it("marks agents offline when their process dies", async () => {
    const { proc } = await register("alpha");
    proc.kill();
    const offline = await until(async () => {
      const { agents } = await t.client().request<{ agents: Json[] }>("GET", "/v1/agents?all=1");
      return agents.find((a) => a.name === "alpha" && a.state === "offline");
    });
    expect(offline).toBeTruthy();
  });

  it("auto-names agents after tool+repo and takes over offline names", async () => {
    const a = t.fakeAgentProcess("codex");
    const first = await t.hook<Json>(
      "codex",
      "session-start",
      { session_id: "s1", cwd: t.home },
      a,
    );
    expect(first.stdout).toContain("agentlink: you are");
    const agents1 = (await t.client().request<{ agents: Json[] }>("GET", "/v1/agents")).agents;
    const name = String(agents1[0]?.name);
    expect(name).toMatch(/^codex-agentlink-test-/);
    a.kill();
    await until(async () =>
      (await t.client().request<{ agents: Json[] }>("GET", "/v1/agents?all=1")).agents.find(
        (x) => x.state === "offline",
      ),
    );
    // a new codex session in the same place inherits the name (and its queued mail)
    const b = t.fakeAgentProcess("codex");
    await t.hook("codex", "session-start", { session_id: "s2", cwd: t.home }, b);
    const agents2 = (await t.client().request<{ agents: Json[] }>("GET", "/v1/agents")).agents;
    expect(agents2.map((x) => x.name)).toEqual([name]);
  });
});

describe("messaging", () => {
  it("ask blocks until the reply arrives; the reply is not injected twice", async () => {
    await register("alpha");
    await register("beta");
    const asking = t
      .client("alpha")
      .request<SendRes>(
        "POST",
        "/v1/messages",
        { to: ["beta"], kind: "ask", text: "what is the test command?", waitMs: 5_000 },
        { timeoutMs: 10_000 },
      );
    const inbox = await until(async () => {
      const r = await t
        .client("beta")
        .request<{ items: { message: { id: string }; text: string }[] }>("GET", "/v1/inbox");
      return r.items.length ? r.items : undefined;
    });
    expect(inbox?.[0]?.text).toBe("what is the test command?");
    const replied = await t.client("beta").request<SendRes>("POST", "/v1/messages", {
      kind: "reply",
      replyTo: inbox?.[0]?.message.id,
      text: "pnpm test",
    });
    expect(replied.deliveries[0]?.state).toBe("seen");
    expect(replied.deliveries[0]?.note).toContain("waiting");
    const res = await asking;
    expect(res.reply?.text).toBe("pnpm test");
    expect(res.reply?.message.from).toBe("beta");
    // alpha's inbox has nothing unread: the answer came through the long-poll
    const alphaInbox = await t.client("alpha").request<{ items: unknown[] }>("GET", "/v1/inbox");
    expect(alphaInbox.items).toHaveLength(0);
    // receipts on the original
    const shown = await t
      .client()
      .request<{ deliveries: { state: string }[] }>("GET", `/v1/messages/${res.message.id}?peek=1`);
    expect(shown.deliveries[0]?.state).toBe("replied");
  });

  it("reports why a message could not be delivered right away", async () => {
    const { proc } = await register("alpha");
    await register("beta");
    proc.kill();
    await until(async () =>
      (await t.client().request<{ agents: Json[] }>("GET", "/v1/agents?all=1")).agents.find(
        (a) => a.name === "alpha" && a.state === "offline",
      ),
    );
    const res = await t.client("beta").request<SendRes>("POST", "/v1/messages", {
      to: ["alpha"],
      kind: "info",
      text: "heads up: I renamed verifyToken",
    });
    expect(res.deliveries[0]?.state).toBe("queued");
    expect(res.deliveries[0]?.note).toContain("offline");
  });

  it("lets agents message the human and the human read it", async () => {
    await register("alpha");
    const res = await t.client("alpha").request<SendRes>("POST", "/v1/messages", {
      to: ["@tester"],
      text: "done with the migration",
    });
    expect(res.deliveries[0]?.note).toContain("stored for @tester");
    const inbox = await t.client().request<{ items: { text: string }[] }>("GET", "/v1/inbox");
    expect(inbox.items.map((i) => i.text)).toEqual(["done with the migration"]);
  });

  it("rejects unknown recipients and team addresses without a team", async () => {
    await register("alpha");
    const unknown = await t.raw(
      "POST",
      "/v1/messages",
      { to: ["nobody"], text: "hi" },
      { as: "alpha" },
    );
    expect(unknown.status).toBe(404);
    const team = await t.raw(
      "POST",
      "/v1/messages",
      { to: ["bob/codex"], text: "hi" },
      { as: "alpha" },
    );
    expect(team.status).toBe(400);
    const self = await t.raw(
      "POST",
      "/v1/messages",
      { to: ["alpha"], text: "hi" },
      { as: "alpha" },
    );
    expect(self.status).toBe(400);
  });
});

describe("usability fixes", () => {
  it("pause also hides mail from an agent's explicit inbox; you still see yours", async () => {
    await register("alpha");
    await register("beta");
    await t.client("alpha").request("POST", "/v1/messages", { to: ["beta"], text: "while paused" });
    await t.raw("POST", "/v1/control", { action: "pause" }, { as: "alpha" });
    const agentView = await t
      .client("beta")
      .request<{ items: unknown[]; paused?: boolean }>("GET", "/v1/inbox");
    expect(agentView.paused).toBe(true);
    expect(agentView.items).toHaveLength(0);
    const peers = await t.client().request<{ paused: boolean }>("GET", "/v1/agents");
    expect(peers.paused).toBe(true);
    await t.raw("POST", "/v1/control", { action: "resume" }, { tty: true });
    const after = await t.client("beta").request<{ items: { text: string }[] }>("GET", "/v1/inbox");
    expect(after.items.map((i) => i.text)).toEqual(["while paused"]);
  });

  it("rejects unknown policy scopes with a suggestion", async () => {
    const res = await t.raw(
      "POST",
      "/v1/policy",
      { scope: "teamate", kind: "request", action: "hold" },
      { tty: true },
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toContain('did you mean \\"teammate\\"');
  });

  it("suggests close agent names and finds threads by any message id", async () => {
    await register("api");
    await register("web");
    const typo = await t.raw("POST", "/v1/messages", { to: ["apii"], text: "hi" }, { as: "web" });
    expect(typo.status).toBe(404);
    expect(JSON.stringify(typo.data)).toContain('did you mean \\"api\\"');
    const ask = await t
      .client("web")
      .request<SendRes>("POST", "/v1/messages", { to: ["api"], kind: "ask", text: "port?" });
    const reply = await t.client("api").request<SendRes>("POST", "/v1/messages", {
      kind: "reply",
      replyTo: ask.message.id,
      text: "8080",
    });
    const byReply = await t
      .client()
      .request<{ thread: string; messages: unknown[] }>("GET", `/v1/threads/${reply.message.id}`);
    expect(byReply.thread).toBe(ask.message.thread);
    expect(byReply.messages).toHaveLength(2);
    const short = await t.raw("GET", "/v1/messages/01M");
    expect(short.status).toBe(400);
    expect(JSON.stringify(short.data)).toContain("too short");
  });

  it("keeps an agent's sent history across renames and can unregister it", async () => {
    await register("api");
    await register("web");
    await t.client("web").request("POST", "/v1/messages", { to: ["api"], text: "before rename" });
    await t.client("web").request("POST", "/v1/agents/rename", { name: "frontend" });
    const mine = await t
      .client("frontend")
      .request<{ messages: { message: { preview: string } }[] }>("GET", "/v1/log?mine=1");
    expect(mine.messages.map((m) => m.message.preview)).toEqual(["before rename"]);
    await t.client("frontend").request("POST", "/v1/messages", { to: ["api"], text: "second" });
    const removed = await t.client().request<{ removed: string }>("DELETE", "/v1/agents/api");
    expect(removed.removed).toBe("api");
    const agents = await t.client().request<{ agents: Json[] }>("GET", "/v1/agents?all=1");
    expect(agents.agents.map((a) => a.name)).toEqual(["frontend"]);
  });

  it("approves held messages by message id", async () => {
    await register("alpha");
    await register("beta");
    await t.raw(
      "POST",
      "/v1/policy",
      { scope: "local", kind: "request", action: "hold" },
      { tty: true },
    );
    const res = await t
      .client("alpha")
      .request<SendRes>("POST", "/v1/messages", { to: ["beta"], kind: "request", text: "deploy" });
    const ok = await t.raw(
      "POST",
      `/v1/approvals/${res.message.id.slice(0, 10)}`,
      { decision: "approve" },
      { tty: true },
    );
    expect(ok.status).toBe(200);
    const inbox = await t.client("beta").request<{ items: { text: string }[] }>("GET", "/v1/inbox");
    expect(inbox.items.map((i) => i.text)).toEqual(["deploy"]);
  });
});

describe("usability fixes, round 2", () => {
  it("only recipients answer, and a handoff gets one final decision", async () => {
    await register("lead");
    await register("dev");
    await register("bystander");
    const handoff = await t.client("lead").request<SendRes>("POST", "/v1/messages", {
      to: ["dev"],
      kind: "handoff",
      text: "take over the auth refactor",
    });
    const stranger = await t.raw(
      "POST",
      `/v1/messages/${handoff.message.id}/ack`,
      { ack: "accept" },
      { as: "bystander" },
    );
    expect(stranger.status).toBe(403);
    const ok = await t.raw(
      "POST",
      `/v1/messages/${handoff.message.id}/ack`,
      { ack: "accept" },
      { as: "dev" },
    );
    expect(ok.status).toBe(200);
    const flip = await t.raw(
      "POST",
      `/v1/messages/${handoff.message.id}/ack`,
      { ack: "decline" },
      { as: "dev" },
    );
    expect(flip.status).toBe(400);
    expect(JSON.stringify(flip.data)).toContain("already accepted");
  });

  it("thread --allow also lifts the reply-depth limit", async () => {
    await register("a1");
    await register("b1");
    let last = await t
      .client("a1")
      .request<SendRes>("POST", "/v1/messages", { to: ["b1"], kind: "ask", text: "step 0" });
    let nextReplier = "b1";
    let refused: { status: number; data: unknown } | undefined;
    for (let i = 1; i <= 14; i++) {
      const res = await t.raw<SendRes>(
        "POST",
        "/v1/messages",
        { kind: "reply", replyTo: last.message.id, text: `step ${i}` },
        { as: nextReplier },
      );
      if (res.status !== 200) {
        refused = res;
        break;
      }
      last = res.data;
      nextReplier = nextReplier === "b1" ? "a1" : "b1";
    }
    expect(refused?.status).toBe(429);
    expect(JSON.stringify(refused?.data)).toContain("--allow");
    await t.raw("POST", `/v1/threads/${last.message.thread}/allow`, { extra: 5 }, { tty: true });
    const next = await t.raw(
      "POST",
      "/v1/messages",
      { kind: "reply", replyTo: last.message.id, text: "after allow" },
      { as: nextReplier },
    );
    expect(next.status).toBe(200);
  });

  it("an ask to several agents waits for every answer", async () => {
    await register("asker");
    await register("r1");
    await register("r2");
    const asking = t
      .client("asker")
      .request<SendRes & { replies?: { text: string }[] }>(
        "POST",
        "/v1/messages",
        { to: ["r1", "r2"], kind: "ask", text: "ready?", waitMs: 8_000 },
        { timeoutMs: 12_000 },
      );
    const id = await until(async () => {
      const r = await t
        .client("r1")
        .request<{ items: { message: { id: string } }[] }>("GET", "/v1/inbox?peek=1");
      return r.items[0]?.message.id;
    });
    await t
      .client("r1")
      .request("POST", "/v1/messages", { kind: "reply", replyTo: id, text: "r1 ready" });
    await t
      .client("r2")
      .request("POST", "/v1/messages", { kind: "reply", replyTo: id, text: "r2 ready" });
    const res = await asking;
    expect(res.replies?.map((r) => r.text).sort()).toEqual(["r1 ready", "r2 ready"]);
  });

  it("register --pid rejects dead processes and uses the process's own directory", async () => {
    const dead = await t.raw("POST", "/v1/agents/register", {
      tool: "generic",
      name: "ghost",
      pid: 2 ** 22 + 4321,
    });
    expect(dead.status).toBe(400);
    const proc = t.fakeAgentProcess("generic");
    const res = await t
      .client()
      .request<{ agent: { cwd: string } }>("POST", "/v1/agents/register", {
        tool: "generic",
        name: "cwdcheck",
        pid: proc.pid,
        cwd: "/definitely/not/here",
      });
    expect(res.agent.cwd).not.toBe("/definitely/not/here");
  });
});

describe("guards", () => {
  it("stops echo loops and caps threads", async () => {
    await register("alpha");
    await register("beta");
    const first = await t.client("alpha").request<SendRes>("POST", "/v1/messages", {
      to: ["beta"],
      kind: "ask",
      text: "ping",
    });
    const thread = first.message.thread;
    const echo = await t.raw(
      "POST",
      "/v1/messages",
      { to: ["alpha"], kind: "ask", text: "Ping!", thread },
      { as: "beta" },
    );
    expect(echo.status).toBe(429);
    expect(JSON.stringify(echo.data)).toContain("echo");
    let status = 200;
    for (let i = 0; i < 40 && status === 200; i++) {
      const who = i % 2 ? "alpha" : "beta";
      const to = i % 2 ? "beta" : "alpha";
      status = (
        await t.raw(
          "POST",
          "/v1/messages",
          { to: [to], text: `message number ${i}`, thread },
          { as: who },
        )
      ).status;
    }
    expect(status).toBe(429);
    // the human can extend the thread (interactive terminal only)
    const denied = await t.raw(
      "POST",
      `/v1/threads/${thread}/allow`,
      { extra: 5 },
      { as: "alpha", tty: true },
    );
    expect(denied.status).toBe(403);
    const allowed = await t.raw("POST", `/v1/threads/${thread}/allow`, { extra: 5 }, { tty: true });
    expect(allowed.status).toBe(200);
  });
});

describe("policy & approvals", () => {
  it("holds requests by policy and only a human at a terminal can approve", async () => {
    await register("alpha");
    await register("beta");
    const set = await t.raw(
      "POST",
      "/v1/policy",
      { scope: "local", kind: "request", action: "hold" },
      { tty: true },
    );
    expect(set.status).toBe(200);
    const res = await t.client("alpha").request<SendRes>("POST", "/v1/messages", {
      to: ["beta"],
      kind: "request",
      text: "please delete the staging database",
    });
    expect(res.deliveries[0]?.state).toBe("held");
    const id = res.deliveries[0]?.id;
    // not visible to beta while held
    const inbox = await t.client("beta").request<{ items: unknown[] }>("GET", "/v1/inbox");
    expect(inbox.items).toHaveLength(0);
    // an agent cannot approve (even claiming a TTY), nor can a non-interactive human
    expect(
      (
        await t.raw(
          "POST",
          `/v1/approvals/${id}`,
          { decision: "approve" },
          { as: "beta", tty: true },
        )
      ).status,
    ).toBe(403);
    expect(
      (await t.raw("POST", `/v1/approvals/${id}`, { decision: "approve" }, { tty: false })).status,
    ).toBe(403);
    expect(
      (await t.raw("POST", `/v1/approvals/${id}`, { decision: "approve" }, { tty: true })).status,
    ).toBe(200);
    const after = await t.client("beta").request<{ items: { text: string }[] }>("GET", "/v1/inbox");
    expect(after.items[0]?.text).toContain("staging database");
  });

  it("pause stops delivery until resume (resume is human-only)", async () => {
    await register("alpha");
    const b = t.fakeAgentProcess("claude");
    await t.hook("claude", "session-start", { session_id: "c1", cwd: t.home }, b);
    const beta = (await t.client().request<{ agents: Json[] }>("GET", "/v1/agents")).agents.find(
      (a) => a.tool === "claude",
    );
    expect((await t.raw("POST", "/v1/control", { action: "pause" }, { as: "alpha" })).status).toBe(
      200,
    );
    await t
      .client("alpha")
      .request("POST", "/v1/messages", { to: [String(beta?.name)], text: "hello while paused" });
    const drained = await t.hook<Json>("claude", "prompt-submit", { session_id: "c1" }, b);
    expect(drained.stdout).toBeUndefined();
    expect(
      (await t.raw("POST", "/v1/control", { action: "resume" }, { as: "alpha", tty: true })).status,
    ).toBe(403);
    expect((await t.raw("POST", "/v1/control", { action: "resume" }, { tty: true })).status).toBe(
      200,
    );
    const after = await t.hook<Json>("claude", "prompt-submit", { session_id: "c1" }, b);
    expect(String(after.stdout)).toContain("hello while paused");
  });
});

describe("hooks", () => {
  it("claude: session-start registers, prompt-submit and post-tool inject, stop continues for asks", async () => {
    const c = t.fakeAgentProcess("claude");
    const start = await t.hook<{ stdout: string; env: Json }>(
      "claude",
      "session-start",
      { session_id: "abc", cwd: t.home },
      c,
    );
    const startOut = JSON.parse(start.stdout);
    expect(startOut.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(startOut.hookSpecificOutput.additionalContext).toContain("you are");
    expect(start.env.AGENTLINK_AGENT).toBeTruthy();
    const me = (await t.client().request<{ agents: Json[] }>("GET", "/v1/agents")).agents[0];
    expect(me?.state).toBe("idle");
    await register("alpha");

    // idle + info → delivered at next turn (prompt-submit)
    const info = await t
      .client("alpha")
      .request<SendRes>("POST", "/v1/messages", { to: [String(me?.name)], text: "fyi one" });
    expect(info.deliveries[0]?.note).toContain("next starts a turn");
    const submit = await t.hook<{ stdout: string }>(
      "claude",
      "prompt-submit",
      { session_id: "abc" },
      c,
    );
    const submitOut = JSON.parse(submit.stdout);
    expect(submitOut.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(submitOut.hookSpecificOutput.additionalContext).toContain("fyi one");
    expect(submitOut.hookSpecificOutput.additionalContext).toMatch(/<agentlink-msg-[a-z0-9]+ /);

    // busy + ask → injected at the next tool call
    const ask = await t.client("alpha").request<SendRes>("POST", "/v1/messages", {
      to: [String(me?.name)],
      kind: "ask",
      text: "which port does the api use?",
    });
    expect(ask.deliveries[0]?.note).toContain("next tool call");
    expect(existsSync(join(t.paths.pendingDir, `pid-${c.pid}`))).toBe(true);
    const post = await t.hook<{ stdout: string }>(
      "claude",
      "post-tool",
      { session_id: "abc", tool_name: "Bash" },
      c,
    );
    expect(JSON.parse(post.stdout).hookSpecificOutput.additionalContext).toContain("which port");
    await until(() => !existsSync(join(t.paths.pendingDir, `pid-${c.pid}`)));
    const quiet = await t.hook<Json>("claude", "post-tool", { session_id: "abc" }, c);
    expect(quiet.stdout).toBeUndefined();

    // an ask arriving after the last tool call keeps the agent going at Stop
    await t.client("alpha").request("POST", "/v1/messages", {
      to: [String(me?.name)],
      kind: "ask",
      text: "one more question?",
    });
    const stop = await t.hook<{ stdout: string }>("claude", "stop", { session_id: "abc" }, c);
    const stopOut = JSON.parse(stop.stdout);
    expect(stopOut.decision).toBe("block");
    expect(stopOut.reason).toContain("one more question?");
    // info does not keep it going
    await t
      .client("alpha")
      .request("POST", "/v1/messages", { to: [String(me?.name)], text: "just fyi" });
    const stop2 = await t.hook<Json>("claude", "stop", { session_id: "abc" }, c);
    expect(stop2.stdout).toBeUndefined();

    await t.hook("claude", "session-end", { session_id: "abc" }, c);
    const end = (
      await t.client().request<{ agents: Json[] }>("GET", "/v1/agents?all=1")
    ).agents.find((a) => a.tool === "claude");
    expect(end?.state).toBe("offline");
  });

  it("delivers mail queued while offline when the session resumes", async () => {
    const c = t.fakeAgentProcess("claude");
    await t.hook("claude", "session-start", { session_id: "sess-1", cwd: t.home }, c);
    const name = String(
      (await t.client().request<{ agents: Json[] }>("GET", "/v1/agents")).agents[0]?.name,
    );
    await t.hook("claude", "session-end", { session_id: "sess-1" }, c);
    await register("alpha");
    const sent = await t
      .client("alpha")
      .request<SendRes>("POST", "/v1/messages", { to: [name], kind: "ask", text: "are you back?" });
    expect(sent.deliveries[0]?.note).toContain("offline");
    const resumed = await t.hook<{ stdout: string }>(
      "claude",
      "session-start",
      { session_id: "sess-1", cwd: t.home, source: "resume" },
      c,
    );
    expect(JSON.parse(resumed.stdout).hookSpecificOutput.additionalContext).toContain(
      "are you back?",
    );
  });

  it("identifies the real CLI when another tool's hook config fires, and drops the duplicate", async () => {
    // Devin CLI also runs hooks from ~/.claude/settings.json.
    const d = t.fakeAgentProcess("devin");
    const viaClaudeConfig = await t.hook<{ stdout?: string }>(
      "claude",
      "session-start",
      { session_id: "dv1", cwd: t.home },
      d,
      "/usr/local/bin/devin",
    );
    const viaDevinConfig = await t.hook<{ stdout?: string }>(
      "devin",
      "session-start",
      { session_id: "dv1", cwd: t.home },
      d,
      "/usr/local/bin/devin",
    );
    expect(
      JSON.parse(String(viaClaudeConfig.stdout)).hookSpecificOutput.additionalContext,
    ).toContain("(Devin)");
    expect(viaDevinConfig.stdout).toBeUndefined();
    const agents = (await t.client().request<{ agents: Json[] }>("GET", "/v1/agents")).agents;
    expect(agents.map((a) => a.tool)).toEqual(["devin"]);
  });

  it("agy: PreInvocation injects via injectSteps and Stop continues with decision=continue", async () => {
    const g = t.fakeAgentProcess("agy");
    await t.hook("agy", "pre-model", { conversationId: "conv-1", workspacePaths: [t.home] }, g);
    const name = String(
      (await t.client().request<{ agents: Json[] }>("GET", "/v1/agents")).agents[0]?.name,
    );
    expect(name).toMatch(/^agy-/);
    await register("alpha");
    await t
      .client("alpha")
      .request("POST", "/v1/messages", { to: [name], kind: "ask", text: "status of the build?" });
    const pre = await t.hook<{ stdout: string }>(
      "agy",
      "pre-model",
      { conversationId: "conv-1" },
      g,
    );
    expect(JSON.parse(pre.stdout).injectSteps[0].ephemeralMessage).toContain(
      "status of the build?",
    );
    await t
      .client("alpha")
      .request("POST", "/v1/messages", { to: [name], kind: "ask", text: "and the tests?" });
    const stop = await t.hook<{ stdout: string }>("agy", "stop", { conversationId: "conv-1" }, g);
    expect(JSON.parse(stop.stdout)).toMatchObject({ decision: "continue" });
    expect(JSON.parse(stop.stdout).reason).toContain("and the tests?");
  });

  it("cursor: postToolUse injects additional_context and stop uses followup_message", async () => {
    const k = t.fakeAgentProcess("cursor-agent");
    await t.hook(
      "cursor",
      "session-start",
      { session_id: "cur-1", workspace_roots: [t.home] },
      k,
      "/usr/local/bin/cursor-agent",
    );
    const name = String(
      (await t.client().request<{ agents: Json[] }>("GET", "/v1/agents")).agents[0]?.name,
    );
    await register("alpha");
    await t
      .client("alpha")
      .request("POST", "/v1/messages", { to: [name], kind: "ask", text: "which branch?" });
    const post = await t.hook<{ stdout: string }>(
      "cursor",
      "post-tool",
      { conversation_id: "cur-1" },
      k,
      "/usr/local/bin/cursor-agent",
    );
    expect(JSON.parse(post.stdout).additional_context).toContain("which branch?");
    await t
      .client("alpha")
      .request("POST", "/v1/messages", { to: [name], kind: "ask", text: "and the commit?" });
    const stop = await t.hook<{ stdout: string }>(
      "cursor",
      "stop",
      { conversation_id: "cur-1" },
      k,
      "/usr/local/bin/cursor-agent",
    );
    expect(JSON.parse(stop.stdout).followup_message).toContain("and the commit?");
  });

  it("stop continuation is capped to avoid loops", async () => {
    const c = t.fakeAgentProcess("claude");
    await t.hook("claude", "session-start", { session_id: "loop", cwd: t.home }, c);
    const name = String(
      (await t.client().request<{ agents: Json[] }>("GET", "/v1/agents")).agents[0]?.name,
    );
    await register("alpha");
    let blocks = 0;
    for (let i = 0; i < 5; i++) {
      await t
        .client("alpha")
        .request("POST", "/v1/messages", { to: [name], kind: "ask", text: `question ${i}` });
      const r = await t.hook<Json>("claude", "stop", { session_id: "loop" }, c);
      if (r.stdout) blocks++;
    }
    expect(blocks).toBe(3);
  });
});

describe("opencode bridge", () => {
  it("pushes messages into a polling plugin and marks them seen on ack", async () => {
    const o = t.fakeAgentProcess("opencode");
    const reg = await t.client().request<{ agent: Json }>("POST", "/v1/agents/register", {
      tool: "opencode",
      sessionId: "ses_1",
      pid: o.pid,
      cwd: t.home,
      capabilities: { push: true, wake: true, nextTurn: true },
      state: "idle",
    });
    const agentId = String(reg.agent.id);
    const poll = t
      .client()
      .request<{ push: { token: string; text: string } | null }>(
        "GET",
        `/v1/adapters/opencode/poll?agent=${agentId}&timeoutMs=5000`,
        undefined,
        { timeoutMs: 8_000 },
      );
    await sleep(100);
    await register("alpha");
    const sent = await t.client("alpha").request<SendRes>("POST", "/v1/messages", {
      to: [String(reg.agent.name)],
      kind: "ask",
      text: "can you run the e2e suite?",
    });
    expect(sent.deliveries[0]?.note).toContain("opencode-plugin");
    const { push } = await poll;
    expect(push?.text).toContain("can you run the e2e suite?");
    await t.client().request("POST", "/v1/adapters/opencode/ack", { token: push?.token, ok: true });
    const receipt = await until(async () => {
      const r = await t
        .client()
        .request<{ deliveries: { state: string; method: string }[] }>(
          "GET",
          `/v1/messages/${sent.message.id}?peek=1`,
        );
      return r.deliveries[0]?.state === "seen" ? r.deliveries[0] : undefined;
    });
    expect(receipt?.method).toContain("opencode-plugin");
  });
});

describe("claims", () => {
  it("reports overlapping claims by other agents in the same repo", async () => {
    await register("alpha");
    await register("beta");
    await t
      .client("alpha")
      .request("POST", "/v1/claims", { patterns: ["src/auth/**"], reason: "refactor" });
    const res = await t
      .client("beta")
      .request<{ conflicts: { agent: string; pattern: string }[] }>("POST", "/v1/claims", {
        patterns: ["src/auth/token.ts"],
      });
    expect(res.conflicts.map((c) => c.agent)).toEqual(["alpha"]);
    const released = await t
      .client("alpha")
      .request<{ released: number }>("POST", "/v1/claims/release", {});
    expect(released.released).toBe(1);
  });
});

describe("expiry", () => {
  it("expires undelivered mail and tells the sender", async () => {
    const { proc } = await register("alpha");
    await register("beta");
    proc.kill();
    await t
      .client("beta")
      .request("POST", "/v1/messages", { to: ["alpha"], text: "short lived", ttlMs: 1 });
    await sleep(20);
    const expired = t.daemon.services.mailbox.expireSweep();
    expect(expired).toBe(1);
    const inbox = await t
      .client("beta")
      .request<{ items: { text: string; message: { from: string } }[] }>("GET", "/v1/inbox");
    expect(inbox.items[0]?.message.from).toBe("agentlink");
    expect(inbox.items[0]?.text).toContain("expired undelivered");
    expect(readdirSync(t.paths.pendingDir).length).toBeGreaterThanOrEqual(0);
  });
});
