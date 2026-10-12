import { execFile } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";

const CLI = join(import.meta.dirname, "../../src/cli/index.ts");

let t: TestDaemon;
afterEach(async () => {
  delete process.env.AGENTLINK_NOTIFY_BIN;
  await t?.stop();
});

/** Runs the real CLI against the test daemon (async: the daemon lives in this process). */
const cli = (...args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, HOME: t.home, AGENTLINK_HOME: t.home, NO_COLOR: "1" } },
      (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
  });

async function register(name: string) {
  const proc = t.fakeAgentProcess("generic");
  await t.client().request("POST", "/v1/agents/register", {
    tool: "generic",
    name,
    pid: proc.pid,
    ...(proc.start ? { pidStart: proc.start } : {}),
    cwd: t.home,
  });
}

const send = async (as: string | undefined, body: Record<string, unknown>) => {
  const res = await t.raw<{ message: { id: string; thread: string } }>(
    "POST",
    "/v1/messages",
    body,
    as ? { as } : {},
  );
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  return res.data.message;
};

async function seed() {
  t = await startTestDaemon();
  await register("alpha");
  await register("beta");
  const info = await send(undefined, { to: ["alpha"], text: "please deploy the frobnicator" });
  const ask = await send("alpha", {
    to: ["beta"],
    kind: "ask",
    text: "is the zebra protocol ready?",
  });
  await send("beta", { kind: "reply", replyTo: ask.id, text: "yes, zebra is ready" });
  const open = await send("alpha", {
    to: ["@tester"],
    kind: "ask",
    text: "which port for staging?",
  });
  return { info, ask, open };
}

describe("cli history commands", () => {
  it("search prints compact hits with filters, and the raw results with --json", async () => {
    const { ask } = await seed();
    const r = await cli("search", "zebra");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^ID\s+WHEN\s+KIND/);
    expect(r.stdout).toContain("«zebra»");
    expect(r.stdout).toContain("alpha → beta");
    expect(r.stdout).toContain("agentlink thread <id>");
    const filtered = await cli("search", "zebra", "--from", "alpha", "--since", "1h", "-n", "5");
    expect(filtered.stdout).toContain(ask.id.slice(0, 12));
    expect(filtered.stdout).not.toContain("beta → ");
    const json = JSON.parse((await cli("--json", "search", "zebra", "--kind", "reply")).stdout);
    expect(json.results).toHaveLength(1);
    expect(json.results[0]).toMatchObject({ kind: "reply", from: "beta" });
    expect(json.fts).toBe(true);
    expect((await cli("search", "nothinglikethis")).stdout).toContain("No messages match");
  });

  it("threads lists conversations, --open only those waiting", async () => {
    const { ask, open } = await seed();
    const all = await cli("threads");
    expect(all.code, all.stderr).toBe(0);
    expect(all.stdout).toContain(ask.thread.slice(0, 12));
    expect(all.stdout).toContain(open.thread.slice(0, 12));
    const waiting = await cli("threads", "--open");
    expect(waiting.stdout).toContain(open.thread.slice(0, 12));
    expect(waiting.stdout).toContain("open");
    expect(waiting.stdout).not.toContain(ask.thread.slice(0, 12));
    const json = JSON.parse((await cli("--json", "threads", "--with", "beta")).stdout);
    expect(json.threads.map((x: { thread: string }) => x.thread)).toEqual([ask.thread]);
  });

  it("log takes the history filters", async () => {
    const { info } = await seed();
    const json = JSON.parse(
      (await cli("--json", "log", "--from", "@tester", "--kind", "info")).stdout,
    );
    expect(json.messages.map((m: { message: { id: string } }) => m.message.id)).toEqual([info.id]);
    const none = await cli("log", "--since", "2999-01-01");
    expect(none.code, none.stderr).toBe(0);
    expect(none.stdout).toContain("No messages match");
  });

  it("overview shows the dashboard; --json is the raw overview", async () => {
    await seed();
    const r = await cli("overview");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n")[0]).toContain("@tester");
    expect(r.stdout).toMatch(/[●○] alpha/);
    expect(r.stdout).toContain("1 waiting for your answer");
    expect(r.stdout).toContain("which port for staging?");
    const json = JSON.parse((await cli("--json", "dash")).stdout);
    expect(json).toMatchObject({ handle: "tester", todo: 1, team: null });
    expect(json.agents.local.idle + json.agents.local.busy).toBe(2);
  });

  it("notify test explains a missing notifier; prune refuses without a terminal", async () => {
    t = await startTestDaemon();
    process.env.AGENTLINK_NOTIFY_BIN = join(t.home, "no-such-notifier");
    const n = await cli("notify", "test");
    expect(n.code).toBe(1);
    expect(n.stdout + n.stderr).toMatch(/notify-send|osascript/);
    expect(JSON.parse((await cli("--json", "notify", "test")).stdout)).toMatchObject({
      found: false,
    });
    expect((await cli("notify", "on")).code).toBe(0);
    expect(t.daemon.services.ctx.config.notify.desktop).toBe(true);
    const p = await cli("prune", "--older-than", "30d", "--dry-run");
    expect(p.code).toBe(1);
    expect(p.stderr).toContain("interactive terminal");
  });
});
