import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/core/log.ts";
import { type RunningRelay, startRelay } from "../../src/relay/server.ts";
import { startTestDaemon, type TestDaemon, until } from "../helpers.ts";

// Found by code reading while building scripts/sim (invariant: no silent loss). Leaving a team
// drops messages still waiting for the relay: their deliveries fail and the senders are told.
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
  rmSync(relayDir, { recursive: true, force: true });
});

describe("leaving the team with mail still waiting for the relay", () => {
  it("tells the sender instead of dropping it silently", async () => {
    await relay.close(); // the relay goes away; alice's next sends wait in her outbox
    await until(
      async () =>
        !(await alice.raw<{ team: { connected: boolean } }>("GET", "/v1/team")).data.team.connected,
      5_000,
    );
    const sent = await alice.raw<{ message: { id: string }; deliveries: { state: string }[] }>(
      "POST",
      "/v1/messages",
      { to: ["bob/codex-api"], kind: "ask", text: "which port does staging use?" },
      { as: "claude-web" },
    );
    expect(sent.data.deliveries[0]?.state).toBe("queued");
    const left = await alice.raw("POST", "/v1/team/leave", {});
    expect(left.status).toBe(200);

    const d = alice.daemon.services.mailbox.deliveriesOf(sent.data.message.id)[0];
    const notices = alice.daemon.services.ctx.store.all<{ preview: string; envelope: string }>(
      "SELECT preview, envelope FROM messages WHERE from_addr = 'agentlink'",
    );
    // either it is still going to be sent, or it failed and the sender heard about it
    const outbox =
      alice.daemon.services.ctx.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")?.n ??
      0;
    const notice = notices.find((n) => n.preview.includes(sent.data.message.id.slice(0, 12)));
    // the notice comes from this machine, not from bob's
    const local =
      !!notice?.envelope.includes("(not sent: this machine left team acme)") &&
      !notice.envelope.includes("machine says");
    expect({ state: d?.state, outbox, local }).toEqual({ state: "failed", outbox: 0, local: true });
  });
});
