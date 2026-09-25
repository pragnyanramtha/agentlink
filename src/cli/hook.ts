import { appendFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "../core/paths.ts";
import { ancestry } from "../core/proc.ts";
import { Client } from "./client.ts";

function readStdin(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const finish = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

function logHookError(paths: Paths, tool: string, event: string, error: unknown): void {
  const file = join(paths.home, "hook-errors.log");
  try {
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 256 * 1024) truncateSync(file, 0);
    appendFileSync(
      file,
      `${new Date().toISOString()} ${tool} ${event}: ${String((error as Error)?.message ?? error)}\n`,
      { mode: 0o600 },
    );
  } catch {
    // never fail a hook
  }
}

interface HookResponse {
  stdout?: string;
  env?: Record<string, string>;
}

/** CLIs whose hook contract expects a JSON object on stdout even when there is nothing to say. */
const JSON_STDOUT_TOOLS = new Set(["agy", "cursor", "copilot"]);

/**
 * `agentlink hook <tool> <event> [json]`, invoked by a CLI's hook system. It must fail open:
 * any problem exits 0 with no output, so the agent keeps working as if agentlink wasn't there.
 */
export async function runHook(
  paths: Paths,
  tool: string,
  event: string,
  argJson?: string,
): Promise<number> {
  try {
    const raw = argJson ?? (await readStdin(1_000));
    let payload: Record<string, unknown> = {};
    try {
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
    } catch {
      // non-JSON payloads are ignored
    }
    const slow = event === "session-start";
    const client = new Client(paths, { timeoutMs: slow ? 5_000 : 2_000 });
    if (slow) await client.ensureDaemon({ autoStart: true, waitMs: 4_000 });
    const chain = ancestry(process.pid).map((p) => ({
      pid: p.pid,
      ppid: p.ppid,
      ...(p.start ? { start: p.start } : {}),
      cmd: p.cmd.slice(0, 4).map((a) => a.slice(0, 200)),
    }));
    const res = await client.request<HookResponse>("POST", `/v1/hooks/${tool}/${event}`, {
      payload,
      chain,
      env: {
        cwd: process.cwd(),
        ...(process.env.TMUX_PANE ? { tmuxPane: process.env.TMUX_PANE } : {}),
        ...(process.env.TMUX ? { tmux: process.env.TMUX } : {}),
        ...(process.env.CLAUDE_CODE_MESSAGING_SOCKET
          ? { claudeSocket: process.env.CLAUDE_CODE_MESSAGING_SOCKET }
          : {}),
      },
    });
    if (!res.stdout && JSON_STDOUT_TOOLS.has(tool)) res.stdout = "{}";
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (res.env && envFile) {
      const lines = Object.entries(res.env)
        .map(([k, v]) => `export ${k}=${JSON.stringify(v)}\n`)
        .join("");
      appendFileSync(envFile, lines);
    }
    if (res.stdout) process.stdout.write(res.stdout);
  } catch (error) {
    logHookError(paths, tool, event, error);
  }
  return 0;
}
