import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/core/log.ts";
import { type RunningRelay, startRelay } from "../../src/relay/server.ts";
import { sleep, startTestDaemon, type TestDaemon, until } from "../helpers.ts";

// When the relay refuses a `send` frame it answers {t:"error", ref:<frame id>}: a rate refusal
// is retried after a pause (receipts share the pace), anything else fails with a sender notice.
let relayDir: string;
let relay: RunningRelay;
let alice: TestDaemon;
let bob: TestDaemon;

beforeAll(async () => {
  relayDir = mkdtempSync(join(tmpdir(), "agentlink-relay-"));
  // A short window keeps the test fast; the client only sees "rate" refusals either way.
  relay = await startRelay({
    dataDir: relayDir,
    port: 0,
    logger: silentLogger,
    rateWindowMs: 2_000,
    sendsPerWindow: 100,
  });
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
  await relay?.close();
  rmSync(relayDir, { recursive: true, force: true });
});

const count = (t: TestDaemon, sql: string) =>
  t.daemon.services.ctx.store.get<{ n: number }>(sql)?.n ?? 0;

describe("relay refusals and retries", () => {
  it("is retried after a rate refusal instead of waiting for a reconnect", async () => {
    const N = 250;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const r = await alice.raw<{ message: { id: string } }>("POST", "/v1/messages", {
        to: ["bob/codex-api"],
        kind: "info",
        text: `build ${i} finished`,
      });
      ids.push(r.data.message.id);
    }
    const arrived = () =>
      ids.filter((id) =>
        bob.daemon.services.ctx.store.get("SELECT 1 FROM messages WHERE id = ?", id),
      ).length;
    await until(
      () => arrived() === N && count(alice, "SELECT COUNT(*) AS n FROM outbox") === 0,
      40_000,
      200,
    );
    expect({
      arrived: arrived(),
      outbox: count(alice, "SELECT COUNT(*) AS n FROM outbox"),
    }).toEqual({
      arrived: N,
      outbox: 0,
    });
    // bob's receipts were paced too: none is left behind
    await until(() => count(bob, "SELECT COUNT(*) AS n FROM outbox") === 0, 20_000, 200);
    expect(count(bob, "SELECT COUNT(*) AS n FROM outbox")).toBe(0);
  }, 90_000);

  it("an inbound message whose handling fails for now stays at the relay for a retry", async () => {
    const client = bob.daemon.services.team.client as NonNullable<
      typeof bob.daemon.services.team.client
    >;
    const queued = () => {
      const db = new DatabaseSync(join(relayDir, "relay.db"));
      const n = (
        db.prepare("SELECT COUNT(*) AS n FROM queue WHERE to_device = ?").get(client.deviceId) as {
          n: number;
        }
      ).n;
      db.close();
      return n;
    };
    await until(() => queued() === 0, 5_000);
    const handle = client.onInbound;
    let failed = false;
    client.onInbound = (msg) => {
      if (!failed && msg.kind === "envelope") {
        failed = true;
        throw new Error("database is locked");
      }
      handle?.(msg);
    };
    const sent = await alice.raw<{ message: { id: string } }>("POST", "/v1/messages", {
      to: ["bob/codex-api"],
      kind: "info",
      text: "deploy finished",
    });
    const id = sent.data.message.id;
    const has = () =>
      !!bob.daemon.services.ctx.store.get("SELECT 1 FROM messages WHERE id = ?", id);
    await until(() => failed);
    await sleep(300); // acks go out in batches
    expect({ has: has(), queued: queued() }).toEqual({ has: false, queued: 1 });
    client.stop(); // the next connection gets it again
    await client.start();
    await until(() => has() && queued() === 0, 5_000);
    expect({ has: has(), queued: queued() }).toEqual({ has: true, queued: 0 });
  });

  it("fails with a notice to the sender when the recipient is no longer in the team", async () => {
    // The relay dropped bob's device, but alice has not heard yet (no roster update).
    const db = new DatabaseSync(join(relayDir, "relay.db"));
    db.prepare("UPDATE devices SET removed_at = ? WHERE member LIKE ?").run(
      new Date().toISOString(),
      '%"handle":"bob"%',
    );
    db.close();
    const sent = await alice.raw<{ message: { id: string } }>(
      "POST",
      "/v1/messages",
      { to: ["bob/codex-api"], kind: "ask", text: "which port does staging use?" },
      { as: "claude-web" },
    );
    const id = sent.data.message.id;
    const state = () => alice.daemon.services.mailbox.deliveriesOf(id)[0]?.state;
    await until(() => state() === "failed", 5_000);
    const notices = alice.daemon.services.ctx.store.all<{ preview: string; envelope: string }>(
      "SELECT preview, envelope FROM messages WHERE from_addr = 'agentlink'",
    );
    const notice = notices.find((n) => n.preview.includes(id.slice(0, 12)))?.envelope ?? "";
    expect({
      state: state(),
      outbox: count(alice, "SELECT COUNT(*) AS n FROM outbox"),
      // the refusal happened here, not on bob's machine
      local: notice.includes("(not sent: the relay refused it") && !notice.includes("machine says"),
    }).toEqual({ state: "failed", outbox: 0, local: true });
  });
});
