import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/core/log.ts";
import { type RunningRelay, startRelay } from "../../src/relay/server.ts";
import { sleep, startTestDaemon, type TestDaemon, until } from "../helpers.ts";

// Teams are created, joined and left while agents run: no agent restart.
let relayDir: string;
let relay: RunningRelay;
let alice: TestDaemon;
let bob: TestDaemon;
let carol: TestDaemon;
const wakes: string[] = [];
const agents = new Map<TestDaemon, { proc: { pid: number; start?: string }; name: string }>();

async function startAgent(t: TestDaemon, session: string) {
  const proc = t.fakeAgentProcess("claude");
  await t.hook("claude", "session-start", { session_id: session }, proc);
  const { agents: list } = await t
    .client()
    .request<{ agents: { name: string; pid: number }[] }>("GET", "/v1/agents");
  const name = list.find((a) => a.pid === proc.pid)?.name as string;
  agents.set(t, { proc, name });
  // A wake/push deliverer that would see any attempt to wake or push to the agent.
  t.daemon.services.engine.use({
    id: "spy",
    pushAlways: true,
    canWake: () => true,
    wake: async (a) => {
      wakes.push(a.name);
      return { consumed: false };
    },
  });
  return name;
}

/** What the agent's next prompt brings into its context. */
async function nextPrompt(t: TestDaemon): Promise<string> {
  const a = agents.get(t);
  if (!a) throw new Error("no agent");
  const res = await t.hook<{ stdout?: string }>(
    "claude",
    "prompt-submit",
    { session_id: `${t.home}-s`, prompt: "go on" },
    a.proc,
  );
  return res.stdout ?? "";
}

beforeAll(async () => {
  relayDir = mkdtempSync(join(tmpdir(), "agentlink-relay-"));
  relay = await startRelay({ dataDir: relayDir, port: 0, logger: silentLogger, pageStallMs: 500 });
  alice = await startTestDaemon({ handle: "alice" });
  bob = await startTestDaemon({ handle: "bob" });
  carol = await startTestDaemon({ handle: "carol" });
  for (const t of [alice, bob, carol]) await startAgent(t, `${t.home}-s`);
}, 30_000);

afterAll(async () => {
  await alice?.stop();
  await bob?.stop();
  await carol?.stop();
  await relay?.close();
  rmSync(relayDir, { recursive: true, force: true });
});

describe("live team changes", () => {
  let invite = "";

  it("tells running agents their team address after create, once", async () => {
    const created = await alice.raw("POST", "/v1/team/create", { name: "acme", relay: relay.url });
    expect(created.status).toBe(200);
    const name = agents.get(alice)?.name;
    const text = await until(() => nextPrompt(alice), 3_000);
    expect(text).toContain("created team acme as @alice");
    expect(text).toContain(`reach you as alice/${name}`);
    expect(await nextPrompt(alice)).not.toContain("team acme");
  });

  it("tells running agents their address and teammates' agents after join", async () => {
    const inv = await alice.raw<{ invite: string }>("POST", "/v1/team/invite", { uses: 1 });
    invite = inv.data.invite;
    const joined = await bob.raw<{ team: { handle: string } }>("POST", "/v1/team/join", { invite });
    expect(joined.status).toBe(200);
    const text = await until(() => nextPrompt(bob), 5_000);
    expect(text).toContain("joined team acme as @bob");
    expect(text).toContain(`reach you as bob/${agents.get(bob)?.name}`);
    expect(text).toContain(`alice/${agents.get(alice)?.name}`);
    // Only this machine's own membership change is announced, not teammates joining.
    await sleep(500);
    expect(await nextPrompt(alice)).not.toContain("team acme");
  });

  it("rolls back a failed join", async () => {
    const before = await carol.client().request<Record<string, unknown>>("GET", "/v1/whoami");
    const used = await carol.raw("POST", "/v1/team/join", { invite });
    expect(used.status).toBeGreaterThanOrEqual(400);
    const after = await carol.client().request<Record<string, unknown>>("GET", "/v1/whoami");
    expect(after).toMatchObject({ team: null, handle: "carol" });
    expect(after.team).toBe(before.team);
    const status = await carol.client().request<{ team: unknown }>("GET", "/v1/team");
    expect(status.team).toBeNull();
    expect(carol.daemon.services.team.client).toBeUndefined();
    expect(await nextPrompt(carol)).not.toContain("team");
    // the next attempt starts clean
    const inv = await alice.raw<{ invite: string }>("POST", "/v1/team/invite", { uses: 1 });
    const ok = await carol.raw("POST", "/v1/team/join", { invite: inv.data.invite });
    expect(ok.status).toBe(200);
    expect(await until(() => nextPrompt(carol), 5_000)).toContain("joined team acme as @carol");
  });

  it("tells an agent to ask its user to leave first", async () => {
    const again = await bob.raw(
      "POST",
      "/v1/team/create",
      { name: "other", relay: relay.url },
      { as: agents.get(bob)?.name as string },
    );
    expect(again.status).toBe(400);
    expect(JSON.stringify(again.data)).toContain(
      "ask your user to run `agentlink team leave` in a terminal",
    );
  });

  it("tells running agents when this machine leaves", async () => {
    const left = await carol.raw("POST", "/v1/team/leave", {});
    expect(left.status).toBe(200);
    const text = await nextPrompt(carol);
    expect(text).toContain("left team acme");
    expect(text).toContain("can no longer reach you");
  });

  it("never wakes or pushes to idle agents for team notices", async () => {
    expect(wakes).toEqual([]);
    for (const t of [alice, bob, carol])
      expect(t.daemon.services.ctx.store.all("SELECT * FROM wake_log")).toEqual([]);
  });
});
