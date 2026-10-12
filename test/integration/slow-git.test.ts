import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeBins, fakeBins } from "../headless-fakes.ts";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";

// Found by scripts/sim with --slow-git-ms 450: reading a repo runs up to 4 `git` calls; run
// synchronously on a request path they stall every other request to the daemon (hooks time out).
const GIT_MS = 700;
let t: TestDaemon;
let bins: FakeBins;
let gitDir: string;
let repo: string;
const savedPath = process.env.PATH;
beforeEach(async () => {
  gitDir = mkdtempSync(join(tmpdir(), "agentlink-slowgit-"));
  writeFileSync(
    join(gitDir, "git"),
    `#!/bin/bash\nsleep ${GIT_MS / 1000}\nexec /usr/bin/git "$@"\n`,
  );
  chmodSync(join(gitDir, "git"), 0o755);
  bins = fakeBins();
  t = await startTestDaemon();
  repo = join(t.home, "repo");
  mkdirSync(repo);
  execFileSync("/usr/bin/git", ["init", "-q", "-b", "main"], { cwd: repo });
  process.env.PATH = `${gitDir}:${savedPath}`;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  await t.stop();
  bins.cleanup();
  rmSync(gitDir, { recursive: true, force: true });
});

/** GET /v1/health from another process after `delayMs`, timed there (this loop is the daemon's). */
function healthFromOutside(socket: string, delayMs: number): Promise<number> {
  const script = `setTimeout(()=>{const t=Date.now();require("node:http").get({socketPath:${JSON.stringify(socket)},path:"/v1/health"},r=>{r.resume();r.on("end",()=>console.log(Date.now()-t))})},${delayMs})`;
  return new Promise((resolve, reject) =>
    execFile(process.execPath, ["-e", script], (e, out) => (e ? reject(e) : resolve(Number(out)))),
  );
}

/** Runs `request` while another process asks the daemon for its health; returns both times. */
async function alongside(request: () => Promise<unknown>): Promise<{ ms: number; health: number }> {
  const other = healthFromOutside(t.paths.socket, 300);
  const started = Date.now();
  await request();
  const ms = Date.now() - started;
  return { ms, health: await other };
}

describe("a slow git repo", () => {
  it("does not stall the daemon while a session starts there, and is read in one round", async () => {
    const proc = t.fakeAgentProcess("claude");
    const { ms, health } = await alongside(() =>
      t.hook("claude", "session-start", { session_id: "s-slow", cwd: repo }, proc),
    );
    expect(ms).toBeGreaterThan(GIT_MS - 100); // git really was slow
    expect(ms).toBeLessThan(GIT_MS * 1.7); // its calls run side by side, not one after another
    expect(health).toBeLessThan(GIT_MS - 200);
    expect(t.daemon.services.registry.bySession("claude", "s-slow")?.repo_root).toBe(repo);
  });

  it("does not stall the daemon while an agent registers there", async () => {
    const { ms, health } = await alongside(async () => {
      const res = await t.raw("POST", "/v1/agents/register", { tool: "generic", cwd: repo });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
    });
    expect(ms).toBeGreaterThan(GIT_MS - 100);
    expect(health).toBeLessThan(GIT_MS - 200);
  });

  it("does not stall the daemon while an agent is spawned there", async () => {
    for (const body of [
      { enabled: true },
      { runner: { harness: "codex", enabled: true } },
      { addRoot: t.home },
    ])
      expect((await t.raw("POST", "/v1/headless", body, { tty: true })).status).toBe(200);
    const { ms, health } = await alongside(async () => {
      const res = await t.raw("POST", "/v1/spawn", { harness: "codex", cwd: repo, task: "hi" });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
    });
    expect(ms).toBeGreaterThan(GIT_MS - 100);
    expect(health).toBeLessThan(GIT_MS - 200);
  });
});
