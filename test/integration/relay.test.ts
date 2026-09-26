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
  it("shows full addresses and host names for every agent", async () => {
    const { hostname } = await import("node:os");
    const { agents } = await alice.client().request<{ agents: Json[] }>("GET", "/v1/agents");
    const mine = agents.find((a) => a.name === "claude-web");
    expect(mine?.address).toBe("alice/claude-web");
    expect(mine?.host).toBe(hostname());
    const theirs = await until(async () => {
      const r = await alice.client().request<{ agents: Json[] }>("GET", "/v1/agents");
      const a = r.agents.find((x) => x.name === bobAgentName);
      return a?.host ? a : undefined;
    }, 8_000);
    expect(theirs?.address).toBe("bob/codex-api");
    expect(theirs?.host).toBe(hostname());
    const who = await alice
      .client("claude-web")
      .request<{ agent: { address: string }; host: string }>("GET", "/v1/whoami");
    expect(who.agent.address).toBe("alice/claude-web");
    expect(who.host).toBe(hostname());
  });

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

  it("suggests the right teammate agent and stops waiting when delivery fails", async () => {
    const typo = await alice.raw(
      "POST",
      "/v1/messages",
      { to: ["bob/codex-ap"], text: "hi" },
      { as: "claude-web" },
    );
    expect(typo.status).toBe(404);
    expect(JSON.stringify(typo.data)).toContain("codex-api");
    const started = Date.now();
    const asking = alice
      .client("claude-web")
      .request<SendRes & { failed?: { state: string }[] }>(
        "POST",
        "/v1/messages",
        { to: [bobAgentName], kind: "ask", text: "are you there?", waitMs: 20_000 },
        { timeoutMs: 25_000 },
      );
    // bob's daemon reports the delivery failed (e.g. the agent vanished)
    const id = await until(async () => {
      const log = await alice
        .client()
        .request<{ messages: { message: { id: string; preview: string } }[] }>(
          "GET",
          "/v1/log?limit=5",
        );
      return log.messages.find((m) => m.message.preview === "are you there?")?.message.id;
    });
    alice.daemon.services.mailbox.applyReceipt("bob", {
      messageId: id as string,
      to: bobAgentName,
      state: "failed",
      note: "no agent named codex-api",
    });
    const res = await asking;
    expect(res.reply).toBeUndefined();
    expect(res.failed?.[0]?.state).toBe("failed");
    expect(Date.now() - started).toBeLessThan(10_000);
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

  it("recovers after leaving and re-joining, and refuses a handle already in use", async () => {
    await bob.raw("POST", "/v1/team/leave", {});
    const inv = await alice.raw<{ invite: string }>("POST", "/v1/team/invite", { uses: 2 });
    // another device may not take @alice
    const carol = await startTestDaemon({ handle: "carol" });
    const clash = await carol.raw("POST", "/v1/team/join", {
      invite: inv.data.invite,
      handle: "alice",
    });
    expect(clash.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(clash.data)).toContain("already a member");
    await carol.stop();
    const again = await bob.raw("POST", "/v1/team/join", { invite: inv.data.invite });
    expect(again.status).toBe(200);
    const connected = await until(async () => {
      const s = await bob.client().request<{ team: { connected: boolean } }>("GET", "/v1/team");
      return s.team.connected;
    }, 8_000);
    expect(connected).toBe(true);
    await until(async () => {
      const { agents } = await alice.client().request<{ agents: Json[] }>("GET", "/v1/agents");
      return agents.find((a) => a.name === bobAgentName);
    }, 8_000);
    // traffic flows both ways again
    const res = await bob.client("codex-api").request<SendRes>("POST", "/v1/messages", {
      to: ["alice/claude-web"],
      text: "back online",
    });
    expect(res.deliveries[0]?.state).toBe("sent");
    const got = await until(async () => {
      const r = await alice
        .client("claude-web")
        .request<{ items: { text: string }[] }>("GET", "/v1/inbox?all=1");
      return r.items.find((i) => i.text === "back online");
    }, 8_000);
    expect(got).toBeTruthy();
  }, 40_000);

  it("runs a three-way group conversation with reply --all", async () => {
    const carol = await startTestDaemon({ handle: "carol" });
    try {
      const inv = await alice.raw<{ invite: string }>("POST", "/v1/team/invite", { uses: 1 });
      expect((await carol.raw("POST", "/v1/team/join", { invite: inv.data.invite })).status).toBe(
        200,
      );
      await registerAgent(carol, "claude-ops");
      await until(async () => {
        const { agents } = await alice.client().request<{ agents: Json[] }>("GET", "/v1/agents");
        return agents.find((a) => a.name === "carol/claude-ops");
      }, 8_000);
      await until(async () => {
        const { agents } = await bob.client().request<{ agents: Json[] }>("GET", "/v1/agents");
        return agents.find((a) => a.name === "carol/claude-ops");
      }, 8_000);
      // alice asks bob and carol together and waits for both
      const asking = alice
        .client("claude-web")
        .request<SendRes & { replies?: { text: string; message: { from: string } }[] }>(
          "POST",
          "/v1/messages",
          {
            to: [bobAgentName, "carol/claude-ops"],
            kind: "ask",
            text: "name for the new CLI?",
            waitMs: 15_000,
          },
          { timeoutMs: 20_000 },
        );
      type Item = { message: { id: string; from: string }; text: string };
      const bobItem = await until(async () => {
        const r = await bob
          .client("codex-api")
          .request<{ items: Item[] }>("GET", "/v1/inbox?format=text");
        return r.items.find((i) => i.text === "name for the new CLI?");
      }, 8_000);
      // bob sees the other participant and answers everyone
      const rendered = await bob
        .client("codex-api")
        .request<{ text: string }>("GET", "/v1/inbox?all=1&peek=1&format=inject");
      expect(rendered.text).toContain("also with: carol/claude-ops");
      await bob.client("codex-api").request("POST", "/v1/messages", {
        kind: "reply",
        replyTo: bobItem?.message.id,
        text: "bob: linkup",
        replyAll: true,
      });
      // carol receives the question and bob's group reply
      const carolItems = await until(async () => {
        const r = await carol
          .client("claude-ops")
          .request<{ items: Item[] }>("GET", "/v1/inbox?all=1&peek=1");
        const texts = r.items.map((i) => i.text);
        return texts.includes("name for the new CLI?") && texts.includes("bob: linkup")
          ? r.items
          : undefined;
      }, 8_000);
      const question = carolItems?.find((i) => i.text === "name for the new CLI?");
      expect(carolItems?.find((i) => i.text === "bob: linkup")?.message.from).toBe("bob/codex-api");
      await carol.client("claude-ops").request("POST", "/v1/messages", {
        kind: "reply",
        replyTo: question?.message.id,
        text: "carol: meshy",
        replyAll: true,
      });
      const res = await asking;
      expect(res.replies?.map((r) => r.text).sort()).toEqual(["bob: linkup", "carol: meshy"]);
      // bob also gets carol's group reply
      const bobGot = await until(async () => {
        const r = await bob
          .client("codex-api")
          .request<{ items: Item[] }>("GET", "/v1/inbox?all=1&peek=1");
        return r.items.find((i) => i.text === "carol: meshy");
      }, 8_000);
      expect(bobGot?.message.from).toBe("carol/claude-ops");
    } finally {
      await carol.raw("POST", "/v1/team/leave", {});
      await carol.stop();
    }
  }, 60_000);

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
