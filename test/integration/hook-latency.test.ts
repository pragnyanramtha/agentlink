// "<tool> <event>: daemon did not answer in time" (hook-errors.log) and its effects. Each hook
// commits at least once; with synchronous=FULL every commit fsyncs the WAL on the daemon's only
// thread (hundreds of ms on a busy btrfs disk), and mail handed to a hook that gave up was lost.
import { fstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, spawnDaemon } from "../../src/cli/client.ts";
import { resolvePaths } from "../../src/core/paths.ts";
import { peerPid, runSs, type SsRunner, ssBinary } from "../../src/core/peer.ts";
import { type RunningDaemon, startDaemon } from "../../src/daemon/main.ts";
import { Store } from "../../src/daemon/store/db.ts";
import { FakeAgent, sandbox } from "../fake-agent.ts";

const linux = process.platform === "linux";

describe("hook latency: the dominant cost", () => {
  it("does not fsync the WAL on every commit", () => {
    const { home } = sandbox();
    const store = new Store(join(home, "agentlink.db"));
    const mode = (store.db.prepare("PRAGMA synchronous").get() as { synchronous: number })
      .synchronous;
    store.close();
    rmSync(home, { recursive: true, force: true });
    expect(mode).toBe(1); // NORMAL: still consistent after a crash in WAL mode
  });

  it("builds the web UI script without blocking daemon start-up", async () => {
    const parts = await Promise.all(
      ["core", "airspace", "graph", "views", "shell"].map(
        async (m) => Object.values(await import(`../../src/ui/${m}.ts`))[0] as string,
      ),
    );
    const { squeeze } = await import("../../src/ui/app.ts");
    const t = performance.now();
    squeeze(parts.join("\n"));
    expect(performance.now() - t).toBeLessThan(100); // was ≈ 630 ms (quadratic)
  });
});

describe.runIf(linux && ssBinary())("caller lookup in a burst of hooks (shared ss run)", () => {
  let dir: string;
  let server: Server;
  const open: Socket[] = [];
  beforeAll(async () => {
    ({ home: dir } = sandbox());
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

  it("still names a caller whose connection the shared table lists without its process", async () => {
    // `ss -p` maps sockets to processes BEFORE it dumps the socket table, so a hook that connects
    // while a shared run is in flight is listed with no users:(…) column.
    const first = await accept();
    let lateSocket!: (s: Socket) => void;
    const late = new Promise<Socket>((r) => {
      lateSocket = r;
    });
    let calls = 0;
    const run: SsRunner = async (args, max) => {
      if (calls++ > 0) return runSs(args, max);
      const s = await accept(); // connects after ss scanned /proc…
      lateSocket(s);
      const res = await runSs(args, max); // …and before it dumped the sockets
      const peer = String(inode(s));
      const stdout = (res.stdout ?? "")
        .split("\n")
        .map((l) => (l.trim().split(/\s+/)[7] === peer ? l.replace(/\s+users:.*$/, "") : l))
        .join("\n");
      return { stdout };
    };
    const a = peerPid(first, run);
    const b = peerPid(await late, run); // within SHARE_MS: reuses the in-flight run
    expect(await Promise.all([a, b])).toEqual([process.pid, process.pid]);
  });
});

describe.skipIf(!linux)("a hook that gives up before the daemon answers", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let daemon: RunningDaemon;
  let cwd: string;
  let agent: FakeAgent;
  const send = (to: string, text: string, kind = "info") =>
    new Client(resolvePaths(env)).request("POST", "/v1/messages", { to: [to], text, kind });
  /** Blocks the daemon's thread after each drain (like a synchronous fsync under disk load). */
  const stall = (ms: number) => {
    const mailbox = daemon.services.mailbox;
    const drain = mailbox.drain.bind(mailbox);
    mailbox.drain = (...args: Parameters<typeof drain>) => {
      const items = drain(...args);
      const until = Date.now() + ms;
      while (Date.now() < until) {
        // blocked
      }
      return items;
    };
    return () => {
      mailbox.drain = drain;
    };
  };

  beforeAll(async () => {
    ({ home, env } = sandbox());
    cwd = join(home, "project");
    mkdirSync(cwd);
    daemon = await startDaemon({ paths: resolvePaths(env), sweepMs: 200 });
    agent = new FakeAgent("codex", env, cwd);
    await agent.hook("session-start", { session_id: "S-slow", cwd });
  }, 30_000);

  afterAll(async () => {
    agent?.kill();
    await daemon?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("does not lose the mail the daemon drained for it (client timeout)", async () => {
    const me = daemon.services.registry.bySession("codex", "S-slow");
    await send(me?.name as string, "please look at this");
    const restore = stall(4_600); // longer than a per-tool-call hook waits (4 s)
    const out = await agent.hook("post-tool", { session_id: "S-slow", cwd });
    restore();
    expect(out).not.toContain("please look at this"); // the hook gave up…
    expect(readFileSync(join(home, "hook-errors.log"), "utf8")).toContain(
      "daemon did not answer in time",
    );
    await new Promise((r) => setTimeout(r, 100));
    // …so the message is still waiting, and the next hook shows it.
    expect(daemon.services.mailbox.pending(me?.id as string)).toHaveLength(1);
    expect(await agent.hook("post-tool", { session_id: "S-slow", cwd })).toContain(
      "please look at this",
    );
  }, 30_000);

  it("takes back a stop-hook continuation that never arrived (no double-counted wake)", async () => {
    const { registry, engine, mailbox } = daemon.services;
    const me = registry.bySession("codex", "S-slow");
    await send(me?.name as string, "can you answer this?", "ask");
    const before = { blocks: registry.byId(me?.id as string)?.stop_blocks, wakes: 0 };
    before.wakes = engine.budget(me as NonNullable<typeof me>).used;
    const restore = stall(1_500);
    // The hook process disconnects (killed) while the daemon is still busy with its answer.
    const out = await agent.hook("stop", { session_id: "S-slow", cwd }, { killAfterS: 0.5 });
    await new Promise((r) => setTimeout(r, 1_300));
    restore();
    expect(out).not.toContain("can you answer this?");
    const now = registry.byId(me?.id as string);
    expect(now?.stop_blocks).toBe(before.blocks);
    expect(engine.budget(now as NonNullable<typeof now>).used).toBe(before.wakes);
    expect(mailbox.pending(me?.id as string)).toHaveLength(1);
    const next = await agent.hook("stop", { session_id: "S-slow", cwd });
    expect(next).toContain("can you answer this?");
    expect(registry.byId(me?.id as string)?.stop_blocks).toBe((before.blocks ?? 0) + 1);
  }, 30_000);
});

describe.skipIf(!linux)("a daemon that is running but slow to answer", () => {
  it("is waited for, not started a second time", async () => {
    const { home, env } = sandbox();
    const savedHome = process.env.HOME;
    process.env.HOME = home; // the spawned daemon's environment
    const paths = resolvePaths(env);
    const client = new Client(paths);
    let pid = 0;
    try {
      spawnDaemon(paths);
      for (let i = 0; i < 100 && !(await client.health(500)); i++)
        await new Promise((r) => setTimeout(r, 100));
      pid = Number(readFileSync(paths.pidFile, "utf8"));
      process.kill(pid, "SIGSTOP"); // stalled, e.g. on a busy disk
      const error = await client.ensureDaemon({ waitMs: 1_000 }).catch((e: Error) => e);
      expect((error as Error).message).toMatch(/is running but did not answer in time/);
      process.kill(pid, "SIGCONT");
      expect((await client.ensureDaemon({ waitMs: 3_000 })).pid).toBe(pid);
      expect(readFileSync(paths.log, "utf8")).not.toMatch(/already running/);
    } finally {
      process.env.HOME = savedHome;
      if (pid) {
        process.kill(pid, "SIGCONT");
        process.kill(pid, "SIGTERM");
      }
      await new Promise((r) => setTimeout(r, 300));
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
