// A session id in a hook payload is only a claim. Seen live: `claude --resume` / `devin -r` start a
// new process for an existing session, and a Claude session resumed while its first process still
// runs (background agents) has two live processes reporting the same session id. Any local process
// could also run `agentlink hook claude prompt-submit` with another agent's session id.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "../../src/cli/client.ts";
import { resolvePaths } from "../../src/core/paths.ts";
import { type RunningDaemon, startDaemon } from "../../src/daemon/main.ts";
import { FakeAgent, sandbox } from "../fake-agent.ts";

const linux = process.platform === "linux";

describe.skipIf(!linux)("hook session claims (verified callers, real hook CLI)", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let daemon: RunningDaemon;
  let cwd: string;
  const agents: FakeAgent[] = [];
  const agent = (tool = "claude", bin?: string, orphan = false) => {
    const a = new FakeAgent(tool, env, cwd, bin, orphan);
    agents.push(a);
    return a;
  };
  const row = (session: string) => daemon.services.registry.bySession("claude", session);
  const pending = (session: string) =>
    daemon.services.mailbox.pending(row(session)?.id ?? "?").length;
  const client = () => new Client(resolvePaths(env));
  const send = (to: string, text: string) =>
    client().request("POST", "/v1/messages", { to: [to], text });
  const warnings = () =>
    readFileSync(join(home, "daemon.log"), "utf8")
      .split("\n")
      .filter((l) => l.includes("claimed another agent's session"));

  beforeAll(async () => {
    ({ home, env } = sandbox());
    cwd = join(home, "project");
    mkdirSync(cwd);
    // Production mode: callers identified from the kernel (ss + /proc), logs to daemon.log.
    daemon = await startDaemon({ paths: resolvePaths(env), sweepMs: 200 });
  }, 30_000);

  afterAll(async () => {
    for (const a of agents) a.kill();
    await daemon?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("does not let another live process take over a session by claiming its id", async () => {
    const victim = agent();
    await victim.hook("session-start", { session_id: "S-victim", cwd });
    const owner = row("S-victim");
    expect(owner?.pid).toBe(victim.pid);
    await send(owner?.name as string, "for the victim only");

    const intruder = agent(); // any process that can run `agentlink hook claude …`
    const before = warnings().length;
    const out = await intruder.hook("prompt-submit", { session_id: "S-victim", cwd });
    await intruder.hook("prompt-submit", { session_id: "S-victim", cwd });

    expect(out).not.toContain("for the victim only");
    expect(row("S-victim")?.pid).toBe(victim.pid);
    expect(pending("S-victim")).toBe(1);
    expect(warnings().length).toBe(before + 1); // logged once, not on every hook
    // The intruder is an agent of its own, without the session.
    const own = daemon.services.registry.byLivePid("claude", intruder.pid);
    expect(own?.id).not.toBe(owner?.id);
    expect(own?.session_id).toBeNull();
    // The victim still gets its mail.
    expect(await victim.hook("prompt-submit", { session_id: "S-victim", cwd })).toContain(
      "for the victim only",
    );
  }, 30_000);

  it("does not let the register route move a live session to another process", async () => {
    const victim = agent();
    await victim.hook("session-start", { session_id: "S-reg", cwd });
    const owner = row("S-reg");
    const other = agent();
    await client().request("POST", "/v1/agents/register", {
      tool: "claude",
      sessionId: "S-reg",
      pid: other.pid,
    });
    expect(row("S-reg")?.id).toBe(owner?.id);
    expect(daemon.services.registry.byId(owner?.id as string)?.pid).toBe(victim.pid);
  }, 30_000);

  it("keeps one owner when two live processes report the same session (no pid ping-pong)", async () => {
    const first = agent();
    const second = agent(); // e.g. `claude --resume S` while the first process is still running
    await first.hook("session-start", { session_id: "S-shared", cwd });
    const pids: (number | null | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      await second.hook("post-tool", {
        session_id: "S-shared",
        cwd,
        hook_event_name: "PostToolUse",
      });
      pids.push(row("S-shared")?.pid);
      await first.hook("post-tool", {
        session_id: "S-shared",
        cwd,
        hook_event_name: "PostToolUse",
      });
      pids.push(row("S-shared")?.pid);
    }
    expect(new Set(pids)).toEqual(new Set([first.pid]));
  }, 60_000);

  it("lets a session resumed in a new process (old one exited) keep its agent, quietly", async () => {
    const before = warnings().length;
    const old = agent("claude");
    await old.hook("session-start", { session_id: "S-resumed", cwd });
    const id = row("S-resumed")?.id;
    old.kill(); // the user quits; later `claude --resume S-resumed` / `devin -r` starts a new process
    await new Promise((r) => setTimeout(r, 300));
    await send(row("S-resumed")?.name as string, "welcome back");

    const resumed = agent("claude");
    const out = await resumed.hook("session-start", { session_id: "S-resumed", cwd });

    expect(row("S-resumed")?.id).toBe(id);
    expect(row("S-resumed")?.pid).toBe(resumed.pid);
    expect(out).toContain("welcome back");
    expect(warnings().length).toBe(before);
  }, 30_000);

  it("does not hand a dead session to another CLI or another place", async () => {
    const old = agent("claude");
    await old.hook("session-start", { session_id: "S-gone", cwd });
    const id = row("S-gone")?.id;
    old.kill();
    await new Promise((r) => setTimeout(r, 300));
    await send(row("S-gone")?.name as string, "not for strangers");
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    // Not a claude binary (claude's hook config run by something else), and a claude elsewhere.
    for (const a of [agent("claude", "/usr/local/bin/sometool"), agent("claude")]) {
      const out = await a.hook("prompt-submit", { session_id: "S-gone", cwd: elsewhere });
      expect(out).not.toContain("not for strangers");
      expect(daemon.services.registry.byId(id as string)?.pid).toBe(old.pid);
    }
  }, 30_000);

  it("maps one process firing two hook configs (Cursor's and Claude's) to one agent", async () => {
    const ide = agent("cursor", "/opt/Cursor/cursor", true); // not a binary agentlink knows
    await ide.ready;
    await ide.hook("session-start", { session_id: "S-ide", cwd });
    await ide.hook("prompt-submit", { session_id: "S-ide", cwd }, { tool: "claude" });
    await ide.hook("post-tool", { session_id: "S-ide", cwd }, { tool: "cursor" });
    const rows = daemon.services.registry
      .list({ includeOffline: true })
      .filter((a) => a.session_id === "S-ide");
    expect(rows.map((a) => a.tool)).toEqual(["cursor"]);
    expect(rows[0]?.pid).toBe(ide.pid);
  }, 30_000);
});
