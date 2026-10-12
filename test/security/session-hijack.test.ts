import { type ChildProcess, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ssBinary } from "../../src/core/peer.ts";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";

// Found by scripts/sim (log: "hook claimed another agent's session; ignoring the claim" on every
// resume). With kernel-checked callers, HookHandler drops a session id that belongs to another
// live process, but then calls registry.register({ sessionId }) which looks the session up again
// (bySession) and moves that agent to the caller's pid: any process can take over a running
// agent's identity (its mail, its name) by putting the agent's session id in a hook payload.
const linux = process.platform === "linux";

/** A process that looks like `claude` and fires one hook as itself, then stays alive. */
function fakeClaudeHook(
  socket: string,
  event: string,
  payload: Record<string, unknown>,
): { child: ChildProcess; out: Promise<{ pid: number; data: { stdout?: string } }> } {
  const script = `
const http = require("node:http");
const body = JSON.stringify(${JSON.stringify({ payload, chain: [], env: {} })});
const req = http.request({ socketPath: ${JSON.stringify(socket)}, method: "POST", path: "/v1/hooks/claude/${event}",
  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
  let t = ""; res.on("data", (c) => (t += c));
  res.on("end", () => { process.stdout.write(JSON.stringify({ pid: process.pid, data: JSON.parse(t || "{}") }) + "\\n"); });
});
req.end(body);
setTimeout(() => {}, 60000);`;
  const child = spawn(
    "bash",
    ["-c", `exec -a /usr/local/bin/claude ${JSON.stringify(process.execPath)} -e "$0"`, script],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const out = new Promise<{ pid: number; data: { stdout?: string } }>((resolve) => {
    let buf = "";
    child.stdout?.on("data", (c: Buffer) => {
      buf += c.toString();
      if (buf.includes("\n")) resolve(JSON.parse(buf.split("\n")[0] as string));
    });
  });
  return { child, out };
}

describe.skipIf(!linux || !ssBinary())("a hook cannot take over another live agent", () => {
  let t: TestDaemon;
  const kids: ChildProcess[] = [];
  beforeAll(async () => {
    t = await startTestDaemon({ verifyCallers: true });
  });
  afterAll(async () => {
    for (const k of kids) k.kill("SIGKILL");
    await t?.stop();
  });

  it("keeps the victim's identity and mail when another process claims its session", async () => {
    const session = "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f";
    const victim = fakeClaudeHook(t.paths.socket, "session-start", { session_id: session });
    kids.push(victim.child);
    const v = await victim.out;
    const agent = t.daemon.services.registry.byLivePid("claude", v.pid);
    expect(agent).toBeDefined();
    const sent = await t.raw<{ message: { id: string } }>("POST", "/v1/messages", {
      to: [agent?.name as string],
      kind: "ask",
      text: "for the victim only",
    });
    expect(sent.status).toBe(200);

    const thief = fakeClaudeHook(t.paths.socket, "session-start", { session_id: session });
    kids.push(thief.child);
    const th = await thief.out;
    expect(JSON.stringify(th.data)).not.toContain("for the victim only");
    // the running victim is still that agent, and still has its mail
    expect(t.daemon.services.registry.byId(agent?.id as string)?.pid).toBe(v.pid);
  }, 20_000);
});
