import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { randomToken, signJson } from "../../src/core/crypto.ts";
import { silentLogger } from "../../src/core/log.ts";
import { deviceKeys } from "../../src/daemon/team.ts";
import { authPayload } from "../../src/relay/protocol.ts";
import { type RunningRelay, startRelay } from "../../src/relay/server.ts";
import { sleep, startTestDaemon, type TestDaemon, until } from "../helpers.ts";

// Messages the relay holds for a device that leaves are dropped: their senders are told (by
// their own frame ids) and fail those deliveries. Messages from a device missing from the
// receiver's roster are fetched again as soon as the roster explains them.
let relayDir: string;
let relay: RunningRelay;
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
const relayCount = (sql: string, ...p: string[]) => {
  const db = new DatabaseSync(join(relayDir, "relay.db"));
  const n = (db.prepare(sql).get(...p) as { n: number }).n;
  db.close();
  return n;
};
const queuedFor = (t: TestDaemon) =>
  relayCount("SELECT COUNT(*) AS n FROM queue WHERE to_device = ?", clientOf(t).deviceId);
const stateAt = (t: TestDaemon, id: string) => t.daemon.services.mailbox.deliveriesOf(id)[0]?.state;
const has = (t: TestDaemon, id: string) =>
  !!t.daemon.services.ctx.store.get("SELECT 1 FROM messages WHERE id = ?", id);
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

beforeAll(async () => {
  relayDir = mkdtempSync(join(tmpdir(), "agentlink-relay-"));
  relay = await startRelay({ dataDir: relayDir, port: 0, logger: silentLogger });
  alice = await startTestDaemon({ handle: "alice" });
  bob = await startTestDaemon({ handle: "bob" });
  carol = await startTestDaemon({ handle: "carol" });
  await alice.raw("POST", "/v1/team/create", { name: "acme", relay: relay.url });
  await joinTeam(bob);
  await joinTeam(carol);
  await register(alice, "claude-web");
  await register(bob, "codex-api");
  await register(carol, "cursor-ui");
  expect(await sees(alice, "bob/codex-api")).toBe(true);
  expect(await sees(carol, "bob/codex-api")).toBe(true);
}, 30_000);
afterAll(async () => {
  await alice?.stop();
  await bob?.stop();
  await carol?.stop();
  await relay?.close();
  rmSync(relayDir, { recursive: true, force: true });
});

describe("messages the relay drops for a device that left", () => {
  it("fail at the sender with a local notice", async () => {
    const failed = stall(bob);
    const id = await send(alice, "claude-web", "bob/codex-api", "which port does staging use?");
    await until(() => failed() && stateAt(alice, id) === "sent", 5_000);
    await sleep(200);
    expect({ state: stateAt(alice, id), queued: queuedFor(bob) }).toEqual({
      state: "sent",
      queued: 1,
    });
    await bob.raw("POST", "/v1/team/leave", {});
    await until(() => stateAt(alice, id) === "failed", 5_000);
    const notice = noticeFor(alice, id);
    expect({
      state: stateAt(alice, id),
      notice: notice.includes("(not delivered: bob's device left the team before reading it)"),
      local: !notice.includes("machine says"),
    }).toEqual({ state: "failed", notice: true, local: true });
  }, 20_000);

  it("reach a sender that was offline when the device left, once it reconnects", async () => {
    await joinTeam(bob);
    expect(await sees(alice, "bob/codex-api")).toBe(true);
    const failed = stall(bob);
    const id = await send(alice, "claude-web", "bob/codex-api", "and the database host?");
    await until(() => failed() && stateAt(alice, id) === "sent", 5_000);
    await sleep(200);
    const client = clientOf(alice);
    client.stop();
    await until(() => !client.connected, 3_000);
    await bob.raw("POST", "/v1/team/leave", {});
    await until(() => relayCount("SELECT COUNT(*) AS n FROM dropped") === 1, 3_000);
    expect(stateAt(alice, id)).toBe("sent");
    void client.start();
    await until(() => stateAt(alice, id) === "failed", 5_000);
    expect({
      state: stateAt(alice, id),
      notice: noticeFor(alice, id).includes("bob's device left the team before reading it"),
      reports: relayCount("SELECT COUNT(*) AS n FROM dropped"),
    }).toEqual({ state: "failed", notice: true, reports: 0 });
  }, 20_000);

  it("are re-sent at each welcome until acked; applying a repeat changes nothing", async () => {
    await joinTeam(bob);
    expect(await sees(alice, "bob/codex-api")).toBe(true);
    const failed = stall(bob);
    const id = await send(alice, "claude-web", "bob/codex-api", "are the reports safe?");
    await until(() => failed() && stateAt(alice, id) === "sent", 5_000);
    const frameId = alice.daemon.services.ctx.store.get<{ id: string }>(
      "SELECT id FROM sent_frames WHERE message_id = ?",
      id,
    )?.id as string;
    const client = clientOf(alice);
    client.stop();
    await until(() => !client.connected, 3_000);
    await bob.raw("POST", "/v1/team/leave", {});
    await until(() => relayCount("SELECT COUNT(*) AS n FROM dropped") === 1, 3_000);
    void client.start();
    await until(() => stateAt(alice, id) === "failed", 5_000);
    // the client acked after applying, so the relay removed its copy
    await until(() => relayCount("SELECT COUNT(*) AS n FROM dropped") === 0, 3_000);
    const notices = () =>
      alice.daemon.services.ctx.store
        .all<{ preview: string }>("SELECT preview FROM messages WHERE from_addr = 'agentlink'")
        .filter((n) => n.preview.includes(id.slice(0, 12))).length;
    expect(notices()).toBe(1);
    // a report whose ack died with the socket comes back at the next welcome, a no-op now
    const db = new DatabaseSync(join(relayDir, "relay.db"));
    const team = db
      .prepare("SELECT team_id AS t FROM devices WHERE team_id LIKE 'acme-%' LIMIT 1")
      .get() as { t: string };
    db.prepare(
      "INSERT INTO dropped (team_id, device_id, frame_id, reason, at) VALUES (?, ?, ?, 'removed', ?)",
    ).run(team.t, client.deviceId, frameId, new Date().toISOString());
    db.close();
    client.stop();
    await until(() => !client.connected, 3_000);
    void client.start();
    await until(() => relayCount("SELECT COUNT(*) AS n FROM dropped") === 0, 5_000);
    await sleep(300);
    expect({ state: stateAt(alice, id), notices: notices() }).toEqual({
      state: "failed",
      notices: 1,
    });
  }, 30_000);

  it("stay stored at the relay until acked, even when the sender looked online", async () => {
    await joinTeam(bob);
    expect(await sees(alice, "bob/codex-api")).toBe(true);
    const failed = stall(bob);
    const id = await send(alice, "claude-web", "bob/codex-api", "did the report survive?");
    await until(() => failed() && stateAt(alice, id) === "sent", 5_000);
    const client = clientOf(alice);
    const teamId = client.team.teamId;
    const keys = deviceKeys(alice.paths);
    client.stop();
    await until(() => !client.connected, 3_000);

    // A raw socket stands in for alice's device: it "dies" with the report unacked.
    const hello = () =>
      new Promise<{ ws: WebSocket; frames: { t: string; ids?: string[] }[] }>((resolve, reject) => {
        const ws = new WebSocket(relay.url, { maxPayload: 1024 * 1024 });
        const frames: { t: string; ids?: string[] }[] = [];
        ws.on("message", (data) => {
          const f = JSON.parse(String(data)) as { t: string; ids?: string[] };
          frames.push(f);
          if (f.t === "welcome") resolve({ ws, frames });
        });
        ws.on("open", () => {
          const base = {
            t: "hello",
            teamId,
            ts: Date.now(),
            nonce: randomToken(12),
            deviceId: keys.deviceId,
          };
          ws.send(JSON.stringify({ ...base, sig: signJson(keys, authPayload(base as never)) }));
        });
        ws.on("error", reject);
      });
    const dropped = (f: { t: string; ids?: string[] }[]) =>
      f.filter((x) => x.t === "dropped").flatMap((x) => x.ids ?? []);
    const first = await hello();
    await bob.raw("POST", "/v1/team/leave", {});
    expect(await until(() => dropped(first.frames).length > 0, 3_000)).toBe(true);
    // reported while "online", but still stored: the ack never came
    expect(relayCount("SELECT COUNT(*) AS n FROM dropped")).toBe(1);
    first.ws.terminate();
    const second = await hello();
    expect(await until(() => dropped(second.frames).length > 0, 3_000)).toBe(true);
    second.ws.send(JSON.stringify({ t: "dropped_ack", ids: dropped(second.frames) }));
    expect(await until(() => relayCount("SELECT COUNT(*) AS n FROM dropped") === 0, 3_000)).toBe(
      true,
    );
    const third = await hello();
    await sleep(300);
    expect(dropped(third.frames)).toEqual([]);
    third.ws.close();
    second.ws.close();
    void client.start(); // hand the device back to alice's daemon
    await until(() => client.connected, 5_000);
  }, 30_000);
});

describe("messages from a device missing from the receiver's roster", () => {
  it("are delivered once the roster lists it, without a reconnect", async () => {
    await joinTeam(bob);
    expect(await sees(carol, "bob/codex-api")).toBe(true);
    const client = clientOf(bob);
    client.stop();
    await until(() => !client.connected, 3_000);
    const id = await send(carol, "cursor-ui", "bob/codex-api", "can you review my branch?");
    await until(() => stateAt(carol, id) === "sent", 5_000);
    await carol.raw("POST", "/v1/team/leave", {});
    await sleep(300);
    // bob comes back to a roster without carol: her message waits at the relay
    void client.start();
    await until(() => client.connected, 5_000);
    await sleep(500);
    expect({ has: has(bob, id), queued: queuedFor(bob) }).toEqual({ has: false, queued: 1 });
    await joinTeam(carol);
    await until(() => has(bob, id) && queuedFor(bob) === 0, 5_000);
    expect({ has: has(bob, id), queued: queuedFor(bob), connected: client.connected }).toEqual({
      has: true,
      queued: 0,
      connected: true,
    });
  }, 30_000);

  it("are dropped when the sender never shows up", async () => {
    expect(await sees(carol, "bob/codex-api")).toBe(true);
    const client = clientOf(bob);
    client.unknownSenderMs = 500;
    client.stop();
    await until(() => !client.connected, 3_000);
    const id = await send(carol, "cursor-ui", "bob/codex-api", "still there?");
    await until(() => stateAt(carol, id) === "sent", 5_000);
    await carol.raw("POST", "/v1/team/leave", {});
    await sleep(300);
    void client.start();
    await until(() => client.connected, 5_000);
    await sleep(200);
    expect(queuedFor(bob)).toBe(1);
    await until(() => queuedFor(bob) === 0, 5_000);
    expect({ has: has(bob, id), queued: queuedFor(bob) }).toEqual({ has: false, queued: 0 });
  }, 30_000);
});
