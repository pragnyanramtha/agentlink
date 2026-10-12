import { execFile, execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface RepoInfo {
  root?: string;
  remote?: string;
  branch?: string;
  head?: string;
  /** Short name for auto-naming agents: repo dir name, or the cwd basename. */
  name: string;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 1_500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** `git@github.com:Org/Repo.git` and `https://github.com/org/repo` → `github.com/org/repo`. */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  u = u.replace(/^[a-z+]+:\/\//i, "");
  u = u.replace(/^[^@/]+@/, "");
  u = u.replace(/^([^/:]+):(?!\d+\/)/, "$1/");
  u = u.replace(/^([^/:]+):\d+\//, "$1/");
  u = u.replace(/\/+$/, "").replace(/\.git$/, "");
  return u.toLowerCase();
}

/** The same as `git`, without blocking the event loop. */
function gitAsync(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd, encoding: "utf8", timeout: 1_500 }, (error, out) =>
      resolve(error ? undefined : out.trim()),
    );
    child.stdin?.end();
  });
}

const TOPLEVEL = ["rev-parse", "--show-toplevel"];
const DETAILS = [
  ["remote", "get-url", "origin"],
  ["rev-parse", "--abbrev-ref", "HEAD"],
  ["rev-parse", "HEAD"],
];

export function repoInfo(cwd: string): RepoInfo {
  const root = git(cwd, TOPLEVEL);
  if (!root) return { name: basename(cwd) || "root" };
  const [remoteUrl, branch, head] = DETAILS.map((args) => git(root, args));
  return describeRepo(root, remoteUrl, branch, head);
}

/** repoInfo for the daemon: its git runs never stall other requests, and run side by side. */
export async function repoInfoAsync(cwd: string): Promise<RepoInfo> {
  const [root, remoteUrl, branch, head] = await Promise.all(
    [TOPLEVEL, ...DETAILS].map((args) => gitAsync(cwd, args)),
  );
  if (!root) return { name: basename(cwd) || "root" };
  return describeRepo(root, remoteUrl, branch, head);
}

function describeRepo(
  root: string,
  remoteUrl: string | undefined,
  branch: string | undefined,
  head: string | undefined,
): RepoInfo {
  return {
    root,
    ...(remoteUrl ? { remote: normalizeRemote(remoteUrl) } : {}),
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    name: basename(root),
  };
}
