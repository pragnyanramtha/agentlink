import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/core/log.ts";
import { type RunningRelay, startRelay } from "../../src/relay/server.ts";
import { startTestDaemon, type TestDaemon, until } from "../helpers.ts";

// Found by scripts/sim: a teammate's "held" receipt made the sender's own copy state='held',
// and GET /v1/approvals listed every held delivery, so the *sender's* person could deny a hold
// that lives on the other machine: the sending agent was told "denied" while the recipient's
// person approved it and the agent answered (and "refused" can't move to "replied").
let relayDir: string;
let relay: RunningRelay;
let alice: TestDaemon;
let bob: TestDaemon;

beforeAll(async () => {
  relayDir = mkdtempSync(join(tmpdir(), "agentlink-relay-"));
  relay = await startRelay({ dataDir: relayDir, port: 0, logger: silentLogger });
  alice = await startTestDaemon({ handle: "alice" });
  bob = await startTestDaemon({ handle: "bob" });
  await alice.raw("POST", "/v1/team/create", { name: "acme", relay: relay.url });
  const inv = await alice.raw<{ invite: string }>("POST", "/v1/team/invite", { uses: 1 });
  await bob.raw("POST", "/v1/team/join", { invite: inv.data.invite });
  for (const [t, name] of [
    [alice, "claude-web"],
    [bob, "codex-api"],
  ] as const) {
    const proc = t.fakeAgentProcess("generic");
    await t.client().request("POST", "/v1/agents/register", {
      tool: "generic",
      name,
      pid: proc.pid,
      state: "idle",
    });
  }
  // bob's person wants to approve teammates' requests
  await bob.raw(
    "POST",
    "/v1/policy",
    { scope: "teammate", kind: "request", action: "hold" },
    { tty: true },
  );
  await until(async () => {
    const { agents } = await alice
      .client()
      .request<{ agents: { name: string }[] }>("GET", "/v1/agents");
    return agents.some((a) => a.name === "bob/codex-api");
  }, 8_000);
}, 30_000);
afterAll(async () => {
  await alice?.stop();
  await bob?.stop();
  await relay?.close();
  rmSync(relayDir, { recursive: true, force: true });
});

describe("a message held on a teammate's machine", () => {
  it("is approved there, not in the sender's approvals", async () => {
    const sent = await alice.raw<{ message: { id: string; thread: string } }>(
      "POST",
      "/v1/messages",
      { to: ["bob/codex-api"], kind: "request", text: "please run the migration" },
      { as: "claude-web" },
    );
    const { id, thread } = sent.data.message;
    await until(() => alice.daemon.services.mailbox.deliveriesOf(id)[0]?.state === "held", 5_000);
    const mine = await alice.raw<{ items: { message: { id: string } }[] }>("GET", "/v1/approvals");
    expect(mine.data.items.map((i) => i.message.id)).not.toContain(id);
    const ov = await alice.raw<{ held: number }>("GET", "/v1/overview");
    expect(ov.data.held).toBe(0);
    // the sender sees where it waits
    const shown = await alice.raw<{ deliveries: { note: string }[] }>(
      "GET",
      `/v1/messages/${id}`,
      undefined,
      { as: "claude-web" },
    );
    expect(shown.data.deliveries[0]?.note).toContain("held on bob's machine");
    const status = await alice.raw<{ state: string; awaiting: string[] }>(
      "GET",
      `/v1/threads/${thread}`,
    );
    expect(status.data).toMatchObject({ state: "awaiting", awaiting: ["bob/codex-api"] });
    // and if the sender's person tries anyway, nothing pretends it was denied
    for (const ref of [id, String(alice.daemon.services.mailbox.deliveriesOf(id)[0]?.id)]) {
      const deny = await alice.raw(
        "POST",
        `/v1/approvals/${ref}`,
        { decision: "deny" },
        { tty: true },
      );
      expect(deny.status).toBe(400);
    }
    expect(alice.daemon.services.mailbox.deliveriesOf(id)[0]?.state).toBe("held");

    // bob's person decides it
    const theirs = await bob.raw<{ items: { message: { id: string } }[] }>("GET", "/v1/approvals");
    expect(theirs.data.items.map((i) => i.message.id)).toContain(id);
    const ok = await bob.raw("POST", `/v1/approvals/${id}`, { decision: "approve" }, { tty: true });
    expect(ok.status).toBe(200);
    await until(
      () => alice.daemon.services.mailbox.deliveriesOf(id)[0]?.state === "delivered",
      5_000,
    );
    expect(alice.daemon.services.mailbox.deliveriesOf(id)[0]?.state).toBe("delivered");
  });
});
