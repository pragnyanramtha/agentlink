import { rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon, until } from "../helpers.ts";

// Found by scripts/sim (invariant: no duplicate injections; seen as "hook:stop, codex-queue").
// A Stop hook sets the agent idle, which would wake it (Claude inbox socket, `codex queue`) with
// the same mail the hook hands over as {decision:"block"}: wakes wait until the hook answered.
let t: TestDaemon;
let inbox: Server;
let lines: string[];
const sock = () => join(t.home, "claude-inbox.sock");
beforeEach(async () => {
  t = await startTestDaemon();
  lines = [];
  rmSync(sock(), { force: true });
  inbox = createServer((c) => {
    let buf = "";
    c.on("data", (d: Buffer) => {
      buf += d.toString();
    });
    c.on("end", () => lines.push(buf));
  });
  await new Promise<void>((r) => inbox.listen(sock(), r));
});
afterEach(async () => {
  inbox.close();
  await t.stop();
});

describe("a Stop hook with mail waiting", () => {
  it("delivers it once (continuation or push, not both)", async () => {
    const proc = t.fakeAgentProcess("claude");
    const chain = [
      { pid: 999_001, ppid: 999_002, cmd: ["node", "/opt/agentlink/dist/cli/index.js", "hook"] },
      { pid: 999_002, ppid: proc.pid, cmd: ["/bin/sh", "-c", "agentlink hook claude"] },
      {
        pid: proc.pid,
        ppid: 1,
        ...(proc.start ? { start: proc.start } : {}),
        cmd: ["/usr/local/bin/claude"],
      },
    ];
    const hook = (event: string) =>
      t.raw<{ stdout?: string }>("POST", `/v1/hooks/claude/${event}`, {
        payload: { session_id: "c0ffee00-0000-4000-8000-000000000001", cwd: t.home },
        chain,
        env: { cwd: t.home, claudeSocket: sock() },
      });
    await hook("session-start");
    await hook("prompt-submit"); // busy: mail waits for a hook
    const name = t.daemon.services.registry.list()[0]?.name as string;
    const sent = await t.raw<{ message: { id: string } }>("POST", "/v1/messages", {
      to: [name],
      kind: "ask",
      text: "which port does staging use?",
    });
    const id = sent.data.message.id;
    const stop = await hook("stop");
    await until(() => lines.length > 0, 1_500);
    const viaStop = (stop.data.stdout ?? "").includes(id);
    const viaInbox = lines.some((l) => l.includes(id));
    expect({ viaStop, viaInbox }).toEqual({ viaStop: true, viaInbox: false });
  });
});

describe("a wake in progress", () => {
  it("keeps hooks from handing over the same mail", async () => {
    let release: (v: { consumed: boolean }) => void = () => undefined;
    let woken = 0;
    t.daemon.services.engine.use({
      id: "slow-test",
      canWake: (a) => a.tool === "gemini",
      wake: () => {
        woken++;
        return new Promise((r) => {
          release = r;
        });
      },
    });
    const proc = t.fakeAgentProcess("gemini");
    const payload = { session_id: "gem-claim-1", cwd: t.home };
    await t.hook("gemini", "session-start", payload, proc);
    const name = t.daemon.services.registry.list()[0]?.name as string;
    const sent = await t.raw<{ message: { id: string } }>("POST", "/v1/messages", {
      to: [name],
      kind: "ask",
      text: "which port does staging use?",
    });
    const id = sent.data.message.id;
    await until(() => woken > 0);
    const res = await t.hook<{ stdout?: string }>("gemini", "post-tool", payload, proc);
    expect(res.stdout ?? "").not.toContain(id);
    release({ consumed: true });
    await until(() => t.daemon.services.mailbox.deliveriesOf(id)[0]?.state === "seen");
    expect(t.daemon.services.mailbox.deliveriesOf(id)[0]?.method).toBe("wake:slow-test");
  });
});
