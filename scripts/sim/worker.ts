// Runs the simulated machines, relay and fake agents of one host, inside one sandbox directory.
// The orchestrator (sim.ts) drives it in-process, or over HTTP when it runs on another host:
//   node scripts/sim/worker.ts --serve 0.0.0.0:47951 --token <t> --dir ~/agentlink-sim/run-1
// Every daemon gets HOME and AGENTLINK_HOME inside `dir`, a PATH whose agent CLIs are fakes,
// desktop notifications off and tmux wake-ups off.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ancestry, procInfo } from "../../src/core/proc.ts";
import { b64, type HttpResult, injectedIds, type Json, sleep, unixRequest } from "./lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const CLI = join(REPO, "src", "cli", "index.ts");

/** Stand-in agent CLIs: headless runs print their real counterpart's JSONL; `codex queue` logs. */
const FAKE_CLI = String.raw`#!/bin/bash
dir="$(cd "$(dirname "$0")" && pwd)"
name="$(basename "$0")"
mode="$(cat "$dir/mode" 2>/dev/null)"
if [ "$name" = codex ] && [ "$1" = queue ]; then
  # codex queue --thread <id> --message <text>
  printf '{"thread":"%s","b64":"%s"}\n' "$3" "$(printf '%s' "$5" | base64 -w0)" >> "$dir/queue.log"
  exit 0
fi
if [ "$name" = claude ] && [ "$1" = agents ]; then echo '[]'; exit 0; fi
run="$AGENTLINK_RUN"
mkdir -p "$dir/runs"
printf '%s\n' "$@" > "$dir/runs/$run.argv"
cat > "$dir/runs/$run.stdin"
echo $$ > "$dir/runs/$run.pid"
if [ "$mode" = fail ]; then echo "fake: not logged in" >&2; exit 1; fi
case "$name" in
  claude) echo '{"type":"system","subtype":"init","session_id":"ignored"}' ;;
  codex) echo '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}' ;;
  opencode) echo '{"type":"step_start","sessionID":"ses_fakesession01","part":{}}' ;;
esac
if [ "$mode" = sleep ]; then sleep 20 & wait $!; fi
sleep 0.$((RANDOM % 9 + 1))
ans="sim headless answer from $run"
case "$name" in
  claude) echo '{"type":"result","subtype":"success","is_error":false,"result":"'"$ans"'","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":5}}' ;;
  codex) echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"'"$ans"'"}}'
         echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}' ;;
  opencode) echo '{"type":"text","sessionID":"ses_fakesession01","part":{"type":"text","text":"'"$ans"'"}}'
            echo '{"type":"step_finish","sessionID":"ses_fakesession01","part":{"tokens":{"input":10,"output":5},"cost":0.01}}' ;;
esac
`;

interface MachineProc {
  name: string;
  home: string;
  fakeHome: string;
  bins: string;
  socket: string;
  verify: boolean;
  sweepMs: number;
  child?: ChildProcess;
  pid?: number;
  queueOffset: number;
  runsSeen: Set<string>;
  sse?: { stop(): void };
}
interface AgentProc {
  key: string;
  machine: string;
  tool: string;
  cwd: string;
  child: ChildProcess;
  pid: number;
  start?: string;
  calls: Map<number, (r: unknown) => void>;
  nextId: number;
  exited: boolean;
}

export class Worker {
  readonly dir: string;
  readonly #machines = new Map<string, MachineProc>();
  readonly #agents = new Map<string, AgentProc>();
  #relay: { child: ChildProcess; pid: number; url: string; dataDir: string } | undefined;
  #relayCfg: Json | undefined;
  #events: Json[] = [];
  #seq = 0;
  #timer: NodeJS.Timeout;

  constructor(dir: string) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.#timer = setInterval(() => this.#scan(), 500);
    this.#timer.unref();
  }

  #push(ev: Json): void {
    this.#events.push({ ...ev, seq: ++this.#seq, t: ev.t ?? Date.now() });
    if (this.#events.length > 400_000) this.#events.splice(0, 100_000);
  }

  events(args: { since?: number }): { events: Json[]; seq: number } {
    const since = args.since ?? 0;
    // events are in seq order: binary search for the first one after `since`
    let lo = 0;
    let hi = this.#events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Number((this.#events[mid] as Json).seq) <= since) lo = mid + 1;
      else hi = mid;
    }
    return { events: this.#events.slice(lo, lo + 20_000), seq: this.#seq };
  }

  // ---------------------------------------------------------------- relay

  async relayStart(args: { host?: string; port: number; createToken?: string }): Promise<Json> {
    if (this.#relay) return { url: this.#relay.url, pid: this.#relay.pid };
    const dataDir = join(this.dir, "relay");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.#relayCfg = { ...args, dataDir, host: args.host ?? "127.0.0.1" };
    const child = spawn(
      process.execPath,
      [join(HERE, "relay.ts"), JSON.stringify(this.#relayCfg)],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { PATH: "/usr/bin:/bin", HOME: dataDir },
      },
    );
    child.stderr?.on("data", (c: Buffer) => appendFileSync(join(dataDir, "stderr.log"), c));
    const ready = await new Promise<Json>((res, rej) => {
      const to = setTimeout(() => rej(new Error("relay did not start")), 15_000);
      child.once("message", (m) => {
        clearTimeout(to);
        res(m as Json);
      });
      child.once("exit", (code) => rej(new Error(`relay exited ${code}`)));
    });
    child.on("exit", (code, signal) => {
      this.#push({ type: "relay-exit", code, signal });
      if (this.#relay?.child === child) this.#relay = undefined;
    });
    this.#relay = { child, pid: child.pid as number, url: String(ready.url), dataDir };
    this.#push({ type: "relay-start", pid: child.pid });
    return { url: ready.url, pid: child.pid };
  }

  async relayStop(args: { signal?: NodeJS.Signals }): Promise<Json> {
    const r = this.#relay;
    if (!r) return { stopped: false };
    const exited = new Promise((res) => r.child.once("exit", res));
    r.child.kill(args.signal ?? "SIGTERM");
    await Promise.race([exited, sleep(10_000)]);
    this.#relay = undefined;
    return { stopped: true };
  }

  async relayRestart(): Promise<Json> {
    if (!this.#relayCfg) throw new Error("no relay");
    return this.relayStart(this.#relayCfg as never);
  }

  // ---------------------------------------------------------------- machines

  #machine(name: string): MachineProc {
    const m = this.#machines.get(name);
    if (!m) throw new Error(`no machine ${name}`);
    return m;
  }

  async machineStart(args: {
    name: string;
    verify?: boolean;
    sweepMs?: number;
    /** A slow `git` (big repo, cold cache, network disk): every call takes this long. */
    slowGitMs?: number;
  }): Promise<Json> {
    let m = this.#machines.get(args.name);
    if (!m) {
      const base = join(this.dir, args.name);
      const home = join(base, "al");
      const fakeHome = join(base, "home");
      const bins = join(base, "bin");
      for (const d of [home, fakeHome, bins, join(fakeHome, "work"), join(base, "sock")])
        mkdirSync(d, { recursive: true, mode: 0o700 });
      for (const tool of ["claude", "codex", "opencode"]) {
        writeFileSync(join(bins, tool), FAKE_CLI);
        chmodSync(join(bins, tool), 0o755);
      }
      if (args.slowGitMs) {
        writeFileSync(
          join(bins, "git"),
          `#!/bin/bash\nsleep ${(args.slowGitMs / 1000).toFixed(3)}\nexec /usr/bin/git "$@"\n`,
        );
        chmodSync(join(bins, "git"), 0o755);
      }
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ handle: args.name, wake: { tmux: false }, notify: { desktop: false } }),
      );
      m = {
        name: args.name,
        home,
        fakeHome,
        bins,
        socket: join(home, "run", "agentlink.sock"),
        verify: args.verify ?? false,
        sweepMs: args.sweepMs ?? 1_000,
        queueOffset: 0,
        runsSeen: new Set(),
      };
      this.#machines.set(args.name, m);
    }
    if (m.child && m.child.exitCode === null && !m.child.killed)
      return { pid: m.pid, home: m.home };
    const child = spawn(
      process.execPath,
      [
        join(HERE, "machine.ts"),
        JSON.stringify({ home: m.home, verify: m.verify, sweepMs: m.sweepMs }),
      ],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        cwd: m.fakeHome,
        env: {
          PATH: `${m.bins}:/usr/bin:/bin`,
          HOME: m.fakeHome,
          AGENTLINK_HOME: m.home,
          AGENTLINK_CODEX_BIN: join(m.bins, "codex"),
          AGENTLINK_CLAUDE_BIN: join(m.bins, "claude"),
          AGENTLINK_OPENCODE_BIN: join(m.bins, "opencode"),
          AGENTLINK_NOTIFY_BIN: "/bin/true",
          AGENTLINK_TMUX_BIN: "/bin/false",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    );
    child.stderr?.on("data", (c: Buffer) => appendFileSync(join(m.home, "stderr.log"), c));
    const mm = m;
    try {
      await new Promise<void>((res, rej) => {
        const to = setTimeout(() => rej(new Error("daemon did not start")), 20_000);
        child.once("message", () => {
          clearTimeout(to);
          res();
        });
        child.once("exit", (code) => {
          clearTimeout(to);
          rej(new Error(`daemon exited ${code}`));
        });
      });
    } catch (error) {
      return { error: String(error) };
    }
    child.on("exit", (code, signal) => {
      this.#push({ type: "daemon-exit", machine: mm.name, code, signal });
    });
    m.child = child;
    m.pid = child.pid as number;
    this.#push({ type: "daemon-start", machine: m.name, pid: m.pid });
    return { pid: m.pid, home: m.home, socket: m.socket };
  }

  async machineStop(args: { name: string; signal?: NodeJS.Signals }): Promise<Json> {
    const m = this.#machine(args.name);
    m.sse?.stop();
    m.sse = undefined;
    const child = m.child;
    if (!child || child.exitCode !== null) return { stopped: false };
    const exited = new Promise((res) => child.once("exit", res));
    child.kill(args.signal ?? "SIGTERM");
    await Promise.race([exited, sleep(15_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, sleep(5_000)]);
    }
    m.child = undefined;
    return { stopped: true };
  }

  /** A request as a process outside any agent's tree (a person, or a script of theirs). */
  async machineReq(args: {
    name: string;
    method: string;
    path: string;
    body?: unknown;
    tty?: boolean;
    timeoutMs?: number;
  }): Promise<HttpResult> {
    const m = this.#machine(args.name);
    if (args.tty && m.verify) return this.#viaTerminal(m, args);
    const chain = ancestry(process.pid).map((p) => ({ ...p, cmd: p.cmd.slice(0, 4) }));
    return unixRequest(
      m.socket,
      args.method,
      args.path,
      args.body,
      { "x-agentlink-caller": b64({ pid: process.pid, chain, tty: !!args.tty }) },
      args.timeoutMs ?? 15_000,
    );
  }

  /** Human-only routes with kernel-checked callers need a terminal: run under `script`. */
  #viaTerminal(
    m: MachineProc,
    args: { method: string; path: string; body?: unknown },
  ): Promise<HttpResult> {
    return new Promise((res) => {
      const inner = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(HERE, "human.ts"))}`;
      const child = spawn("script", ["-qec", inner, "/dev/null"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin",
          HOME: m.fakeHome,
          SIM_HUMAN: JSON.stringify({ socket: m.socket, ...args }),
        },
      });
      let out = "";
      child.stdout.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      child.on("close", () => {
        const match = /@@SIM@@(.*)@@END@@/s.exec(out);
        if (!match)
          return res({ status: 0, data: { out: out.slice(0, 500) }, ms: 0, error: "no output" });
        try {
          res(JSON.parse((match[1] as string).replace(/\r/g, "")) as HttpResult);
        } catch (error) {
          res({ status: 0, data: {}, ms: 0, error: String(error) });
        }
      });
    });
  }

  /** A person's SSE stream (like the web UI / agentlink watch): every delivery state, in order. */
  humanSse(args: { name: string }): Json {
    const m = this.#machine(args.name);
    m.sse?.stop();
    const chain = ancestry(process.pid).map((p) => ({ ...p, cmd: p.cmd.slice(0, 4) }));
    const req = request(
      {
        socketPath: m.socket,
        path: "/v1/events",
        method: "GET",
        headers: { "x-agentlink-caller": b64({ pid: process.pid, chain, tty: false }) },
      },
      (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let i = buffer.indexOf("\n\n");
          while (i >= 0) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            for (const line of block.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const e = JSON.parse(line.slice(6)) as Json;
                if (e.type === "delivery") {
                  const d = e.delivery as Json;
                  this.#push({
                    type: "hsse",
                    machine: m.name,
                    did: d.id,
                    id: d.messageId,
                    to: d.to,
                    state: d.state,
                    method: d.method ?? null,
                  });
                } else if (e.type === "message") {
                  const msg = e.message as Json;
                  this.#push({ type: "hsse-msg", machine: m.name, id: msg.id, from: msg.from });
                }
              } catch {}
            }
            i = buffer.indexOf("\n\n");
          }
        });
        res.on("end", () => this.#push({ type: "hsse-end", machine: m.name }));
      },
    );
    req.on("error", () => this.#push({ type: "hsse-end", machine: m.name }));
    req.end();
    m.sse = { stop: () => req.destroy() };
    return { ok: true };
  }

  fakeMode(args: { name: string; mode: string }): Json {
    writeFileSync(join(this.#machine(args.name).bins, "mode"), args.mode);
    return { ok: true };
  }

  /** Read-only look at a machine's database (ground truth for the final checks). */
  query(args: { name: string; sql: string; params?: (string | number | null)[] }): Json[] {
    const m = this.#machine(args.name);
    const db = new DatabaseSync(join(m.home, "agentlink.db"), { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      return db.prepare(args.sql).all(...(args.params ?? [])) as Json[];
    } finally {
      db.close();
    }
  }

  files(args: { name: string }): Json {
    const m = args.name === "relay" ? undefined : this.#machine(args.name);
    const base = m ? m.home : join(this.dir, "relay");
    const read = (f: string, max = 2_000_000) => {
      const p = join(base, f);
      if (!existsSync(p)) return "";
      const size = statSync(p).size;
      const text = readFileSync(p, "utf8");
      return size > max ? text.slice(-max) : text;
    };
    return {
      log: read(m ? "daemon.log" : "relay.log"),
      crash: read("sim-crash.log"),
      stderr: read("stderr.log"),
      hookErrors: m ? read("hook-errors.log") : "",
      stats: read("sim-stats.jsonl", 8_000_000),
      dbBytes:
        m && existsSync(join(m.home, "agentlink.db"))
          ? statSync(join(m.home, "agentlink.db")).size
          : 0,
    };
  }

  // ---------------------------------------------------------------- agents

  /** Creates a project folder (a git repo on `branch`) under the machine's fake home. */
  project(args: { name: string; project: string; branch?: string }): Json {
    const m = this.#machine(args.name);
    const dir = join(m.fakeHome, "work", args.project);
    if (!existsSync(join(dir, ".git"))) {
      mkdirSync(dir, { recursive: true });
      const git = (...a: string[]) =>
        execFileSync("git", a, {
          cwd: dir,
          stdio: "ignore",
          env: { PATH: "/usr/bin:/bin", HOME: m.fakeHome, GIT_CONFIG_NOSYSTEM: "1" },
        });
      try {
        git("init", "-q", "-b", args.branch ?? "main");
        git("remote", "add", "origin", `git@github.com:northwind/${args.project}.git`);
        git(
          "-c",
          "user.email=sim@example.invalid",
          "-c",
          "user.name=sim",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "init",
        );
      } catch {
        // a plain folder works too
      }
    }
    return { cwd: dir };
  }

  async agentStart(args: {
    key: string;
    machine: string;
    tool: string;
    cwd: string;
  }): Promise<Json> {
    const m = this.#machine(args.machine);
    const old = this.#agents.get(args.key);
    if (old && !old.exited) old.child.kill("SIGKILL");
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: m.fakeHome,
      SIM_AGENT_CFG: JSON.stringify({
        key: args.key,
        socket: m.socket,
        tool: args.tool,
        cliPath: CLI,
        agentlinkHome: m.home,
        home: m.fakeHome,
        cwd: args.cwd,
      }),
    };
    const exe = JSON.stringify(process.execPath);
    const script = JSON.stringify(join(HERE, "agent.ts"));
    // argv[0] names the CLI, so the daemon (and its kernel caller check) sees "the agent".
    // the CLIs' real binary names (Cursor's CLI is cursor-agent)
    const bin = args.tool === "cursor" ? "cursor-agent" : args.tool;
    const child = spawn("bash", ["-c", `exec -a /usr/local/bin/${bin} ${exe} ${script}`], {
      cwd: args.cwd,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env,
    });
    child.stderr?.on("data", (c: Buffer) =>
      appendFileSync(join(this.dir, args.machine, "agents-stderr.log"), `[${args.key}] ${c}`),
    );
    const a: AgentProc = {
      key: args.key,
      machine: args.machine,
      tool: args.tool,
      cwd: args.cwd,
      child,
      pid: child.pid as number,
      calls: new Map(),
      nextId: 1,
      exited: false,
    };
    await new Promise<void>((res, rej) => {
      const to = setTimeout(() => rej(new Error("agent did not start")), 15_000);
      const onMsg = (msg: Json) => {
        if (msg.ready) {
          clearTimeout(to);
          child.off("message", onMsg);
          res();
        }
      };
      child.on("message", onMsg);
      child.once("exit", (code) => rej(new Error(`agent exited ${code}`)));
    });
    child.on("message", (msg: Json) => {
      if (msg.ev) this.#push({ ...(msg.ev as Json), machine: args.machine });
      else if (typeof msg.id === "number") {
        a.calls.get(msg.id)?.(msg.result);
        a.calls.delete(msg.id);
      }
    });
    child.on("exit", (code, signal) => {
      a.exited = true;
      for (const fn of a.calls.values()) fn({ status: 0, error: "agent exited", data: {} });
      a.calls.clear();
      this.#push({ type: "agent-exit", agent: args.key, machine: args.machine, code, signal });
    });
    const start = procInfo(a.pid)?.start;
    a.start = start;
    this.#agents.set(args.key, a);
    return { pid: a.pid, ...(start ? { start } : {}) };
  }

  agentKill(args: { key: string; signal?: NodeJS.Signals }): Json {
    const a = this.#agents.get(args.key);
    if (!a || a.exited) return { killed: false };
    a.child.kill(args.signal ?? "SIGKILL");
    return { killed: true };
  }

  agentCall(args: { key: string; op: string; args?: Json; timeoutMs?: number }): Promise<unknown> {
    const a = this.#agents.get(args.key);
    if (!a || a.exited) return Promise.resolve({ status: 0, error: "agent not running", data: {} });
    const id = a.nextId++;
    return new Promise((res) => {
      const to = setTimeout(() => {
        a.calls.delete(id);
        res({ status: 0, error: "ipc timeout", data: {} });
      }, args.timeoutMs ?? 120_000);
      a.calls.set(id, (r) => {
        clearTimeout(to);
        res(r);
      });
      a.child.send({ id, op: args.op, args: args.args ?? {} });
    });
  }

  /** Push channels written by the daemon's children: `codex queue` lines and headless runs. */
  #scan(): void {
    for (const m of this.#machines.values()) {
      const q = join(m.bins, "queue.log");
      try {
        if (existsSync(q) && statSync(q).size > m.queueOffset) {
          const text = readFileSync(q, "utf8");
          const fresh = text.slice(m.queueOffset);
          const end = fresh.lastIndexOf("\n") + 1;
          m.queueOffset += Buffer.byteLength(fresh.slice(0, end));
          for (const line of fresh.slice(0, end).split("\n").filter(Boolean)) {
            const { thread, b64: body } = JSON.parse(line) as { thread: string; b64: string };
            const msg = Buffer.from(body, "base64").toString("utf8");
            this.#push({
              type: "inject",
              via: "codex-queue",
              machine: m.name,
              session: thread,
              ids: injectedIds(msg),
            });
          }
        }
        const runs = join(m.bins, "runs");
        if (existsSync(runs)) {
          for (const f of readdirSync(runs)) {
            if (!f.endsWith(".stdin") || m.runsSeen.has(f)) continue;
            m.runsSeen.add(f);
            const stdin = readFileSync(join(runs, f), "utf8");
            this.#push({
              type: "inject",
              via: "headless",
              machine: m.name,
              run: f.replace(/\.stdin$/, ""),
              ids: injectedIds(stdin),
            });
          }
        }
      } catch {
        // partial file; next scan
      }
    }
  }

  pids(): Json {
    return {
      worker: process.pid,
      relay: this.#relay?.pid ?? null,
      machines: Object.fromEntries([...this.#machines].map(([k, m]) => [k, m.pid ?? null])),
      agents: Object.fromEntries([...this.#agents].map(([k, a]) => [k, a.exited ? null : a.pid])),
    };
  }

  async shutdown(): Promise<Json> {
    for (const a of this.#agents.values()) if (!a.exited) a.child.kill("SIGKILL");
    await Promise.all([...this.#machines.keys()].map((name) => this.machineStop({ name })));
    await this.relayStop({});
    clearInterval(this.#timer);
    return { ok: true };
  }
}

/** The orchestrator's view of a worker: in-process or over HTTP. */
export interface WorkerApi {
  call<T = unknown>(method: string, args?: Json): Promise<T>;
  label: string;
}

export function localWorker(dir: string): WorkerApi & { worker: Worker } {
  const worker = new Worker(dir);
  return {
    worker,
    label: "local",
    async call<T>(method: string, args: Json = {}): Promise<T> {
      const fn = (worker as unknown as Record<string, (a: Json) => unknown>)[method];
      if (typeof fn !== "function") throw new Error(`no worker method ${method}`);
      return (await fn.call(worker, args)) as T;
    },
  };
}

export function remoteWorker(url: string, token: string): WorkerApi {
  return {
    label: url,
    call<T>(method: string, args: Json = {}): Promise<T> {
      const body = JSON.stringify({ method, args });
      return new Promise((res, rej) => {
        const req = request(
          `${url}/rpc`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-sim-token": token,
              "content-length": Buffer.byteLength(body),
            },
          },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              try {
                const parsed = JSON.parse(text) as { result?: T; error?: string };
                if (parsed.error) rej(new Error(parsed.error));
                else res(parsed.result as T);
              } catch (error) {
                rej(error);
              }
            });
          },
        );
        req.setTimeout(180_000, () => req.destroy(new Error("worker rpc timeout")));
        req.on("error", rej);
        req.end(body);
      });
    },
  };
}

// ------------------------------------------------------------------ serve mode
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const listen = opt("--serve");
  const token = opt("--token");
  const dir = opt("--dir");
  if (!listen || !token || !dir) {
    console.error("usage: worker.ts --serve host:port --token T --dir DIR");
    process.exit(2);
  }
  const worker = new Worker(dir);
  const [host, port] = listen.split(":") as [string, string];
  const server = createServer((req, res) => {
    if (req.headers["x-sim-token"] !== token || req.url !== "/rpc") {
      res.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let out: Json;
      try {
        const { method, args: a } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          method: string;
          args: Json;
        };
        const fn = (worker as unknown as Record<string, (x: Json) => unknown>)[method];
        if (typeof fn !== "function") throw new Error(`no worker method ${method}`);
        out = { result: await fn.call(worker, a ?? {}) };
        if (method === "shutdown") setTimeout(() => process.exit(0), 200);
      } catch (error) {
        out = { error: String((error as Error)?.message ?? error) };
      }
      const text = JSON.stringify(out);
      res.writeHead(200, { "content-type": "application/json" }).end(text);
    });
  });
  server.listen(Number(port), host, () => console.log(`sim worker on ${listen} (dir ${dir})`));
  const bye = () => void worker.shutdown().then(() => process.exit(0));
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}
