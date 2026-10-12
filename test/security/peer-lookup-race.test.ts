import { fstatSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { peerPid, runSs, type SsRunner, ssBinary } from "../../src/core/peer.ts";

// Found by scripts/sim (kernel caller checks on, ~0.2% of requests under load refused with
// "agentlink cannot tell which process is calling (it is hidden from the kernel's socket
// table); refusing": hooks, CLI commands, even approvals from a person's terminal).
// `ss -p` maps sockets to processes by scanning /proc *before* it dumps the socket table. A
// lookup that reuses a shared ss run (SHARE_MS) for a connection made while that run was going
// finds the connection's row, but without its process: lookup() only retries alone when the row
// is missing (rows.length === 0), not when it has no holders, so the caller is refused.
describe.runIf(process.platform === "linux" && ssBinary())("caller lookup race", () => {
  let dir: string;
  let server: Server;
  const open: Socket[] = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agentlink-peer-"));
    server = createServer();
    await new Promise<void>((r) => server.listen(join(dir, "s.sock"), r));
  });
  afterAll(() => {
    for (const s of open) s.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const accept = () =>
    new Promise<Socket>((resolve) => {
      server.once("connection", (s) => {
        open.push(s);
        resolve(s);
      });
      open.push(connect(join(dir, "s.sock")));
    });
  const inode = (s: Socket) =>
    fstatSync((s as unknown as { _handle: { fd: number } })._handle.fd).ino;

  it("looks again when the shared table has the connection but not its process yet", async () => {
    const first = await accept();
    const late = await accept();
    // What a shared ss run started before `late` connected prints: its row, without users:(…)
    const real = (await runSs(["-xpnH"], 32 * 1024 * 1024)).stdout ?? "";
    const lateIno = String(inode(late));
    const doctored = real
      .split("\n")
      .map((line) => {
        const f = line.trim().split(/\s+/);
        return f[7] === lateIno ? f.slice(0, 8).join(" ") : line;
      })
      .join("\n");
    let calls = 0;
    const run: SsRunner = (args, max) =>
      calls++ === 0 ? Promise.resolve({ stdout: doctored }) : runSs(args, max);
    const pending = peerPid(first, run);
    expect(await Promise.all([pending, peerPid(late, run)])).toEqual([process.pid, process.pid]);
  });
});
