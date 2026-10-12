import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";

// Found by scripts/sim (invariant: a delivery marked "seen" was shown to its agent).
// Hooks only take mail at events whose answer the CLI shows: OpenCode's runtime prints nothing
// for any event (its plugin calls session-start and prompt-submit), Copilot prints nothing for
// prompt-submit (userPromptSubmitted is installed).
let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon();
});
afterEach(async () => {
  await t.stop();
});

async function sendTo(name: string, text: string) {
  const res = await t.raw<{ message: { id: string } }>("POST", "/v1/messages", {
    to: [name],
    kind: "ask",
    text,
  });
  expect(res.status).toBe(200);
  return res.data.message.id;
}
const stateOf = (id: string) => t.daemon.services.mailbox.deliveriesOf(id)[0]?.state;

describe("hooks that cannot print never swallow mail", () => {
  it("OpenCode session-start keeps mail queued for an agent coming back", async () => {
    const proc = t.fakeAgentProcess("opencode");
    const payload = { session_id: "ses_simrepro01", cwd: t.home };
    await t.hook("opencode", "session-start", payload, proc);
    const name = t.daemon.services.registry.list()[0]?.name as string;
    await t.hook("opencode", "session-end", payload, proc);
    const id = await sendTo(name, "what is the test command?"); // queued: agent offline

    const res = await t.hook<{ stdout?: string }>("opencode", "session-start", payload, proc);
    expect(res.stdout ?? "").not.toContain(id); // OpenCode hooks print nothing...
    expect(stateOf(id)).toBe("queued"); // ...so the mail must still be waiting (it is "seen")
  });

  it("OpenCode prompt-submit keeps mail queued", async () => {
    const proc = t.fakeAgentProcess("opencode");
    const payload = { session_id: "ses_simrepro02", cwd: t.home };
    await t.hook("opencode", "session-start", payload, proc);
    const name = t.daemon.services.registry.list()[0]?.name as string;
    const id = await sendTo(name, "is the orders endpoint paginated?");
    await t.hook("opencode", "prompt-submit", payload, proc);
    expect(stateOf(id)).toBe("queued");
  });

  it("Copilot prompt-submit (userPromptSubmitted) keeps mail for postToolUse", async () => {
    const proc = t.fakeAgentProcess("copilot");
    const payload = { sessionId: "copilot-simrepro-1", cwd: t.home };
    await t.hook("copilot", "session-start", payload, proc);
    const name = t.daemon.services.registry.list()[0]?.name as string;
    const id = await sendTo(name, "which env var holds the ttl?");
    const res = await t.hook<{ stdout?: string }>("copilot", "prompt-submit", payload, proc);
    expect(res.stdout ?? "").not.toContain(id);
    expect(stateOf(id)).toBe("queued");
    const later = await t.hook<{ stdout?: string }>("copilot", "post-tool", payload, proc);
    expect(later.stdout ?? "").toContain(id);
  });
});
