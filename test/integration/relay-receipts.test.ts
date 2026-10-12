import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/core/log.ts";
import { type RunningRelay, startRelay } from "../../src/relay/server.ts";
import { sleep, startTestDaemon, type TestDaemon, until } from "../helpers.ts";

// Found by scripts/sim (receipt-mismatch): the sender stayed at "delivered" while the recipient
// had seen or answered the message.
type Item = { message: { id: string }; text: string };
let relayDir: string;
let relay: RunningRelay;
let alice: TestDaemon;
let bob: TestDaemon;

async function register(t: TestDaemon, name: string) {
  const proc = t.fakeAgentProcess("generic");
  await t.client().request("POST", "/v1/agents/register", {
    tool: "generic",
    name,
    pid: proc.pid,
    state: "idle",
  });
}
const sees = (t: TestDaemon, addr: string) =>
  until(async () => {
    const { agents } = await t
      .client()
      .request<{ agents: { name: string }[] }>("GET", "/v1/agents");
    return agents.some((a) => a.name === addr);
  }, 8_000);
const stateAt = (t: TestDaemon, messageId: string) =>
  t.daemon.services.mailbox.deliveriesOf(messageId)[0]?.state;
const inboxItem = (t: TestDaemon, agent: string, text: string) =>
  until(async () => {
    const r = await t.client(agent).request<{ items: Item[] }>("GET", "/v1/inbox?all=1");
    return r.items.find((i) => i.text === text);
  }, 8_000);

beforeAll(async () => {
  relayDir = mkdtempSync(join(tmpdir(), "agentlink-relay-"));
  relay = await startRelay({ dataDir: relayDir, port: 0, logger: silentLogger });
  alice = await startTestDaemon({ handle: "alice" });
  bob = await startTestDaemon({ handle: "bob" });
  await alice.raw("POST", "/v1/team/create", { name: "acme", relay: relay.url });
  const inv = await alice.raw<{ invite: string }>("POST", "/v1/team/invite", { uses: 1 });
  await bob.raw("POST", "/v1/team/join", { invite: inv.data.invite });
  await register(alice, "claude-web");
  await register(bob, "codex-api");
  expect(await sees(alice, "bob/codex-api")).toBe(true);
  expect(await sees(bob, "alice/claude-web")).toBe(true);
}, 30_000);
afterAll(async () => {
  await alice?.stop();
  await bob?.stop();
  await relay?.close();
  rmSync(relayDir, { recursive: true, force: true });
});

describe("receipts from a teammate", () => {
  it("reach the sender when the recipient was renamed before the message arrived", async () => {
    const client = bob.daemon.services.team.client;
    if (!client) throw new Error("bob is not connected");
    // alice has not heard about the rename yet when she sends
    const publish = client.publishPresence;
    client.publishPresence = () => undefined;
    try {
      const me = bob.daemon.services.registry.byName("codex-api");
      bob.daemon.services.registry.rename(me?.id as string, "codex-renamed");
      const sent = await alice.raw<{ message: { id: string }; deliveries: { to: string }[] }>(
        "POST",
        "/v1/messages",
        { to: ["bob/codex-api"], kind: "ask", text: "renamed yet?" },
        { as: "claude-web" },
      );
      expect(sent.data.deliveries[0]?.to).toBe("bob/codex-api");
      const item = await inboxItem(bob, "codex-renamed", "renamed yet?");
      expect(await until(() => stateAt(alice, sent.data.message.id) === "seen", 8_000)).toBe(true);
      await bob.client("codex-renamed").request("POST", "/v1/messages", {
        kind: "reply",
        replyTo: item?.message.id,
        text: "yes",
      });
      expect(await until(() => stateAt(alice, sent.data.message.id) === "replied", 8_000)).toBe(
        true,
      );
    } finally {
      client.publishPresence = publish;
      client.publishPresence();
    }
  });

  it("reach the sender after it was briefly off the team", async () => {
    expect(await sees(alice, "bob/codex-renamed")).toBe(true);
    const sent = await bob.raw<{ message: { id: string } }>(
      "POST",
      "/v1/messages",
      { to: ["alice/claude-web"], kind: "ask", text: "still there?" },
      { as: "codex-renamed" },
    );
    expect(await until(() => stateAt(bob, sent.data.message.id) === "delivered", 8_000)).toBe(true);
    await bob.raw("POST", "/v1/team/leave", {});
    // alice no longer lists bob's device when her agent reads the message
    await until(
      () => !alice.daemon.services.team.client?.members().some((m) => m.handle === "bob"),
      8_000,
    );
    await inboxItem(alice, "claude-web", "still there?");
    const inv = await alice.raw<{ invite: string }>("POST", "/v1/team/invite", { uses: 1 });
    expect((await bob.raw("POST", "/v1/team/join", { invite: inv.data.invite })).status).toBe(200);
    expect(await until(() => stateAt(bob, sent.data.message.id) === "seen", 8_000)).toBe(true);
  }, 30_000);

  it("still go out after this machine left and re-joined before sending them", async () => {
    expect(await sees(bob, "alice/claude-web")).toBe(true);
    const sent = await alice.raw<{ message: { id: string } }>(
      "POST",
      "/v1/messages",
      { to: ["bob/codex-renamed"], kind: "ask", text: "before you go?" },
      { as: "claude-web" },
    );
    expect(await until(() => stateAt(alice, sent.data.message.id) === "delivered", 8_000)).toBe(
      true,
    );
    bob.daemon.services.team.client?.stop(); // bob's receipts now wait in its outbox
    await inboxItem(bob, "codex-renamed", "before you go?");
    expect(outbox(bob)).toBeGreaterThan(0);
    await bob.raw("POST", "/v1/team/leave", {});
    await rejoin(bob);
    expect(await until(() => stateAt(alice, sent.data.message.id) === "seen", 8_000)).toBe(true);
  }, 30_000);

  it("wait for a teammate that left the team before they went out", async () => {
    expect(await sees(alice, "bob/codex-renamed")).toBe(true);
    const sent = await bob.raw<{ message: { id: string } }>(
      "POST",
      "/v1/messages",
      { to: ["alice/claude-web"], kind: "ask", text: "are you back?" },
      { as: "codex-renamed" },
    );
    expect(await until(() => stateAt(bob, sent.data.message.id) === "delivered", 8_000)).toBe(true);
    const client = alice.daemon.services.team.client;
    client?.stop(); // alice's receipt (sealed for bob's device) waits in her outbox
    await inboxItem(alice, "claude-web", "are you back?");
    expect(outbox(alice)).toBeGreaterThan(0);
    await bob.raw("POST", "/v1/team/leave", {});
    await sleep(300);
    // alice is back, bob's device is no longer in the team: the relay refuses her receipt
    void client?.start();
    await until(() => client?.connected && outbox(alice) === 0, 8_000);
    await sleep(300);
    await rejoin(bob);
    expect(await until(() => stateAt(bob, sent.data.message.id) === "seen", 8_000)).toBe(true);
  }, 30_000);

  it("go out for messages read while this machine was off the team", async () => {
    expect(await sees(bob, "alice/claude-web")).toBe(true);
    const sent = await alice.raw<{ message: { id: string } }>(
      "POST",
      "/v1/messages",
      { to: ["bob/codex-renamed"], kind: "ask", text: "read while away?" },
      { as: "claude-web" },
    );
    expect(await until(() => stateAt(alice, sent.data.message.id) === "delivered", 8_000)).toBe(
      true,
    );
    await bob.raw("POST", "/v1/team/leave", {});
    await inboxItem(bob, "codex-renamed", "read while away?");
    await rejoin(bob);
    expect(await until(() => stateAt(alice, sent.data.message.id) === "seen", 8_000)).toBe(true);
  }, 30_000);
});

const outbox = (t: TestDaemon) =>
  t.daemon.services.ctx.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")?.n ?? 0;
async function rejoin(t: TestDaemon) {
  const inv = await alice.raw<{ invite: string }>("POST", "/v1/team/invite", { uses: 1 });
  expect((await t.raw("POST", "/v1/team/join", { invite: inv.data.invite })).status).toBe(200);
}
