import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../src/cli/client.ts";
import { silentLogger } from "../src/core/log.ts";
import { type Paths, resolvePaths } from "../src/core/paths.ts";
import { procInfo } from "../src/core/proc.ts";
import { type RunningDaemon, startDaemon } from "../src/daemon/main.ts";

export interface CallerOverride {
  as?: string;
  tty?: boolean;
  chain?: { pid: number; ppid: number; start?: string; cmd: string[] }[];
}

export interface TestDaemon {
  home: string;
  paths: Paths;
  daemon: RunningDaemon;
  client(as?: string): Client;
  /** Raw request with full control over the caller header. */
  raw<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    caller?: CallerOverride,
  ): Promise<{ status: number; data: T }>;
  /** Spawns a long-lived process standing in for an agent CLI (argv0 = tool name). */
  fakeAgentProcess(tool: string): { pid: number; start?: string; kill(): void };
  hook<T = Record<string, unknown>>(
    tool: string,
    event: string,
    payload: Record<string, unknown>,
    agentProc: { pid: number; start?: string },
    toolBin?: string,
  ): Promise<T>;
  stop(keepHome?: boolean): Promise<void>;
}

export async function startTestDaemon(
  opts: { now?: () => Date; handle?: string; home?: string; verifyCallers?: boolean } = {},
): Promise<TestDaemon> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "agentlink-test-"));
  const paths = resolvePaths({ AGENTLINK_HOME: home, HOME: home } as NodeJS.ProcessEnv);
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ handle: opts.handle ?? "tester", wake: { tmux: false } }),
  );
  const daemon = await startDaemon({
    trustClientCaller: opts.verifyCallers !== true,
    paths,
    logger: silentLogger,
    sweepMs: 200,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const children: ChildProcess[] = [];

  const raw: TestDaemon["raw"] = (method, path, body, caller = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const header = Buffer.from(
        JSON.stringify({
          pid: 0,
          chain: caller.chain ?? [],
          tty: caller.tty ?? false,
          ...(caller.as ? { as: caller.as } : {}),
        }),
      ).toString("base64url");
      const req = request(
        {
          socketPath: paths.socket,
          method,
          path,
          headers: {
            "content-type": "application/json",
            "x-agentlink-caller": header,
            ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode ?? 0, data: (text ? JSON.parse(text) : {}) as never });
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });

  const fakeAgentProcess: TestDaemon["fakeAgentProcess"] = (tool) => {
    // `exec -a` sets argv[0] so process matching sees e.g. "/usr/bin/claude".
    const child = spawn("bash", ["-c", `exec -a /usr/local/bin/${tool} sleep 600`], {
      stdio: "ignore",
    });
    children.push(child);
    const pid = child.pid as number;
    const start = procInfo(pid)?.start;
    return { pid, ...(start ? { start } : {}), kill: () => child.kill("SIGKILL") };
  };

  const hook: TestDaemon["hook"] = async (tool, event, payload, agentProc, toolBin) => {
    const chain = [
      {
        pid: 999_001,
        ppid: 999_002,
        cmd: ["node", "/opt/agentlink/dist/cli/index.js", "hook", tool, event],
      },
      {
        pid: 999_002,
        ppid: agentProc.pid,
        cmd: ["/bin/sh", "-c", `agentlink hook ${tool} ${event}`],
      },
      {
        pid: agentProc.pid,
        ppid: 1,
        ...(agentProc.start ? { start: agentProc.start } : {}),
        cmd: [toolBin ?? `/usr/local/bin/${tool}`],
      },
    ];
    const res = await raw("POST", `/v1/hooks/${tool}/${event}`, {
      payload,
      chain,
      env: { cwd: home },
    });
    if (res.status !== 200)
      throw new Error(`hook ${event} → ${res.status} ${JSON.stringify(res.data)}`);
    return res.data as never;
  };

  return {
    home,
    paths,
    daemon,
    client: (as) => new Client(paths, as ? { as } : {}),
    raw,
    fakeAgentProcess,
    hook,
    async stop(keepHome = false) {
      for (const c of children) c.kill("SIGKILL");
      await daemon.close();
      if (!keepHome) rmSync(home, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(
  fn: () => T | Promise<T>,
  timeoutMs = 3_000,
  stepMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
  }
  return last;
}
