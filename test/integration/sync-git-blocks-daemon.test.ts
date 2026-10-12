import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";

// Found by scripts/sim with --slow-git-ms 450 (hook p99 1.5–1.9 s, event-loop stalls of 1.86 s,
// "daemon did not answer in time" hook timeouts). Registry.register() runs repoInfo(), up to four
// synchronous `git` calls (execFileSync, 1.5 s timeout each), inside a SQLite transaction on the
// daemon's only thread. Every session start (and every hook of an agent marked offline/stale)
// does it, so one slow repo (big monorepo, cold cache, network disk, a held index.lock) stalls
// every other agent's hooks past their 2 s timeout. A drained hook that times out loses its mail.
let t: TestDaemon;
let bin: string;
let repo: string;
const savedPath = process.env.PATH;
beforeEach(async () => {
  bin = mkdtempSync(join(tmpdir(), "agentlink-slowgit-"));
  writeFileSync(join(bin, "git"), '#!/bin/bash\nsleep 0.7\nexec /usr/bin/git "$@"\n');
  chmodSync(join(bin, "git"), 0o755);
  repo = join(bin, "repo");
  mkdirSync(repo);
  execFileSync("/usr/bin/git", ["init", "-q", "-b", "main"], { cwd: repo });
  process.env.PATH = `${bin}:${savedPath}`;
  t = await startTestDaemon();
});
afterEach(async () => {
  process.env.PATH = savedPath;
  await t.stop();
  rmSync(bin, { recursive: true, force: true });
});

/** GET /v1/health from another process after `delayMs`, timed there (this loop is the daemon's). */
function healthFromOutside(socket: string, delayMs: number): Promise<number> {
  const script = `setTimeout(()=>{const t=Date.now();require("node:http").get({socketPath:${JSON.stringify(socket)},path:"/v1/health"},r=>{r.resume();r.on("end",()=>console.log(Date.now()-t))})},${delayMs})`;
  return new Promise((resolve, reject) =>
    execFile(process.execPath, ["-e", script], (e, out) => (e ? reject(e) : resolve(Number(out)))),
  );
}

describe("a session starting in a slow git repo", () => {
  it("does not stall other requests to the daemon", async () => {
    const proc = t.fakeAgentProcess("claude");
    // node starts in ~50 ms; the health request lands while the session start runs git
    const other = healthFromOutside(t.paths.socket, 600);
    const started = Date.now();
    await t.hook("claude", "session-start", { session_id: "s-slow-git", cwd: repo }, proc);
    const hookMs = Date.now() - started;
    const healthMs = await other;
    expect(hookMs).toBeGreaterThan(600); // git really was slow (0.7 s a call)
    expect(healthMs).toBeLessThan(1_000); // today: ~2.8 s, the whole register
  });
});
