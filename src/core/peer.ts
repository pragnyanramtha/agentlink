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
  // Netid State Recv-Q Send-Q Local Inode Peer PeerInode Process
  const row = /^\S+\s+\S+\s+\d+\s+\d+\s+\S+\s+\d+\s+\S+\s+(\d+)(?:\s+(.*))?$/;
  for (const line of table.split("\n")) {
    const m = row.exec(line.trim());
    if (m && Number(m[1]) === inode) {
      const pid = /pid=(\d+)/.exec(m[2] ?? "");
      return pid ? Number(pid[1]) : undefined;
    }
  }
  return undefined;
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
