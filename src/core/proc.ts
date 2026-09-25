import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Process start marker, used to detect PID reuse. */
  start?: string;
  /** argv (best effort). */
  cmd: string[];
}

function linuxProc(pid: number): ProcInfo | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) may contain spaces and parens: parse after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(rest[1]);
    const start = rest[19];
    let cmd: string[] = [];
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      // cmdline can be unreadable for some processes
    }
    return { pid, ppid, ...(start ? { start } : {}), cmd };
  } catch {
    return undefined;
  }
}

function psProc(pid: number): ProcInfo | undefined {
  try {
    const out = execFileSync("ps", ["-o", "ppid=,lstart=,command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return undefined;
    const m = /^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(out);
    if (!m) return undefined;
    return { pid, ppid: Number(m[1]), start: m[2] ?? "", cmd: (m[3] ?? "").split(/\s+/) };
  } catch {
    return undefined;
  }
}

export function procInfo(pid: number): ProcInfo | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return process.platform === "linux" ? linuxProc(pid) : psProc(pid);
}

/** The process chain from `pid` upwards (inclusive), stopping at init. */
export function ancestry(pid: number = process.pid, max = 16): ProcInfo[] {
  const chain: ProcInfo[] = [];
  let current: number | undefined = pid;
  while (current && current > 1 && chain.length < max) {
    const info = procInfo(current);
    if (!info) break;
    chain.push(info);
    current = info.ppid;
  }
  return chain;
}

export function isAlive(pid: number, start?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (!start) return true;
  const info = procInfo(pid);
  return !info?.start || info.start === start;
}

/** Tool binaries we recognise when locating the agent process in a caller's ancestry. */
const TOOL_PATTERNS: Record<string, RegExp> = {
  claude: /(^|\/)claude(\.exe)?$|@anthropic-ai\/claude-code/,
  codex: /(^|\/)codex(\.exe)?$|@openai\/codex/,
  opencode: /(^|\/)opencode(\.exe)?$|opencode-ai/,
  gemini: /(^|\/)gemini$|@google\/gemini-cli/,
  copilot: /(^|\/)copilot$|@github\/copilot/,
  cursor: /(^|\/)(cursor-agent|agent)$|cursor-agent\//,
  kiro: /(^|\/)kiro-cli$/,
  devin: /(^|\/)devin$/,
  agy: /(^|\/)(agy|antigravity)$/,
};

export function matchesTool(tool: string, info: ProcInfo): boolean {
  const re = TOOL_PATTERNS[tool];
  if (!re) return false;
  return info.cmd.slice(0, 3).some((arg) => re.test(arg));
}

/**
 * Which agent CLI a hook really runs under. Hook configs are shared across tools (Devin reads
 * ~/.claude/settings.json hooks; Copilot and Cursor read a repo's .claude hooks), so the tool
 * named on the hook command line is only a hint.
 */
export function detectTool(chain: ProcInfo[]): { tool: string; proc: ProcInfo } | undefined {
  for (const proc of chain.slice(1)) {
    for (const tool of Object.keys(TOOL_PATTERNS)) {
      if (matchesTool(tool, proc)) return { tool, proc };
    }
  }
  return undefined;
}

const SHELLS = /(^|\/)(sh|bash|zsh|dash|fish|env|timeout|nohup|script)$/;

/**
 * Finds the agent process for a hook invocation: the nearest ancestor that looks like the
 * tool binary, else the first non-shell ancestor above the hook process.
 */
export function findToolProcess(tool: string, chain: ProcInfo[]): ProcInfo | undefined {
  const above = chain.slice(1);
  const byName = above.find((p) => matchesTool(tool, p));
  if (byName) return byName;
  return above.find((p) => !SHELLS.test(p.cmd[0] ?? "") && !/agentlink/.test(p.cmd.join(" ")));
}

/** A process's working directory (Linux; undefined elsewhere or when not permitted). */
export function procCwd(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}
