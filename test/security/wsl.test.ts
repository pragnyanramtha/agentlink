import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "../../src/cli/client.ts";
import { silentLogger } from "../../src/core/log.ts";
import { type Paths, resolvePaths } from "../../src/core/paths.ts";
import { type RunningDaemon, startDaemon } from "../../src/daemon/main.ts";
import type { UiOptions } from "../../src/daemon/ui-server.ts";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";
import { uiFetch } from "../ui-helpers.ts";

const linux = process.platform === "linux";
const dirs: string[] = [];
let t: TestDaemon | undefined;
let d: RunningDaemon | undefined;
const savedPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = savedPath;
  await t?.stop();
  await d?.close();
  t = undefined;
  d = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlink-wslsec-"));
  dirs.push(dir);
  return dir;
};

describe.skipIf(!linux)("the caller check uses the system's ss only", () => {
  it("never runs an `ss` placed earlier on PATH (it could name anyone as the caller)", async () => {
    const bin = tempDir();
    const marker = join(bin, "ran");
    writeFileSync(join(bin, "ss"), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
    chmodSync(join(bin, "ss"), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    t = await startTestDaemon({ verifyCallers: true });
    const health = await t.raw("GET", "/v1/health");
    expect(health.status).toBe(200);
    // the real ss named this process; the fake one never ran
    await t.client().request("POST", "/v1/agents/register", {
      tool: "generic",
      name: "probe",
      pid: process.pid,
    });
    expect((await t.raw<{ agents: unknown[] }>("GET", "/v1/agents")).status).toBe(200);
    expect(existsSync(marker)).toBe(false);
  });
});

/** A daemon whose web UI sees connections as `ui` says. */
async function uiDaemon(ui: UiOptions): Promise<{ port: number; path: string }> {
  const home = tempDir();
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ handle: "tester", wake: { tmux: false } }),
  );
  d = await startDaemon({
    paths: resolvePaths({ AGENTLINK_HOME: home, HOME: home } as NodeJS.ProcessEnv),
    logger: silentLogger,
    trustClientCaller: true,
    ui,
  });
  const svc = d.services.ui;
  if (!svc) throw new Error("no ui service");
  const url = new URL((await svc.session()).url);
  return { port: Number(url.port), path: url.pathname + url.search };
}

describe("the web UI under WSL 2", () => {
  it("lets in a Windows browser (no visible Linux process), still only with the login link", async () => {
    const s = await uiDaemon({ wsl: 2, peerPids: async () => ({ pids: [] }) });
    expect((await uiFetch(s.port, "/login?t=wrong")).status).not.toBe(303);
    expect((await uiFetch(s.port, s.path)).status).toBe(303);
  });

  it("still refuses an unnamed connection off WSL, and when the lookup failed", async () => {
    const off = await uiDaemon({ wsl: 0, peerPids: async () => ({ pids: [] }) });
    const res = await uiFetch(off.port, off.path);
    expect(res.status).toBe(403);
    expect(res.text).toContain("cannot tell which process");
    await d?.close();
    const failed = await uiDaemon({ wsl: 2, peerPids: async () => ({ pids: [], failed: true }) });
    expect((await uiFetch(failed.port, failed.path)).status).toBe(403);
  });

  it("still refuses a visible process inside an agent's tree", async () => {
    const s = await uiDaemon({ wsl: 2, peerPids: async () => ({ pids: [process.pid] }) });
    await new Client(d?.services.ctx.paths as Paths).request("POST", "/v1/agents/register", {
      tool: "generic",
      name: "sneaky",
      pid: process.pid,
    });
    const res = await uiFetch(s.port, s.path);
    expect(res.status).toBe(403);
    expect(res.text).toContain("sneaky");
  });
});
