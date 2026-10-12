import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { procInfo } from "../src/core/proc.ts";

const CLI = new URL("../src/cli/index.ts", import.meta.url).pathname;

/** A sandbox HOME/AGENTLINK_HOME and the environment every child process gets. */
export function sandbox(): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), "agentlink-sim-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, AGENTLINK_HOME: home };
  for (const k of Object.keys(env)) {
    if (/^(TMUX|TMUX_PANE|XDG_RUNTIME_DIR|CLAUDE_|AGENTLINK_AGENT)/.test(k)) delete env[k];
  }
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ handle: "tester", wake: { tmux: false }, notify: { desktop: false } }),
  );
  return { home, env };
}

/**
 * A long-lived process that looks like an agent CLI (`/usr/local/bin/<tool>` in its cmdline, or
 * `bin`) and runs the real hook command (`node src/cli/index.ts hook <tool> <event>`) as its own
 * child, the way Claude Code / Codex / Devin run hooks. The daemon identifies it from the kernel.
 */
export class FakeAgent {
  readonly proc: ChildProcessWithoutNullStreams;
  pid: number;
  start: string | undefined;
  readonly tool: string;
  /** Resolves once `pid` names the agent process (at once unless `orphan`). */
  readonly ready: Promise<void>;
  #buf = "";
  #waiters: ((out: string) => void)[] = [];

  /**
   * `orphan` detaches it from this process tree (`setsid -f`), so no agent CLI that runs the
   * tests is among its ancestors (an IDE's agent, whose binary agentlink does not recognise).
   */
  constructor(
    tool: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
    bin = `/usr/local/bin/${tool}`,
    orphan = false,
  ) {
    this.tool = tool;
    const sh = `exec -a ${bin} bash`;
    // The orphan shares this child's pipes; the child stays (Node closes stdin when it exits).
    const cmd = orphan
      ? `setsid -f bash -c 'echo "__AL_PID__ $$"; ${sh}'; exec sleep infinity`
      : sh;
    this.proc = spawn("bash", ["-c", cmd], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.pid = this.proc.pid as number;
    this.start = procInfo(this.pid)?.start;
    let found: () => void = () => {};
    this.ready = orphan ? new Promise((r) => (found = r)) : Promise.resolve();
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.#buf += chunk;
      const m = /__AL_PID__ (\d+)\n/.exec(this.#buf);
      if (m) {
        this.pid = Number(m[1]);
        this.start = procInfo(this.pid)?.start;
        this.#buf = this.#buf.replace(m[0], "");
        found();
      }
      let idx = this.#buf.indexOf("__AL_DONE__\n");
      while (idx >= 0) {
        const out = this.#buf.slice(0, idx);
        this.#buf = this.#buf.slice(idx + "__AL_DONE__\n".length);
        this.#waiters.shift()?.(out);
        idx = this.#buf.indexOf("__AL_DONE__\n");
      }
    });
  }

  /**
   * Runs one hook (payload on stdin, like the CLIs do) and resolves with what it printed. `tool`
   * is the hook config's tool (default: this agent's); `killAfterS` kills the hook process early.
   */
  hook(
    event: string,
    payload: Record<string, unknown>,
    opts: { tool?: string; killAfterS?: number } = {},
  ): Promise<string> {
    const kill = opts.killAfterS ? `timeout ${opts.killAfterS} ` : "";
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
      this.proc.stdin.write(
        `${kill}${process.execPath} ${CLI} hook ${opts.tool ?? this.tool} ${event} <<'__AL_EOF__'\n${JSON.stringify(payload)}\n__AL_EOF__\necho; echo __AL_DONE__\n`,
      );
    });
  }

  kill(): void {
    for (const pid of new Set([this.pid, this.proc.pid as number])) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}
