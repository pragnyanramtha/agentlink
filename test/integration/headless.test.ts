import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newEnvelope } from "../../src/core/envelope.ts";
import { isAlive, procInfo } from "../../src/core/proc.ts";
import { type FakeBins, fakeBins } from "../headless-fakes.ts";
import { startTestDaemon, type TestDaemon, until } from "../helpers.ts";

type Json = Record<string, unknown>;
interface Run {
  id: string;
  state: string;
  agent: string;
  kind: string;
  argv: string[] | null;
  pid: number | null;
  note: string | null;
  result: string | null;
  costUsd: number | null;
  tokens: { in: number; out: number } | null;
  denials: number | null;
}

const SESSION = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const CLAUDE_SESSION = "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f";
const human = { tty: true };
let t: TestDaemon;
let bins: FakeBins;

beforeEach(async () => {
  bins = fakeBins();
  t = await startTestDaemon();
});
afterEach(async () => {
  await t.stop();
  bins.cleanup();
});

async function setup(harness = "codex", extra: Json = {}) {
  for (const body of [
    { enabled: true },
    { runner: { harness, enabled: true, ...extra } },
    { addRoot: t.home },
  ]) {
    const res = await t.raw("POST", "/v1/headless", body, human);
    expect(res.status, JSON.stringify(res.data)).toBe(200);
  }
}

/** An agent whose session ended (offline), with a session id it can be resumed by. */
function offlineAgent(name: string, tool = "codex", sessionId = SESSION) {
  return t.daemon.services.registry.register({
    tool,
    name,
    sessionId,
    cwd: t.home,
    state: "offline",
  }).agent;
}

async function asker(name = "asker") {
  const proc = t.fakeAgentProcess("generic");
  await t.client().request("POST", "/v1/agents/register", {
    tool: "generic",
    name,
    pid: proc.pid,
    ...(proc.start ? { pidStart: proc.start } : {}),
    cwd: t.home,
  });
  return proc;
}

const runs = async () => (await t.raw<{ runs: Run[] }>("GET", "/v1/runs")).data.runs;
const runEnded = (id: string) =>
  until(async () => {
    const run = (await runs()).find((r) => r.id === id);
    return run && ["done", "failed", "stopped", "denied"].includes(run.state) ? run : undefined;
  }, 8_000);
const running = (id: string) =>
  until(async () => {
    const run = (await runs()).find((r) => r.id === id);
    return run?.pid && bins.read(id, "stdin") !== undefined ? run : undefined;
  }, 8_000);
const deliveryState = (messageId: string, to: string) =>
  t.daemon.services.mailbox.deliveriesOf(messageId).find((d) => d.to_addr === to)?.state;

describe("headless runs", () => {
  it("are off by default: an offline agent's mail just waits", async () => {
    offlineAgent("codex-api");
    await asker();
    const res = await t.raw<{ deliveries: { note: string }[] }>(
      "POST",
      "/v1/messages",
      { to: ["codex-api"], kind: "ask", text: "what is the test command?" },
      { as: "asker" },
    );
    expect(res.data.deliveries[0]?.note).toMatch(/offline.*gets the message when it is back/);
    expect(await runs()).toEqual([]);
    const cfg = await t.raw<{ enabled: boolean; runners: { enabled: boolean }[] }>(
      "GET",
      "/v1/headless",
    );
    expect(cfg.data.enabled).toBe(false);
    expect(cfg.data.runners.every((r) => !r.enabled)).toBe(true);
  });

  it("resumes an offline codex agent for an ask and posts its answer in the thread", async () => {
    await setup("codex");
    offlineAgent("codex-api");
    await asker();
    const res = await t.raw<{
      deliveries: { note: string }[];
      reply?: { text: string; message: { from: string } };
      message: { id: string };
    }>(
      "POST",
      "/v1/messages",
      { to: ["codex-api"], kind: "ask", text: "what is the test command?", waitMs: 8_000 },
      { as: "asker" },
    );
    expect(res.data.deliveries[0]?.note).toMatch(/waking it headlessly \(codex exec resume/);
    expect(res.data.reply?.text).toBe("the answer is 42");
    expect(res.data.reply?.message.from).toBe("codex-api");
    const run = (await runEnded("R1")) as Run;
    expect(run).toMatchObject({ state: "done", kind: "wake", costUsd: null });
    expect(run.tokens).toEqual({ in: 10, out: 5 });
    expect(run.result).toBeTruthy();
    const argv = bins.argv("R1");
    expect(argv).toEqual([
      "exec",
      "resume",
      "--json",
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="read-only"',
      SESSION,
      "-",
    ]);
    // The prompt goes on stdin (never argv), wrapped with provenance like any delivery.
    expect(bins.read("R1", "stdin")).toContain("what is the test command?");
    expect(bins.read("R1", "stdin")).toContain("<agentlink-msg");
    expect(argv.join(" ")).not.toContain("test command");
    expect(bins.read("R1", "cwd")?.trim()).toBe(t.home);
    const env = bins.read("R1", "env") ?? "";
    expect(env).toContain(`AGENTLINK_HOME=${t.home}`);
    expect(env).toContain("AGENTLINK_RUN=R1");
    expect(deliveryState(res.data.message.id, "codex-api")).toBe("replied");
    // The run is over: the agent is offline again.
    expect(t.daemon.services.registry.byName("codex-api")?.state).toBe("offline");
  });

  it("spawns a new claude agent for a task; the answer comes back like an ask", async () => {
    await setup("claude");
    const res = await t.raw<{
      agent: { name: string; sessionId: string };
      run: Run;
      reply?: { text: string };
      note: string;
    }>("POST", "/v1/spawn", {
      harness: "claude",
      cwd: t.home,
      task: "summarise the README",
      waitMs: 8_000,
    });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.note).toMatch(/starting .* headlessly \(claude -p, read-only, R1\)/);
    expect(res.data.reply?.text).toBe("the answer is 42");
    const argv = bins.argv("R1");
    const sid = argv[argv.indexOf("--session-id") + 1] as string;
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 4),
    ).toEqual(["--permission-mode", "dontAsk", "--permission-prompts", "none"]);
    const agent = t.daemon.services.registry.byName(res.data.agent.name);
    expect(agent?.session_id).toBe(sid);
    expect(t.daemon.services.registry.spawnDepth(agent?.id as string)).toEqual({
      by: "@tester",
      depth: 1,
    });
    const run = (await runEnded("R1")) as Run;
    expect(run.costUsd).toBe(0.01);
    expect(run.denials).toBe(1);
    // A spawned agent cannot spawn others (depth 1).
    const again = await t.raw(
      "POST",
      "/v1/spawn",
      { harness: "claude", cwd: t.home, task: "and another" },
      { as: res.data.agent.name },
    );
    expect(again.status).toBe(403);
    expect(JSON.stringify(again.data)).toMatch(/cannot spawn others/);
  });

  it("refuses folders outside the allowed roots, and unknown request fields", async () => {
    await setup("claude");
    const elsewhere = mkdtempSync(join(tmpdir(), "agentlink-outside-"));
    try {
      const res = await t.raw("POST", "/v1/spawn", {
        harness: "claude",
        cwd: elsewhere,
        task: "x",
      });
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.data)).toMatch(/outside the folders allowed/);
      const raised = await t.raw("POST", "/v1/spawn", {
        harness: "claude",
        cwd: t.home,
        task: "x",
        profile: "full",
      });
      expect(raised.status).toBe(400);
      const flag = await t.raw("POST", "/v1/spawn", {
        harness: "claude",
        cwd: t.home,
        task: "x",
        model: "--dangerously-skip-permissions",
      });
      expect(flag.status).toBe(400);
      expect(await runs()).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("holds a teammate's wake until a person approves it, then runs it", async () => {
    await setup("codex");
    offlineAgent("codex-api");
    const { mailbox, engine } = t.daemon.services;
    const env = newEnvelope({
      kind: "ask",
      from: { member: "alice", agent: "claude-web", role: "agent" },
      to: [{ member: "tester", agent: "codex-api", role: "agent" }],
      parts: [{ kind: "text", text: "is /v2 deployed?" }],
    });
    const received = mailbox.receiveRemote(env, "alice");
    const notes = engine.onQueued(received.queued);
    expect([...notes.values()][0]).toMatch(/held: waking codex-api headlessly needs a person/);
    expect((await runs())[0]?.state).toBe("held");
    const approvals = await t.raw<{ items: { delivery: { id: string }; message: Json }[] }>(
      "GET",
      "/v1/approvals",
    );
    expect(approvals.data.items.map((i) => i.delivery.id)).toEqual(["R1"]);
    expect(approvals.data.items[0]?.message).toMatchObject({ from: "alice/claude-web" });
    // Approving needs a person at a terminal, like any approval.
    expect((await t.raw("POST", "/v1/approvals/R1", { decision: "approve" })).status).toBe(403);
    const ok = await t.raw("POST", "/v1/approvals/r1", { decision: "approve" }, human);
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    const run = (await runEnded("R1")) as Run;
    expect(run.state).toBe("done");
    expect(bins.read("R1", "stdin")).toContain("is /v2 deployed?");
  });

  it("caps wakes per teammate and hour (wake.perRemoteSenderPerHour)", async () => {
    await setup("codex");
    await t.raw("POST", "/v1/headless", { set: { "teammate.wake": "allow" } }, human);
    t.daemon.services.ctx.config.wake.perRemoteSenderPerHour = 1;
    offlineAgent("codex-api");
    const { mailbox, engine } = t.daemon.services;
    const ask = (text: string) => {
      const env = newEnvelope({
        kind: "ask",
        from: { member: "alice", agent: "claude-web", role: "agent" },
        to: [{ member: "tester", agent: "codex-api", role: "agent" }],
        parts: [{ kind: "text", text }],
      });
      return [...engine.onQueued(mailbox.receiveRemote(env, "alice").queued).values()][0];
    };
    expect(ask("first?")).toMatch(/waking it headlessly/);
    await runEnded("R1");
    expect(ask("second?")).toMatch(/offline \(last seen/);
    expect((await runs()).length).toBe(1);
  });

  it("enforces the per-agent budget", async () => {
    await setup("codex");
    await t.raw("POST", "/v1/headless", { set: { perAgentPerHour: 1 } }, human);
    offlineAgent("codex-api");
    await asker();
    const first = await t.raw<{ note: string }>(
      "POST",
      "/v1/wake",
      { agent: "codex-api", text: "first" },
      { as: "asker" },
    );
    expect(first.data.note).toMatch(/waking it headlessly/);
    await runEnded("R1");
    const second = await t.raw<{ note: string }>(
      "POST",
      "/v1/wake",
      { agent: "codex-api", text: "second" },
      { as: "asker" },
    );
    expect(second.data.note).toMatch(
      /not woken \(headless runs per agent and hour used up \(1\/1\)\)/,
    );
  });

  it("pause interrupts a running run; its mail goes back to the queue", async () => {
    await setup("codex");
    bins.mode("sleep");
    offlineAgent("codex-api");
    await asker();
    const sent = await t.raw<{ message: { id: string } }>(
      "POST",
      "/v1/wake",
      { agent: "codex-api", text: "long job" },
      { as: "asker" },
    );
    await running("R1");
    expect(deliveryState(sent.data.message.id, "codex-api")).toBe("delivered");
    // Any agent may pause (resume needs a person).
    expect((await t.raw("POST", "/v1/control", { action: "pause" }, { as: "asker" })).status).toBe(
      200,
    );
    const run = (await runEnded("R1")) as Run;
    expect(run.state).toBe("stopped");
    expect(run.note).toMatch(/paused/);
    expect(bins.read("R1", "sig")?.trim()).toBe("INT");
    expect(deliveryState(sent.data.message.id, "codex-api")).toBe("queued");
    // Paused: no new runs.
    const blocked = await t.raw<{ note: string }>(
      "POST",
      "/v1/wake",
      { agent: "codex-api", text: "again" },
      { as: "asker" },
    );
    expect(blocked.data.note).toMatch(/paused/);
    expect((await runs()).length).toBe(1);
  });

  it("hands the batch to the run, so the session's own start hook does not inject it again", async () => {
    await setup("codex");
    bins.mode("sleep");
    offlineAgent("codex-api");
    await asker();
    await t.raw(
      "POST",
      "/v1/wake",
      { agent: "codex-api", text: "unique-question-xyz" },
      { as: "asker" },
    );
    const run = (await running("R1")) as Run;
    const pid = run.pid as number;
    const start = procInfo(pid)?.start;
    const before = t.daemon.services.registry.list({ includeOffline: true }).length;
    const out = await t.hook<{ stdout?: string }>(
      "codex",
      "session-start",
      { session_id: SESSION, cwd: t.home },
      { pid, ...(start ? { start } : {}) },
    );
    expect(out.stdout ?? "").toContain("you are codex-api");
    // Only listed in its conversation index, not injected again as a message.
    expect(out.stdout ?? "").not.toContain("<agentlink-msg");
    const id = t.daemon.services.registry.byName("codex-api")?.id as string;
    const [d] = t.daemon.services.mailbox.inbox({ agent: { id } as never }, { unreadOnly: true });
    expect(d?.delivery).toMatchObject({ state: "delivered", method: "headless:codex" });
    // Same agent, not a second one.
    expect(t.daemon.services.registry.list({ includeOffline: true }).length).toBe(before);
    // Messages the run sends count one hop further.
    const res = await t.raw<{ message: { id: string } }>(
      "POST",
      "/v1/messages",
      { to: ["asker"], kind: "info", text: "working on it" },
      { as: "codex-api" },
    );
    const sent = t.daemon.services.mailbox.resolveMessage(res.data.message.id);
    expect(t.daemon.services.mailbox.envelopeOf(sent).meta.hops).toBe(1);
    const stopped = await t.raw<{ run: Run }>("POST", "/v1/runs/R1/stop", {}, { as: "asker" });
    expect(stopped.status).toBe(200);
    expect((await runEnded("R1"))?.state).toBe("stopped");
  });

  it("a run that fails before starting puts the mail back", async () => {
    await setup("opencode");
    bins.mode("fail");
    offlineAgent("opencode-web", "opencode", "ses_previous0001");
    await asker();
    const sent = await t.raw<{ message: { id: string } }>(
      "POST",
      "/v1/wake",
      { agent: "opencode-web", text: "hello" },
      { as: "asker" },
    );
    const run = (await runEnded("R1")) as Run;
    expect(run.state).toBe("failed");
    expect(run.note).toContain("not logged in");
    expect(deliveryState(sent.data.message.id, "opencode-web")).toBe("queued");
    expect(bins.argv("R1")).toEqual([
      "run",
      "--format",
      "json",
      "--dir",
      t.home,
      "--session",
      "ses_previous0001",
      "--agent",
      "plan",
    ]);
    expect(bins.read("R1", "env")).toContain(
      'OPENCODE_PERMISSION={"edit":"deny","bash":"deny","webfetch":"deny"}',
    );
  });

  it("runs at most maxConcurrent at a time; the next one starts when a slot frees", async () => {
    await setup("codex");
    await t.raw("POST", "/v1/headless", { set: { maxConcurrent: 1 } }, human);
    bins.mode("sleep");
    offlineAgent("codex-a");
    offlineAgent("codex-b", "codex", "0199a213-81c0-7800-8aa1-bbab2a035a54");
    await asker();
    await t.raw("POST", "/v1/wake", { agent: "codex-a", text: "one" }, { as: "asker" });
    await t.raw("POST", "/v1/wake", { agent: "codex-b", text: "two" }, { as: "asker" });
    await running("R1");
    expect((await runs()).find((r) => r.id === "R2")?.state).toBe("queued");
    await t.raw("POST", "/v1/runs/codex-a/stop", {}, human);
    await running("R2");
    await t.raw("POST", "/v1/runs/R2/stop", {}, human);
    expect((await runEnded("R2"))?.state).toBe("stopped");
  });

  it("a spawn an agent asks for can be held for a person, who may deny it", async () => {
    await setup("codex");
    await t.raw("POST", "/v1/headless", { set: { "local.spawn": "hold" } }, human);
    await asker();
    const res = await t.raw<{ run: Run; note: string }>(
      "POST",
      "/v1/spawn",
      { harness: "codex", cwd: t.home, task: "look around" },
      { as: "asker" },
    );
    expect(res.data.run.state).toBe("held");
    expect(res.data.note).toMatch(/held: starting .* needs a person's approval/);
    expect((await t.raw("POST", "/v1/approvals/R1", { decision: "deny" }, human)).status).toBe(200);
    expect((await runs())[0]?.state).toBe("denied");
    expect(bins.read("R1", "argv")).toBeUndefined();
  });

  it("kills what a run left in its process group, even if it ignores SIGTERM", async () => {
    await setup("codex");
    bins.mode("orphan");
    offlineAgent("codex-api");
    await asker();
    await t.raw("POST", "/v1/wake", { agent: "codex-api", text: "hi" }, { as: "asker" });
    const orphan = Number(await until(() => bins.read("R1", "orphan")?.trim(), 8_000));
    expect(isAlive(orphan)).toBe(true);
    const run = (await runEnded("R1")) as Run;
    expect(run.state).toBe("done");
    expect(await until(() => !isAlive(orphan), 3_000)).toBe(true);
  });

  it("a daemon that stops while a run is starting leaves no run 'running'", async () => {
    await setup("claude");
    bins.mode("slow-agents");
    offlineAgent("claude-api", "claude", CLAUDE_SESSION);
    await asker();
    await t.raw("POST", "/v1/wake", { agent: "claude-api", text: "hi" }, { as: "asker" });
    expect(await until(() => existsSync(join(bins.dir, "agents-called")), 8_000)).toBe(true);
    expect((await runs())[0]?.state).toBe("running");
    await t.stop(true);
    const db = new DatabaseSync(t.paths.db, { readOnly: true });
    try {
      expect(db.prepare("SELECT state, note FROM runs").all()).toEqual([
        { state: "stopped", note: "the daemon stopped" },
      ]);
    } finally {
      db.close();
    }
    t = await startTestDaemon({ home: t.home });
  });

  it("never resumes a Claude session that is open elsewhere", async () => {
    await setup("claude");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(bins.dir, "claude-agents"), JSON.stringify([{ sessionId: CLAUDE_SESSION }]));
    offlineAgent("claude-api", "claude", CLAUDE_SESSION);
    await asker();
    await t.raw("POST", "/v1/wake", { agent: "claude-api", text: "hi" }, { as: "asker" });
    const run = (await runEnded("R1")) as Run;
    expect(run.state).toBe("failed");
    expect(run.note).toMatch(/open somewhere else/);
    expect(bins.read("R1", "argv")).toBeUndefined();
  });
});
