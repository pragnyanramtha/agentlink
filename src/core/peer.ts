import { execFile } from "node:child_process";
import { fstatSync, readlinkSync } from "node:fs";
import type { Socket } from "node:net";

let available = process.platform === "linux";

/**
 * PID of the process on the other end of an accepted Unix-socket connection, from the kernel's
 * socket table (`ss`), so callers cannot claim to be someone else. Linux only; undefined elsewhere.
 */
export async function peerPid(socket: Socket): Promise<number | undefined> {
  if (!available) return undefined;
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (typeof fd !== "number" || fd < 0) return undefined;
  let inode: number;
  try {
    inode = fstatSync(fd).ino;
  } catch {
    return undefined;
  }
  const table = await new Promise<string | undefined>((resolve) => {
    execFile("ss", ["-xpnH"], { timeout: 3_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") available = false;
      resolve(error ? undefined : stdout);
    });
  });
  if (!table) return undefined;
  // Netid State Recv-Q Send-Q Local Inode Peer PeerInode Process: the row whose peer is our end
  // describes the client's socket. Process names are printed unescaped (one can read `pid=1,fd=1`),
  // so only pids that really hold the client's socket count, and anything ambiguous is undefined.
  const row = /^\S+\s+\S+\s+\d+\s+\d+\s+\S+\s+(\d+)\s+\S+\s+(\d+)(?:\s+(.*))?$/;
  const rows = table
    .split("\n")
    .map((line) => row.exec(line.trim()))
    .filter((m) => m && Number(m[2]) === inode);
  if (rows.length !== 1 || !rows[0]) return undefined;
  const [, client, , procs] = rows[0];
  const pids = new Set(
    ssPids(procs ?? "")
      .filter(({ pid, fd }) => fdTarget(pid, fd) === `socket:[${client}]`)
      .map((p) => p.pid),
  );
  return pids.size === 1 ? [...pids][0] : undefined;
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

/** Whether a process's stdin is a terminal (read from /proc, not claimed by the process). */
export function stdinIsTty(pid: number): boolean {
  try {
    return /^\/dev\/(pts\/\d+|tty[\w.]*)$/.test(readlinkSync(`/proc/${pid}/fd/0`));
  } catch {
    return false;
  }
}
