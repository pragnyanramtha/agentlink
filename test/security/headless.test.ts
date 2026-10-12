import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeadlessSchema } from "../../src/core/config.ts";
import { type FakeBins, fakeBins } from "../headless-fakes.ts";
import { startTestDaemon, type TestDaemon, until } from "../helpers.ts";

const linux = process.platform === "linux";
let t: TestDaemon;
let bins: FakeBins;

describe("headless runs: who may do what", () => {
  beforeEach(async () => {
    bins = fakeBins();
    t = await startTestDaemon();
  });
  afterEach(async () => {
    await t.stop();
    bins.cleanup();
  });

  async function agent(name: string) {
    const proc = t.fakeAgentProcess("generic");
    await t.client().request("POST", "/v1/agents/register", {
      tool: "generic",
      name,
      pid: proc.pid,
      ...(proc.start ? { pidStart: proc.start } : {}),
    });
    return proc;
  }

  it("an agent can read the settings but never change them, even claiming a terminal", async () => {
    await agent("sneaky");
    expect((await t.raw("GET", "/v1/headless", undefined, { as: "sneaky" })).status).toBe(200);
    for (const body of [
      { enabled: true },
      { runner: { harness: "codex", enabled: true, profile: "full" } },
      { addRoot: t.home },
      { set: { "teammate.wake": "allow" } },
    ]) {
      const res = await t.raw("POST", "/v1/headless", body, { as: "sneaky", tty: true });
      expect(res.status).toBe(403);
    }
    // A person, but not at a terminal: refused too.
    expect((await t.raw("POST", "/v1/headless", { enabled: true })).status).toBe(403);
    expect(t.daemon.services.ctx.config.headless.enabled).toBe(false);
  });

  it("external senders are always refused; teammates are held by default", () => {
    const h = HeadlessSchema.parse({});
    expect(h.from).toEqual({
      local: { wake: "allow", spawn: "allow" },
      teammate: { wake: "hold" },
      external: "refuse",
    });
    expect(() => HeadlessSchema.parse({ from: { external: "allow" } })).toThrow();
    const { headless, registry } = t.daemon.services;
    t.daemon.services.ctx.config.headless = HeadlessSchema.parse({
      enabled: true,
      runners: { codex: { enabled: true } },
      roots: [t.home],
      from: { teammate: { wake: "allow" } },
    });
    const target = registry.register({
      tool: "codex",
      name: "codex-api",
      sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      cwd: t.home,
      state: "offline",
    }).agent;
    expect(() =>
      headless.request({
        agent: target,
        requester: { addr: "a2a:stranger", agentId: null, trust: "external" },
      }),
    ).toThrow(/may not wake/);
  });

  it("a person can't set an unknown key or a dangerous binary path", async () => {
    const bad = [
      { set: { "teammate.spawn": "allow" } },
      { runner: { harness: "codex", bin: "codex" } }, // relative: never resolved from PATH here
      { runner: { harness: "codex", model: "-c sandbox_mode=danger-full-access" } },
      { addRoot: "/" },
      { runner: { harness: "devin", enabled: true } },
    ];
    for (const body of bad) {
      const res = await t.raw("POST", "/v1/headless", body, { tty: true });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe.skipIf(!linux)("a headless child is its agent, never the human (kernel-verified)", () => {
  beforeEach(async () => {
    bins = fakeBins();
    t = await startTestDaemon({ verifyCallers: true });
  });
  afterEach(async () => {
    await t.stop();
    bins.cleanup();
  });

  it("the spawned process cannot read approvals or change settings", async () => {
    t.daemon.services.ctx.config.headless = HeadlessSchema.parse({
      enabled: true,
      runners: { claude: { enabled: true } },
      roots: [t.home],
    });
    bins.mode("probe");
    const res = await t.raw("POST", "/v1/spawn", {
      harness: "claude",
      cwd: t.home,
      task: "try to approve yourself",
    });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const probe = await until(() => bins.read("R1", "probe"), 10_000);
    expect(probe?.trim()).toBe("403 403");
    expect(t.daemon.services.ctx.config.headless.enabled).toBe(true);
  });
});
