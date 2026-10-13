import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/core/log.ts";
import { deviceKeys } from "../../src/daemon/team.ts";
import { type RunningRelay, startRelay } from "../../src/relay/server.ts";
import { sleep, startTestDaemon, type TestDaemon, until } from "../helpers.ts";

// Found by scripts/sim (team churn during relay outages): a leave while the daemon was off the
// relay never reached it, so the device stayed a member there and teammates' mail to it sat at
// "sent" forever. The leave now waits on disk and goes out as soon as the relay is reachable.
let relayDir: string;
let relay: RunningRelay;
let port: number;
let otherDir: string;
let other: RunningRelay;
let alice: TestDaemon;
let bob: TestDaemon;
let carol: TestDaemon;

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
const clientOf = (t: TestDaemon) => {
  const c = t.daemon.services.team.client;
  if (!c) throw new Error("not in a team");
  return c;
};
/** Whether the relay still lists `t`'s device as a member of team acme. */
const memberAtRelay = (t: TestDaemon) => {
  const db = new DatabaseSync(join(relayDir, "relay.db"));
  const n = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM devices WHERE device_id = ? AND team_id LIKE 'acme-%' AND removed_at IS NULL",
      )
      .get(deviceKeys(t.paths).deviceId) as { n: number }
  ).n;
  db.close();
  return n > 0;
};
const stateAt = (t: TestDaemon, id: string) => t.daemon.services.mailbox.deliveriesOf(id)[0]?.state;
const noticeFor = (t: TestDaemon, id: string) =>
  t.daemon.services.ctx.store
    .all<{ preview: string; envelope: string }>(
      "SELECT preview, envelope FROM messages WHERE from_addr = 'agentlink'",
    )
    .find((n) => n.preview.includes(id.slice(0, 12)))?.envelope ?? "";
async function send(from: TestDaemon, as: string, to: string, text: string) {
  const r = await from.raw<{ message: { id: string } }>(
    "POST",
    "/v1/messages",
    { to: [to], kind: "ask", text },
    { as },
  );
  return r.data.message.id;
}
async function joinTeam(t: TestDaemon) {
  const inv = await alice.raw<{ invite: string }>("POST", "/v1/team/invite", { uses: 1 });
  expect((await t.raw("POST", "/v1/team/join", { invite: inv.data.invite })).status).toBe(200);
}
/** bob's daemon takes messages but cannot handle envelopes for now: they stay at the relay. */
function stall(t: TestDaemon): () => boolean {
  const client = clientOf(t);
  const handle = client.onInbound;
  let failed = false;
  client.onInbound = (msg) => {
    if (msg.kind === "envelope") {
      failed = true;
      throw new Error("database is locked");
    }
    handle?.(msg);
  };
  return () => failed;
}
/** alice's message to bob waits at the relay (bob's daemon cannot take it yet). */
async function queuedAtRelay(text: string) {
  const failed = stall(bob);
  const id = await send(alice, "claude-web", "bob/codex-api", text);
  await until(() => failed() && stateAt(alice, id) === "sent", 5_000);
  expect(stateAt(alice, id)).toBe("sent");
  return id;
}
async function relayDown() {
  await relay.close();
  await until(() => !clientOf(alice).connected, 3_000);
}
const relayUp = async () => {
  relay = await startRelay({ dataDir: relayDir, port, logger: silentLogger });
};

beforeAll(async () => {
  relayDir = mkdtempSync(join(tmpdir(), "agentlink-relay-"));
  relay = await startRelay({ dataDir: relayDir, port: 0, logger: silentLogger });
  port = relay.port;
  otherDir = mkdtempSync(join(tmpdir(), "agentlink-relay-"));
  other = await startRelay({ dataDir: otherDir, port: 0, logger: silentLogger });
  alice = await startTestDaemon({ handle: "alice" });
  bob = await startTestDaemon({ handle: "bob" });
  carol = await startTestDaemon({ handle: "carol" });
  await alice.raw("POST", "/v1/team/create", { name: "acme", relay: relay.url });
  await joinTeam(bob);
  await register(alice, "claude-web");
  await register(bob, "codex-api");
  expect(await sees(alice, "bob/codex-api")).toBe(true);
}, 30_000);
afterAll(async () => {
  await alice?.stop();
  await bob?.stop();
  await carol?.stop();
  await relay?.close();
  await other?.close();
  rmSync(relayDir, { recursive: true, force: true });
  rmSync(otherDir, { recursive: true, force: true });
});

describe("leaving the team while the relay is unreachable", () => {
  it("reaches the relay once it is back: the teammate's mail fails with the drop notice", async () => {
    const id = await queuedAtRelay("which port does staging use?");
    await relayDown();
    expect((await bob.raw("POST", "/v1/team/leave", {})).status).toBe(200);
    await sleep(500);
    await relayUp();
    await until(() => stateAt(alice, id) === "failed", 15_000);
    expect({
      member: memberAtRelay(bob),
      state: stateAt(alice, id),
      notice: noticeFor(alice, id).includes("bob's device left the team before reading it"),
    }).toEqual({ member: false, state: "failed", notice: true });
  }, 30_000);

  it("survives a restart, and joining another team meanwhile does not cancel it", async () => {
    await until(() => clientOf(alice).connected, 8_000);
    await joinTeam(bob);
    expect(await sees(alice, "bob/codex-api")).toBe(true);
    const id = await queuedAtRelay("and the database host?");
    await relayDown();
    expect((await bob.raw("POST", "/v1/team/leave", {})).status).toBe(200);
    const home = bob.home;
    await bob.stop(true);
    bob = await startTestDaemon({ handle: "bob", home });
    await carol.raw("POST", "/v1/team/create", { name: "beta", relay: other.url });
    const inv = await carol.raw<{ invite: string }>("POST", "/v1/team/invite", { uses: 1 });
    expect((await bob.raw("POST", "/v1/team/join", { invite: inv.data.invite })).status).toBe(200);
    await sleep(500);
    expect(memberAtRelay(bob)).toBe(true); // acme's relay is still down
    await relayUp();
    await until(() => stateAt(alice, id) === "failed", 15_000);
    const team = await bob.raw<{ team: { name: string; connected: boolean } }>("GET", "/v1/team");
    expect({
      member: memberAtRelay(bob),
      state: stateAt(alice, id),
      notice: noticeFor(alice, id).includes("bob's device left the team before reading it"),
      team: team.data.team,
    }).toMatchObject({
      member: false,
      state: "failed",
      notice: true,
      team: { name: "beta", connected: true },
    });
  }, 40_000);
});
