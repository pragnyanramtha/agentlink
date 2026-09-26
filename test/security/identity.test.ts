import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";

// Production mode: the daemon identifies callers from the kernel (peer PID + ancestry),
// so the caller header a client sends is ignored.
const linux = process.platform === "linux";

describe.skipIf(!linux)("caller identity comes from the kernel", () => {
  let t: TestDaemon;

  beforeAll(async () => {
    t = await startTestDaemon({ verifyCallers: true });
    // This test process becomes the agent "alpha"; every request it makes is alpha's.
    await t.client().request("POST", "/v1/agents/register", {
      tool: "generic",
      name: "alpha",
      pid: process.pid,
      state: "idle",
    });
    const victim = t.fakeAgentProcess("claude");
    await t.client().request("POST", "/v1/agents/register", {
      tool: "claude",
      name: "victim",
      pid: victim.pid,
      sessionId: "victim-session",
      state: "idle",
    });
  }, 30_000);

  afterAll(async () => {
    await t?.stop();
  });

  it("identifies the calling agent regardless of the header", async () => {
    const who = await t.raw<{ agent: { name: string } | null }>("GET", "/v1/whoami", undefined, {
      tty: true,
    });
    expect(who.data.agent?.name).toBe("alpha");
  });

  it("refuses an agent acting as another agent", async () => {
    const res = await t.raw(
      "POST",
      "/v1/messages",
      { to: ["victim"], text: "hi" },
      { as: "victim" },
    );
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.data)).toContain("cannot act as another agent");
  });

  it("does not let an agent pass as the human by claiming a TTY", async () => {
    await t.raw("POST", "/v1/control", { action: "pause" });
    const resume = await t.raw("POST", "/v1/control", { action: "resume" }, { tty: true });
    expect(resume.status).toBe(403);
  });

  it("ignores hook requests that claim another agent's session", async () => {
    const daemon = t.daemon.services;
    daemon.ctx.store.setMeta("paused", "0");
    await t
      .client()
      .request("POST", "/v1/messages", { to: ["victim"], text: "for the victim only" });
    const res = await t.raw<{ stdout?: string }>("POST", "/v1/hooks/claude/post-tool", {
      payload: { session_id: "victim-session", hook_event_name: "PostToolUse" },
      chain: [],
    });
    expect(JSON.stringify(res.data)).not.toContain("for the victim only");
    const victimMail = daemon.mailbox.inbox(
      {
        agent: daemon.registry.byName("victim") as NonNullable<
          ReturnType<typeof daemon.registry.byName>
        >,
      },
      { unreadOnly: true },
    );
    expect(victimMail.map((i) => i.envelope.parts)).toHaveLength(1);
  });
});
