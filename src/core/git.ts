import { execFileSync } from "node:child_process";
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

export function repoInfo(cwd: string): RepoInfo {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { name: basename(cwd) || "root" };
  const remoteUrl = git(root, ["remote", "get-url", "origin"]);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  return {
    root,
    ...(remoteUrl ? { remote: normalizeRemote(remoteUrl) } : {}),
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    name: basename(root),
  };
}
