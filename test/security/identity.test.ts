import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";

// Production mode: the daemon identifies callers from the kernel (peer PID + ancestry),
// so the caller header a client sends is ignored.
const linux = process.platform === "linux";
const python = linux && spawnSync("python3", ["-c", "import ctypes"]).status === 0;

/** One HTTP request from a python process that runs `prelude` (ctypes `libc`) first. */
async function pyRequest(
  prelude: string,
  socket: string,
  method: string,
  path: string,
  body: unknown,
  caller: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
  const script = `
import socket, sys, ctypes, base64, json
libc = ctypes.CDLL(None)
${prelude}
sock, method, path, body, caller = sys.argv[1:6]
h = base64.urlsafe_b64encode(caller.encode()).decode().rstrip("=")
s = socket.socket(socket.AF_UNIX); s.connect(sock)
s.sendall(("%s %s HTTP/1.1\\r\\nHost: x\\r\\nContent-Type: application/json\\r\\nX-Agentlink-Caller: %s\\r\\nContent-Length: %d\\r\\nConnection: close\\r\\n\\r\\n%s" % (method, path, h, len(body), body)).encode())
data = b""
while True:
    c = s.recv(65536)
    if not c: break
    data += c
print(data.decode())`;
  // async: the daemon under test runs in this process and must keep answering
  const { stdout } = await promisify(execFile)("python3", [
    "-c",
    script,
    socket,
    method,
    path,
    body === undefined ? "" : JSON.stringify(body),
    JSON.stringify(caller),
  ]);
  return { status: Number(stdout.split(" ")[1]), text: stdout };
}

describe.skipIf(!linux)("caller identity comes from the kernel", () => {
  let t: TestDaemon;

  beforeAll(async () => {
    t = await startTestDaemon({ verifyCallers: true });
    const victim = t.fakeAgentProcess("claude");
    await t.client().request("POST", "/v1/agents/register", {
      tool: "claude",
      name: "victim",
      pid: victim.pid,
      sessionId: "victim-session",
      state: "idle",
    });
    // A conversation between two other agents (sent while this process is still "the human").
    for (const name of ["p1", "p2"]) {
      const proc = t.fakeAgentProcess("generic");
      await t.client().request("POST", "/v1/agents/register", {
        tool: "generic",
        name,
        pid: proc.pid,
        state: "idle",
      });
    }
    await t.client().request("POST", "/v1/messages", { to: ["p2"], text: "secret between others" });
    // This test process becomes the agent "alpha"; every request it makes is alpha's.
    await t.client().request("POST", "/v1/agents/register", {
      tool: "generic",
      name: "alpha",
      pid: process.pid,
      state: "idle",
    });
  }, 30_000);

  afterAll(async () => {
    await t?.stop();
  });

  it("identifies the calling agent regardless of the header", async () => {
    const who = await t.raw<{ agent: { name: string } | null }>("GET", "/v1/whoami", undefined, {
      tty: true,
    });
    expect(who.data.agent?.name).toBe("alpha");
  });

  it("refuses an agent registering another process or a second name", async () => {
    const other = t.fakeAgentProcess("generic");
    const res = await t.raw("POST", "/v1/agents/register", {
      tool: "generic",
      name: "puppet",
      pid: other.pid,
    });
    expect(res.status).toBe(403);
    const twin = await t.raw("POST", "/v1/agents/register", {
      tool: "generic",
      name: "alpha2",
      pid: process.pid,
    });
    expect(twin.status).toBe(409);
  });

  it("does not show an agent other agents' conversations in the log", async () => {
    const res = await t
      .client()
      .request<{ messages: { message: { preview: string } }[] }>("GET", "/v1/log");
    expect(res.messages.map((m) => m.message.preview)).not.toContain("secret between others");
    const shown = await t.raw("GET", "/v1/threads/secret", undefined);
    expect(shown.status).not.toBe(200);
  });

  it("refuses an agent acting as another agent", async () => {
    const res = await t.raw(
      "POST",
      "/v1/messages",
      { to: ["victim"], text: "hi" },
      { as: "victim" },
    );
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.data)).toContain("cannot act as another agent");
  });

  it("refuses --as from a process that is neither an agent nor at a terminal", async () => {
    // A background process (no terminal) outside any agent's tree tries to act for "victim".
    const script = `
      const { Client } = await import(${JSON.stringify(new URL("../../src/cli/client.ts", import.meta.url).href)});
      const c = new Client(${JSON.stringify(t.paths)}, { as: "victim" });
      try { await c.request("GET", "/v1/inbox"); console.log("allowed"); }
      catch (e) { console.log(String(e.status ?? e.message)); }`;
    // async: the daemon under test runs in this process and must keep answering
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        encoding: "utf8",
        env: { ...process.env, AGENTLINK_HOME: t.home, HOME: t.home },
      },
    );
    expect(stdout.trim()).toBe("403");
  });

  it("does not let an agent pass as the human by claiming a TTY", async () => {
    await t.raw("POST", "/v1/control", { action: "pause" });
    const resume = await t.raw("POST", "/v1/control", { action: "resume" }, { tty: true });
    expect(resume.status).toBe(403);
  });

  // PR_SET_DUMPABLE=0 hides a process from `ss -p`; its claims must not be believed instead.
  it.skipIf(!python)("refuses a caller that hides itself from the socket table", async () => {
    const hidden = (path: string, body: unknown, caller: Record<string, unknown>) =>
      pyRequest("libc.prctl(4, 0, 0, 0, 0)", t.paths.socket, "POST", path, body, caller);
    const human = { pid: 1, chain: [], tty: true };
    const policy = await hidden(
      "/v1/policy",
      { scope: "teammate", kind: "request", action: "deliver" },
      human,
    );
    expect(policy.status).toBe(403);
    const asVictim = await hidden(
      "/v1/messages",
      { to: ["@tester"], text: "impersonated" },
      { ...human, as: "victim" },
    );
    expect(asVictim.status).toBe(403);
  });

  // `ss` prints process names unescaped: this one makes its row read users:(("x",pid=1,fd=1",pid=<real>,...)).
  it.skipIf(!python)("is not fooled by a process name that imitates another pid", async () => {
    const spoof = (method: string, path: string) =>
      pyRequest(
        `libc.prctl(15, ctypes.c_char_p(b'x",pid=1,fd=1'), 0, 0, 0)`,
        t.paths.socket,
        method,
        path,
        undefined,
        { pid: 1, chain: [], tty: true },
      );
    // The spoofer is a child of this process (the agent alpha), so it is alpha.
    const who = await spoof("GET", "/v1/whoami");
    expect(who.status).toBe(200);
    expect(who.text).toContain('"name":"alpha"');
    expect((await spoof("GET", "/v1/approvals")).status).toBe(403);
  });

  it("ignores hook requests that claim another agent's session", async () => {
    const daemon = t.daemon.services;
    daemon.ctx.store.setMeta("paused", "0");
    await t
      .client()
      .request("POST", "/v1/messages", { to: ["victim"], text: "for the victim only" });
    const res = await t.raw<{ stdout?: string }>("POST", "/v1/hooks/claude/post-tool", {
      payload: { session_id: "victim-session", hook_event_name: "PostToolUse" },
      chain: [],
    });
    expect(JSON.stringify(res.data)).not.toContain("for the victim only");
    const victimMail = daemon.mailbox.inbox(
      {
        agent: daemon.registry.byName("victim") as NonNullable<
          ReturnType<typeof daemon.registry.byName>
        >,
      },
      { unreadOnly: true },
    );
    expect(victimMail.map((i) => i.envelope.parts)).toHaveLength(1);
  });
});
