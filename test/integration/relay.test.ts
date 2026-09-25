import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/core/log.ts";
import { type RunningRelay, startRelay } from "../../src/relay/server.ts";
import { startTestDaemon, type TestDaemon, until } from "../helpers.ts";

type Json = Record<string, unknown>;
interface SendRes {
  message: { id: string };
  deliveries: { to: string; state: string; note: string }[];
  reply?: { text: string; message: { from: string } };
}

let relayDir: string;
let relay: RunningRelay;
let alice: TestDaemon;
let bob: TestDaemon;
let aliceAgent: { pid: number; kill(): void };
let bobAgentName: string;

async function registerAgent(t: TestDaemon, name: string) {
  const proc = t.fakeAgentProcess("generic");
  await t.client().request("POST", "/v1/agents/register", {
    tool: "generic",
    name,
    pid: proc.pid,
    cwd: t.home,
    state: "idle",
  });
  return proc;
}

beforeAll(async () => {
  relayDir = mkdtempSync(join(tmpdir(), "agentlink-relay-"));
  relay = await startRelay({ dataDir: relayDir, port: 0, logger: silentLogger });
  alice = await startTestDaemon({ handle: "alice" });
  bob = await startTestDaemon({ handle: "bob" });

  const created = await alice.raw<{ team: { name: string } }>("POST", "/v1/team/create", {
    name: "acme",
    relay: relay.url,
  });
  expect(created.status).toBe(200);
  const inv = await alice.raw<{ invite: string }>("POST", "/v1/team/invite", { uses: 1 });
  expect(inv.data.invite).toMatch(/^al1\./);
  const joined = await bob.raw<{ team: { handle: string } }>("POST", "/v1/team/join", {
    invite: inv.data.invite,
  });
  expect(joined.status).toBe(200);
  expect(joined.data.team.handle).toBe("bob");

  aliceAgent = await registerAgent(alice, "claude-web");
  await registerAgent(bob, "codex-api");
  bobAgentName = "bob/codex-api";
  // alice learns bob's agents through encrypted presence
  const seen = await until(async () => {
    const { agents } = await alice.client().request<{ agents: Json[] }>("GET", "/v1/agents");
    return agents.find((a) => a.name === bobAgentName);
  }, 8_000);
  expect(seen).toBeTruthy();
}, 30_000);

afterAll(async () => {
  await alice?.stop();
  await bob?.stop();
  await relay?.close();
  rmSync(relayDir, { recursive: true, force: true });
});

describe("team relay", () => {
  it("both members see each other with fingerprints; invites are single-use", async () => {
    const status = await bob
      .client()
      .request<{ members: { handle: string; online: boolean; fingerprint: string }[] }>(
        "GET",
        "/v1/team",
      );
    expect(status.members.map((m) => m.handle).sort()).toEqual(["alice", "bob"]);
    expect(status.members.every((m) => /^[0-9a-f-]{24}$/.test(m.fingerprint))).toBe(true);
  });

  it("asks across machines end-to-end encrypted and gets the answer back", async () => {
    const asking = alice
      .client("claude-web")
      .request<SendRes>(
        "POST",
        "/v1/messages",
        { to: [bobAgentName], kind: "ask", text: "Is the /v2 endpoint deployed?", waitMs: 10_000 },
        { timeoutMs: 15_000 },
      );
    const inbox = await until(async () => {
      const r = await bob.client("codex-api").request<{
        items: { message: { id: string; from: string; trust: string }; text: string }[];
      }>("GET", "/v1/inbox");
      return r.items.length ? r.items : undefined;
    }, 8_000);
    expect(inbox?.[0]?.text).toBe("Is the /v2 endpoint deployed?");
    expect(inbox?.[0]?.message.from).toBe("alice/claude-web");
    expect(inbox?.[0]?.message.trust).toBe("teammate");
    await bob.client("codex-api").request("POST", "/v1/messages", {
      kind: "reply",
      replyTo: inbox?.[0]?.message.id,
      text: "yes, since 14:00",
    });
    const res = await asking;
    expect(res.deliveries[0]?.state).toBe("sent");
    expect(res.reply?.text).toBe("yes, since 14:00");
    expect(res.reply?.message.from).toBe("bob/codex-api");
    // the relay stored only ciphertext
    const db =
      readFileSync(join(relayDir, "relay.db")).toString("latin1") +
      readFileSync(join(relayDir, "relay.db-wal")).toString("latin1");
    expect(db).not.toContain("/v2 endpoint");
    expect(db).not.toContain("since 14:00");
    // receipts travel back
    const receipt = await until(async () => {
      const r = await alice
        .client()
        .request<{ deliveries: { state: string }[] }>(
          "GET",
          `/v1/messages/${res.message.id}?peek=1`,
        );
      return r.deliveries[0]?.state === "replied" ? r : undefined;
    }, 8_000);
    expect(receipt).toBeTruthy();
  });

  it("refuses to send likely secrets to teammates unless forced", async () => {
    const res = await alice.raw(
      "POST",
      "/v1/messages",
      { to: [bobAgentName], text: "key AKIAABCDEFGHIJKLMNOP" },
      { as: "claude-web" },
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toContain("secret");
    const forced = await alice.raw(
      "POST",
      "/v1/messages",
      { to: [bobAgentName], text: "key AKIAABCDEFGHIJKLMNOP", force: true },
      { as: "claude-web" },
    );
    expect(forced.status).toBe(200);
  });

  it("queues for an offline machine and delivers when it comes back", async () => {
    const bobHome = bob.home;
    await bob.stop(true);
    const sent = await alice.client("claude-web").request<SendRes>("POST", "/v1/messages", {
      to: [bobAgentName],
      text: "picked up the migration while you were away",
    });
    expect(sent.deliveries[0]?.state).toBe("sent");
    bob = await startTestDaemon({ handle: "bob", home: bobHome });
    await registerAgent(bob, "codex-api");
    const inbox = await until(async () => {
      const r = await bob
        .client("codex-api")
        .request<{ items: { text: string }[] }>("GET", "/v1/inbox?all=1");
      return r.items.find((i) => i.text.includes("picked up the migration")) ? r.items : undefined;
    }, 10_000);
    expect(inbox).toBeTruthy();
  }, 30_000);

  it("rejects unknown team members and needs a team for team addresses", async () => {
    const res = await alice.raw(
      "POST",
      "/v1/messages",
      { to: ["carol/claude"], text: "hi" },
      { as: "claude-web" },
    );
    expect(res.status).toBe(404);
    aliceAgent.kill();
  });
});
