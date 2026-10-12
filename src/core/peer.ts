import { execFile } from "node:child_process";
import { fstatSync, readlinkSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { executable, wslVersion } from "./wsl.ts";

let available = process.platform === "linux";

// Only the system's own `ss`: PATH comes from whoever started the daemon (often an agent's hook),
// and a look-alike earlier on PATH could name any process as the caller.
const SS_PATHS = ["/usr/bin/ss", "/usr/sbin/ss", "/bin/ss", "/sbin/ss"];
let ssPath: string | false | undefined;
export function ssBinary(): string | undefined {
  ssPath ??= SS_PATHS.find((p) => executable(p)) ?? false;
  return ssPath || undefined;
}

export interface SsResult {
  stdout?: string;
  error?: { code?: string | number; stderr?: string; message: string };
}
export type SsRunner = (args: string[], maxBuffer: number) => Promise<SsResult>;

export const runSs: SsRunner = (args, maxBuffer) => {
  const bin = ssBinary();
  if (!bin) return Promise.resolve({ error: { code: "ENOENT", message: "ss not found" } });
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 3_000, maxBuffer }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      resolve(
        error ? { error: { code, stderr: String(stderr), message: error.message } } : { stdout },
      );
    });
  });
};

interface Lookup {
  pid?: number;
  table?: string;
  error?: SsResult["error"];
  /** The client's row, if the socket table has exactly one. */
  row?: { client: string; procs: string };
  /** The client's socket fd in `pid`. */
  fd?: number;
}

/** One `ss` run serves every lookup starting within this window (a burst of hooks). */
const SHARE_MS = 50;
let shared: { at: number; run: SsRunner; result: Promise<SsResult> } | undefined;

async function lookup(socket: Socket, run: SsRunner, share = false): Promise<Lookup> {
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (typeof fd !== "number" || fd < 0) return {};
  let inode: number;
  try {
    inode = fstatSync(fd).ino;
  } catch {
    return {};
  }
  const ss = () => run(["-xpnH"], 32 * 1024 * 1024);
  let reused = false;
  let result: SsResult;
  if (share && shared?.run === run && Date.now() - shared.at < SHARE_MS) {
    reused = true;
    result = await shared.result;
  } else {
    const fresh = ss();
    if (share) shared = { at: Date.now(), run, result: fresh };
    result = await fresh;
  }
  const { stdout: table, error } = result;
  if (reused && !table) return lookup(socket, run);
  if (error?.code === "ENOENT") available = false;
  if (!table) return { ...(error ? { error } : {}) };
  // Netid State Recv-Q Send-Q Local Inode Peer PeerInode Process: the row whose peer is our end
  // describes the client's socket. Process names are printed unescaped (one can read `pid=1,fd=1`),
  // so only pids that really hold the client's socket count, and anything ambiguous is undefined.
  const rows = table
    .split("\n")
    .map((line) => ROW.exec(line.trim()))
    .filter((m) => m && Number(m[2]) === inode);
  // A shared table taken before this connection was accepted lacks it: look again, alone.
  if (reused && rows.length !== 1) return lookup(socket, run);
  if (rows.length !== 1 || !rows[0]) return { table };
  const [, client = "", , procs = ""] = rows[0];
  const holders = ssPids(procs).filter(({ pid, fd }) => fdTarget(pid, fd) === `socket:[${client}]`);
  const pids = new Set(holders.map((p) => p.pid));
  // `ss -p` maps sockets to processes before it lists them: a connection made during a shared run
  // can be listed without its process. Look again, alone.
  if (reused && pids.size !== 1) return lookup(socket, run);
  return {
    table,
    row: { client, procs },
    ...(pids.size === 1 ? { pid: [...pids][0], fd: holders[0]?.fd } : {}),
  };
}
const ROW = /^\S+\s+\S+\s+\d+\s+\d+\s+\S+\s+(\d+)\s+\S+\s+(\d+)(?:\s+(.*))?$/;

/** Per connection (keep-alive): the caller found by its first request, re-checked each time. */
const peers = new WeakMap<Socket, Promise<Lookup>>();

/**
 * PID of the process on the other end of an accepted Unix-socket connection, from the kernel's
 * socket table (`ss`), so callers cannot claim to be someone else. Linux only; undefined elsewhere.
 */
export async function peerPid(socket: Socket, run: SsRunner = runSs): Promise<number | undefined> {
  if (!available) return undefined;
  const cached = peers.get(socket);
  if (cached) {
    const { pid, fd, row } = await cached;
    // Only while it still holds the client's end (not exited, its pid reused); else look again.
    if (pid && fd !== undefined && row && fdTarget(pid, fd) === `socket:[${row.client}]`)
      return pid;
  }
  const found = lookup(socket, run, true);
  peers.set(socket, found);
  return (await found).pid;
}

/** Every `pid=N,fd=M` in an `ss -p` process column. Names are not escaped, so some may be forged. */
export const ssPids = (column: string) =>
  [...column.matchAll(/pid=(\d+),fd=(\d+)/g)].map((m) => ({ pid: Number(m[1]), fd: Number(m[2]) }));

function fdTarget(pid: number, fd: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/fd/${fd}`);
  } catch {
    return undefined;
  }
}

export const peerLookupAvailable = () => available;

export interface PeerLookupStatus {
  /** ok: callers are identified · missing: no ss · broken: ss runs but cannot name socket peers ·
   * inconclusive: the self-test failed for a reason that proves nothing (stays fail-closed) ·
   * unsupported: not Linux. */
  state: "ok" | "missing" | "broken" | "inconclusive" | "unsupported" | "unprobed";
  reason?: string;
  remedy?: string;
}

let status: PeerLookupStatus = { state: process.platform === "linux" ? "unprobed" : "unsupported" };
export const peerLookupStatus = (): PeerLookupStatus => status;

/** Records a probe result: only a definite "missing"/"broken" turns lookups off (claims fallback). */
export function applyPeerLookupStatus(next: PeerLookupStatus): void {
  status = next;
  if (next.state === "missing" || next.state === "broken" || next.state === "unsupported")
    available = false;
}

const remedyFor = (wsl: number) =>
  wsl === 1
    ? "WSL 1 cannot report socket peers; switch this distro to WSL 2 (in Windows PowerShell: wsl --set-version <distro> 2)"
    : "load the kernel's unix_diag module: sudo modprobe unix_diag, and keep it across reboots: echo unix_diag | sudo tee /etc/modules-load.d/agentlink.conf";

/** Classifies a self-lookup (our own connection, expected to name `expect`). */
export function classifyProbe(
  result: Lookup,
  expect: number,
  wsl: number = wslVersion(),
): PeerLookupStatus {
  if (result.pid === expect) return { state: "ok" };
  const err = result.error;
  if (err?.code === "ENOENT")
    return {
      state: "missing",
      reason: "'ss' is not installed",
      remedy: "install iproute2 (e.g. sudo apt install iproute2)",
    };
  if (
    err &&
    /netlink|protocol not supported|operation not supported|address family/i.test(
      `${err.stderr} ${err.message}`,
    )
  )
    return {
      state: "broken",
      reason: `ss cannot read the kernel's socket table (${(err.stderr || err.message).trim().split("\n")[0]})`,
      remedy: remedyFor(wsl),
    };
  if (result.table !== undefined && !result.row) {
    // Without unix_diag, ss falls back to /proc/net/unix, which has no peers: every peer inode is 0.
    const peers = result.table
      .split("\n")
      .map((line) => ROW.exec(line.trim())?.[2])
      .filter((p): p is string => p !== undefined);
    if (peers.every((p) => p === "0"))
      return {
        state: "broken",
        reason: "the kernel does not report Unix socket peers (no unix_diag support)",
        remedy: remedyFor(wsl),
      };
  }
  if (result.row && !/users:/.test(result.row.procs))
    return {
      state: "broken",
      reason: "ss cannot name the processes holding sockets",
      remedy: remedyFor(wsl),
    };
  return {
    state: "inconclusive",
    reason: err
      ? `ss failed: ${(err.stderr || err.message).trim().split("\n")[0]}`
      : "the socket table did not name this process",
  };
}

/**
 * Self-test: connects to a temporary socket in `dir` and checks the kernel names this process as
 * the peer. Shows whether caller identification works on this system (WSL 1 and kernels without
 * unix_diag can't), so the daemon does not refuse every request when it never can.
 */
export async function probePeerLookup(
  dir: string,
  opts: { run?: SsRunner; wsl?: number } = {},
): Promise<PeerLookupStatus> {
  if (process.platform !== "linux") return { state: "unsupported" };
  const path = join(dir, `.probe-${process.pid}`);
  const server = createServer();
  const sockets: Socket[] = [];
  try {
    rmSync(path, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    const socket = await new Promise<Socket>((resolve, reject) => {
      server.once("connection", resolve);
      sockets.push(connect(path).on("error", reject));
      setTimeout(() => reject(new Error("no connection")), 3_000).unref();
    });
    sockets.push(socket);
    const result = await lookup(socket, opts.run ?? runSs);
    return classifyProbe(result, process.pid, opts.wsl ?? wslVersion());
  } catch (error) {
    return { state: "inconclusive", reason: `self-test failed: ${(error as Error).message}` };
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
    rmSync(path, { force: true });
  }
}

/** Whether a process's stdin is a terminal (read from /proc, not claimed by the process). */
export function stdinIsTty(pid: number): boolean {
  try {
    return /^\/dev\/(pts\/\d+|tty[\w.]*)$/.test(readlinkSync(`/proc/${pid}/fd/0`));
  } catch {
    return false;
  }
}
