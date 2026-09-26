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
  relay = await startRelay({ dataDir: relayDir, port: 0, logger: silentLogger, pageStallMs: 500 });
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
    // an agent cannot override the scan; its user can
    const agentForced = await alice.raw(
      "POST",
      "/v1/messages",
      { to: [bobAgentName], text: "key AKIAABCDEFGHIJKLMNOP", force: true },
      { as: "claude-web" },
    );
    expect(agentForced.status).toBe(400);
    const humanForced = await alice.raw("POST", "/v1/messages", {
      to: [bobAgentName],
      text: "key AKIAABCDEFGHIJKLMNOP",
      force: true,
    });
    expect(humanForced.status).toBe(200);
    // secrets hide in files and data too
    const inFile = await alice.raw("POST", "/v1/messages", {
      to: [bobAgentName],
      parts: [
        {
          kind: "file",
          file: {
            name: "notes.txt",
            bytes: Buffer.from("token ghp_" + "a".repeat(36)).toString("base64"),
          },
        },
      ],
    });
    expect(inFile.status).toBe(400);
    const keyFile = await alice.raw("POST", "/v1/messages", {
      to: [bobAgentName],
      parts: [
        { kind: "file", file: { name: "id_rsa", bytes: Buffer.from("hello").toString("base64") } },
      ],
    });
    expect(keyFile.status).toBe(400);
    const url = await alice.raw("POST", "/v1/messages", {
      to: [bobAgentName],
      text: "DATABASE_URL=postgres://admin:S3cretPass@db.internal:5432/prod",
    });
    expect(url.status).toBe(400);
    // status text is shared with teammates, so it is scanned as well
    const doing = await alice.raw(
      "POST",
      "/v1/agents/status",
      { text: "debugging with AKIAIOSFODNN7EXAMPLE" },
      { as: "claude-web" },
    );
    expect(doing.status).toBe(400);
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
      expect(rendered.text).toContain("Group: also carol/claude-ops");
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

  it("keeps old names working across machines after a rename", async () => {
    await registerAgent(bob, "codex-old");
    await until(async () => {
      const { agents } = await alice.client().request<{ agents: Json[] }>("GET", "/v1/agents");
      return agents.find((a) => a.name === "bob/codex-old");
    }, 8_000);
    await bob.client("codex-old").request("POST", "/v1/agents/rename", { name: "codex-new" });
    await until(async () => {
      const { agents } = await alice.client().request<{ agents: Json[] }>("GET", "/v1/agents");
      return agents.find((a) => a.name === "bob/codex-new");
    }, 8_000);
    const res = await alice.client("claude-web").request<SendRes>("POST", "/v1/messages", {
      to: ["bob/codex-old"],
      text: "still reachable under the old name?",
    });
    expect(res.deliveries[0]?.to).toBe("bob/codex-new");
    const got = await until(async () => {
      const r = await bob
        .client("codex-new")
        .request<{ items: { text: string }[] }>("GET", "/v1/inbox?all=1");
      return r.items.find((i) => i.text === "still reachable under the old name?");
    }, 8_000);
    expect(got).toBeTruthy();
  });

  it("a teammate's denial reaches the agent that sent the request", async () => {
    await bob.raw(
      "POST",
      "/v1/policy",
      { scope: "teammate", kind: "request", action: "hold" },
      { tty: true },
    );
    const res = await alice.client("claude-web").request<SendRes>("POST", "/v1/messages", {
      to: [bobAgentName],
      kind: "request",
      text: "please deploy to prod",
    });
    const held = await until(async () => {
      const r = await bob.raw<{ items: { delivery: { id: number } }[] }>(
        "GET",
        "/v1/approvals",
        undefined,
        { tty: true },
      );
      return r.data.items[0];
    }, 8_000);
    await bob.raw(
      "POST",
      `/v1/approvals/${held?.delivery.id}`,
      { decision: "deny" },
      { tty: true },
    );
    const notice = await until(async () => {
      const r = await alice
        .client("claude-web")
        .request<{ items: { text: string }[] }>("GET", "/v1/inbox");
      return r.items.find(
        (i) => i.text.includes(res.message.id.slice(0, 12)) && i.text.includes("refused"),
      );
    }, 8_000);
    expect(notice).toBeTruthy();
    await bob.raw(
      "POST",
      "/v1/policy",
      { scope: "teammate", kind: "request", action: "deliver" },
      { tty: true },
    );
  });

  it("joins with a short invite code, which works only once", async () => {
    const res = await alice
      .client()
      .request<{ code: string; invite: string }>("POST", "/v1/team/invite", { uses: 1 });
    expect(res.code).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{2}$/);
    const dave = await startTestDaemon({ handle: "dave" });
    const eve = await startTestDaemon({ handle: "eve" });
    try {
      const joined = await dave.raw<{ team: { name: string; handle: string } }>(
        "POST",
        "/v1/team/join",
        {
          invite: res.code,
          relay: relay.url,
        },
      );
      expect(joined.status).toBe(200);
      expect(joined.data.team.handle).toBe("dave");
      const again = await eve.raw("POST", "/v1/team/join", { invite: res.code, relay: relay.url });
      expect(again.status).toBe(400);
      expect(JSON.stringify(again.data)).toContain("no such invite code");
    } finally {
      await dave.raw("POST", "/v1/team/leave", {});
      await dave.stop();
      await eve.stop();
    }
  }, 30_000);

  it("agents may create invites and join (their CLI asks the user), but never relay invite codes", async () => {
    const inv = await alice.raw<{ code: string; invite: string }>(
      "POST",
      "/v1/team/invite",
      {},
      { as: "claude-web" },
    );
    expect(inv.status).toBe(200);
    for (const text of [`join us: ${inv.data.code}`, `invite ${inv.data.invite}`]) {
      const leak = await alice.raw(
        "POST",
        "/v1/messages",
        { to: [bobAgentName], text },
        { as: "claude-web" },
      );
      expect(leak.status).toBe(400);
      expect(JSON.stringify(leak.data)).toContain("invites are for people");
    }
    // ordinary hyphenated text is fine
    const ok = await alice.raw(
      "POST",
      "/v1/messages",
      { to: [bobAgentName], text: "see fix-the-auth-bug-12" },
      { as: "claude-web" },
    );
    expect(ok.status).toBe(200);
  });

  it("inviting without a team starts one on the default relay", async () => {
    const before = process.env.AGENTLINK_RELAY;
    process.env.AGENTLINK_RELAY = relay.url; // never the real community relay in tests
    const solo = await startTestDaemon({ handle: "solo" });
    try {
      const inv = await solo.raw<{ code: string }>("POST", "/v1/team/invite", {});
      expect(inv.status).toBe(200);
      expect(inv.data.code).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{2}$/);
      const team = await solo
        .client()
        .request<{ team: { name: string; admin: boolean; relay: string } }>("GET", "/v1/team");
      expect(team.team.admin).toBe(true);
      expect(team.team.relay).toBe(relay.url);
    } finally {
      if (before === undefined) delete process.env.AGENTLINK_RELAY;
      else process.env.AGENTLINK_RELAY = before;
      await solo.raw("POST", "/v1/team/leave", {});
      await solo.stop();
    }
  }, 30_000);

  it("rejects unknown team members and needs a team for team addresses", async () => {
    const res = await alice.raw(
      "POST",
      "/v1/messages",
      { to: ["carol/claude"], text: "hi" },
      { as: "claude-web" },
    );
    expect(res.status).toBe(404);
  });

  it("asking a teammate's agent whose session ended returns at once (its daemon is still up)", async () => {
    const gone = await registerAgent(bob, "short-lived");
    await until(async () => {
      const { agents } = await alice.client().request<{ agents: Json[] }>("GET", "/v1/agents");
      return agents.find((a) => a.name === "bob/short-lived" && a.state === "idle");
    }, 8_000);
    gone.kill();
    await until(async () => {
      const { agents } = await alice
        .client()
        .request<{ agents: Json[] }>("GET", "/v1/agents?all=1");
      return agents.find((a) => a.name === "bob/short-lived" && a.state === "offline");
    }, 15_000);
    const started = Date.now();
    const res = await alice
      .client("claude-web")
      .request<SendRes & { offline?: boolean }>(
        "POST",
        "/v1/messages",
        { to: ["bob/short-lived"], kind: "ask", text: "still there?", waitMs: 20_000 },
        { timeoutMs: 25_000 },
      );
    expect(res.offline).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 40_000);

  it("delivers a backlog longer than one page after a device comes back", async () => {
    const home = bob.home;
    await bob.stop(true);
    const total = 520; // the relay sends queued messages in pages of 500
    for (let i = 0; i < total; i++) {
      await alice.client().request("POST", "/v1/messages", { to: ["@bob"], text: `backlog ${i}` });
    }
    // A full page of messages bob will never ack (from a device not in its roster) sits in front
    // of the backlog; it must not stop the rest from arriving.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(relayDir, "relay.db"));
    const dev = db
      .prepare("SELECT team_id, device_id FROM devices WHERE member LIKE ? AND removed_at IS NULL")
      .get('%"handle":"bob"%') as { team_id: string; device_id: string };
    const insert = db.prepare(
      "INSERT INTO queue (id, team_id, to_device, from_device, blob, bytes, at) VALUES (?, ?, ?, 'dev_ghost', '{}', 2, ?)",
    );
    for (let i = 0; i < 500; i++) {
      insert.run(
        `ghost-${i}`,
        dev.team_id,
        dev.device_id,
        `2000-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`,
      );
    }
    db.close();
    bob = await startTestDaemon({ handle: "bob", home });
    const got = await until(async () => {
      const r = await bob
        .client()
        .request<{ messages: { message: { preview: string } }[] }>("GET", "/v1/log?limit=500");
      const n = r.messages.filter((m) => m.message.preview.startsWith("backlog ")).length;
      return n >= 500 ? n : undefined;
    }, 30_000);
    expect(got).toBeGreaterThanOrEqual(500);
    const last = await until(async () => {
      const r = await bob
        .client()
        .request<{ messages: { message: { preview: string } }[] }>("GET", "/v1/log?limit=5");
      return r.messages.find((m) => m.message.preview === `backlog ${total - 1}`);
    }, 30_000);
    expect(last).toBeTruthy();
    aliceAgent.kill();
  }, 120_000);
});
