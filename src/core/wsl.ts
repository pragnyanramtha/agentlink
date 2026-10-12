import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** What WSL detection reads; tests inject their own. */
export interface WslIo {
  read(path: string): string | undefined;
  exists(path: string): boolean;
}

const readOr = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};
export const systemIo: WslIo = { read: readOr, exists: existsSync };

const INTEROP = ["/proc/sys/fs/binfmt_misc/WSLInterop", "/proc/sys/fs/binfmt_misc/WSLInterop-late"];

/** 0 outside WSL, else 1 or 2. WSL 1 always reports "Microsoft" in its kernel release. */
export function wslVersion(io: WslIo = systemIo): 0 | 1 | 2 {
  if (io !== systemIo) return detect(io);
  cached ??= detect(io);
  return cached;
}
let cached: 0 | 1 | 2 | undefined;
function detect(io: WslIo): 0 | 1 | 2 {
  const release = io.read("/proc/sys/kernel/osrelease") ?? "";
  if (/microsoft-standard|wsl2/i.test(release)) return 2;
  if (/microsoft/i.test(release)) return 1;
  // A custom WSL 2 kernel may not say so; WSL's interop entries still do. (Not the environment:
  // the daemon inherits it from whoever started it, and the web UI trusts this answer.)
  return INTEROP.some((p) => io.exists(p)) ? 2 : 0;
}

export const isWsl = (io: WslIo = systemIo) => wslVersion(io) > 0;

/** Whether Windows programs (*.exe) can be started from this WSL distro. */
export function hasInterop(io: WslIo = systemIo): boolean {
  const version = wslVersion(io);
  if (!version) return false;
  if (INTEROP.some((p) => /^enabled/.test(io.read(p) ?? ""))) return true;
  return version === 1 && io.exists("/mnt/c/Windows/System32/cmd.exe");
}

/** True for a path on a Windows drive as WSL mounts them (/mnt/c/...). */
export const onWindowsDrive = (path: string) => /^\/mnt\/[a-z](\/|$)/i.test(path);

/** Filesystems where Unix sockets (and SQLite locking) don't work: Windows drives under WSL. */
const NO_SOCKETS = new Set(["9p", "drvfs", "v9fs"]);

/** The filesystem type holding `path` (its nearest existing ancestor), from /proc/self/mountinfo. */
export function fsType(
  path: string,
  mountinfo = readOr("/proc/self/mountinfo"),
): string | undefined {
  if (!mountinfo) return undefined;
  let base = path;
  while (!existsSync(base) && base !== dirname(base)) base = dirname(base);
  let probe = path;
  try {
    probe = join(realpathSync(base), relative(base, path));
  } catch {}
  let best: { at: string; type: string } | undefined;
  for (const line of mountinfo.split("\n")) {
    const [left, right] = line.split(" - ");
    const at = left
      ?.split(" ")[4]
      ?.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    const type = right?.split(" ")[0];
    if (!at || !type) continue;
    const inside = probe === at || at === "/" || probe.startsWith(`${at}/`);
    if (inside && (!best || at.length >= best.at.length)) best = { at, type };
  }
  return best?.type;
}

/** The filesystem type if `path` is on one without Unix sockets (9p/drvfs), else undefined. */
export function socketlessFs(path: string, mountinfo?: string): string | undefined {
  const type = mountinfo === undefined ? fsType(path) : fsType(path, mountinfo);
  return type && NO_SOCKETS.has(type) ? type : undefined;
}

/** An executable at an absolute path, else undefined. */
export function executable(path: string): string | undefined {
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}
