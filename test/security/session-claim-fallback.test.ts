import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";

// Code review: the guard against moving a session away from its live process only applied with a
// kernel-verified caller chain. Where the daemon falls back to the client's claims (other
// systems, WSL 1), a claimed session id alone could take over a running agent.
let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon(); // trusts the client's claims
});
afterEach(async () => {
  await t.stop();
});

const row = (session: string) => t.daemon.services.registry.bySession("claude", session);

describe("session claims when callers cannot be verified", () => {
  it("never moves a session away from its live process", async () => {
    const victim = t.fakeAgentProcess("claude");
    const thief = t.fakeAgentProcess("claude");
    await t.hook("claude", "session-start", { session_id: "S-live", cwd: t.home }, victim);
    const owner = row("S-live");
    expect(owner?.pid).toBe(victim.pid);
    await t.hook("claude", "prompt-submit", { session_id: "S-live", cwd: t.home }, thief);
    const reg = await t.raw("POST", "/v1/agents/register", {
      tool: "claude",
      sessionId: "S-live",
      pid: thief.pid,
    });
    expect(reg.status).toBe(200);
    expect(t.daemon.services.registry.byId(owner?.id as string)?.pid).toBe(victim.pid);
    expect(row("S-live")?.id).toBe(owner?.id);
  });

  it("still lets a session resumed in a new process (old one gone) keep its agent", async () => {
    const old = t.fakeAgentProcess("claude");
    await t.hook("claude", "session-start", { session_id: "S-res", cwd: t.home }, old);
    const id = row("S-res")?.id;
    old.kill();
    await new Promise((r) => setTimeout(r, 200));
    const resumed = t.fakeAgentProcess("claude");
    await t.hook("claude", "session-start", { session_id: "S-res", cwd: t.home }, resumed);
    expect(row("S-res")?.id).toBe(id);
    expect(row("S-res")?.pid).toBe(resumed.pid);
  });
});
