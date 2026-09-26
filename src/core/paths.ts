import { createHash } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export interface Paths {
  home: string;
  runDir: string;
  socket: string;
  pidFile: string;
  pendingDir: string;
  db: string;
  log: string;
  config: string;
  keysDir: string;
  blobsDir: string;
  backupsDir: string;
}

// Unix socket paths are limited to ~104 bytes on macOS; fall back to a short tmp path.
const MAX_SOCKET_PATH = 100;

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.AGENTLINK_HOME || join(env.HOME || homedir(), ".agentlink");
  const runDir = join(home, "run");
  let socket = join(runDir, "agentlink.sock");
  if (socket.length > MAX_SOCKET_PATH) {
    // Too long for a Unix socket: use the per-user runtime dir, or a private dir under /tmp
    // (the daemon creates it 0700 and refuses it if someone else owns it).
    const tag = createHash("sha256").update(home).digest("hex").slice(0, 12);
    const base = env.XDG_RUNTIME_DIR || join(tmpdir(), `agentlink-${userInfo().uid}`);
    socket = join(base, `agentlink-${tag}.sock`);
  }
  return {
    home,
    runDir,
    socket,
    pidFile: join(runDir, "daemon.pid"),
    pendingDir: join(runDir, "pending"),
    db: join(home, "agentlink.db"),
    log: join(home, "daemon.log"),
    config: join(home, "config.json"),
    keysDir: join(home, "keys"),
    blobsDir: join(home, "blobs"),
    backupsDir: join(home, "backups"),
  };
}
