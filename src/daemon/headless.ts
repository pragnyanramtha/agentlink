import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { NAME_RE } from "../core/addr.ts";
import {
  HARNESSES,
  type Harness,
  type HeadlessConfig,
  MODEL_RE,
  type Profile,
} from "../core/config.ts";
import { EXPECTS_REPLY, WAKE_KINDS } from "../core/envelope.ts";
import { AgentLinkError, forbidden, invalid, limited, notFound } from "../core/errors.ts";
import { homeShort } from "../core/identity.ts";
import { LIMITS } from "../core/limits.ts";
import { headlessDecision, type Trust } from "../core/policy.ts";
import { isAlive, procInfo } from "../core/proc.ts";
import { type DaemonContext, iso } from "./context.ts";
import type { DeliveryEngine } from "./delivery.ts";
import type { Mailbox, SendResult } from "./mailbox.ts";
import { isLive, type Registry } from "./registry.ts";
import { executable, type Out, obj, RUNNERS } from "./runners/index.ts";
import type { AgentRow, DeliveryRow, InboxItem, MessageRow, Sender } from "./types.ts";

export type RunState = "held" | "queued" | "running" | "done" | "failed" | "stopped" | "denied";

export interface RunRow {
  id: number;
  agent_id: string;
  harness: Harness;
  kind: "wake" | "spawn";
  profile: Profile;
  model: string | null;
  state: RunState;
  requester: string;
  requester_agent_id: string | null;
  trust: Trust;
  trigger_id: string | null;
  thread_id: string | null;
  hops: number;
  cwd: string;
  session_id: string | null;
  argv: string | null;
  pid: number | null;
  deliveries: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  signal: string | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  denials: number | null;
  result_id: string | null;
  note: string | null;
}

/** Who asked for a run, as the daemon verified it (never taken from a message body). */
export interface Requester {
  addr: string;
  agentId: string | null;
  trust: Trust;
}

const isHarness = (tool: string): tool is Harness =>
  (HARNESSES as readonly string[]).includes(tool);
const MAX_LOG = 1024 * 1024;
const MAX_REPLY = 8_000;
const STOP_GRACE_MS = 10_000;
/** After a run's CLI exited (or the daemon stops): SIGTERM to its group, SIGKILL after this. */
const EXIT_GRACE_MS = 3_000;
/** Inherited from whoever started the daemon, but wrong for a separate session. */
const STRIP_ENV =
  /^(CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|MESSAGING_SOCKET|SSE_PORT)|CLAUDE_ENV_FILE|CODEX_THREAD_ID|CODEX_SANDBOX\w*|OPENCODE_SESSION\w*|AGENTLINK_AGENT|TMUX|TMUX_PANE|STY)$/;

export const runRef = (id: number) => `R${id}`;
/** "R12", "r12" or "12". */
export const parseRunRef = (ref: string): number | undefined =>
  /^r?\d{1,12}$/i.test(ref.trim()) ? Number(ref.trim().replace(/^r/i, "")) : undefined;

/** `leaderGone`: the pid itself exited (and may be reused), so only its group is signalled. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0, leaderGone = false): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    if (leaderGone) return false;
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false; // already gone
    }
  }
}

/** SIGTERM to a run's process group, SIGKILL to whatever is left after the grace; resolves when done. */
function endGroup(pid: number, leaderGone: boolean): Promise<void> {
  signalGroup(pid, "SIGTERM", leaderGone);
  const deadline = Date.now() + EXIT_GRACE_MS;
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      const alive = signalGroup(pid, 0, leaderGone);
      if (alive && Date.now() < deadline) return;
      if (alive) signalGroup(pid, "SIGKILL", leaderGone);
      clearInterval(tick);
      resolve();
    }, 50);
  });
}

interface Live {
  pid: number;
  child: ChildProcess;
  timers: NodeJS.Timeout[];
  stopping?: string;
}

/**
 * Headless runs: resumes an offline agent's own session (claude -p --resume, codex exec resume,
 * opencode run --session) or spawns a new one to handle queued asks, and posts the final answer
 * as the agent's reply. Off by default; a person enables it per CLI and per folder root.
 */
export class Headless {
  readonly #ctx: DaemonContext;
  readonly #registry: Registry;
  readonly #mailbox: Mailbox;
  readonly #live = new Map<number, Live>();
  /** Runs marked running whose #start has not finished (not in #live yet). */
  readonly #starting = new Set<number>();
  readonly #logDir: string;
  #closed = false;
  engine?: DeliveryEngine;

  constructor(ctx: DaemonContext, registry: Registry, mailbox: Mailbox) {
    this.#ctx = ctx;
    this.#registry = registry;
    this.#mailbox = mailbox;
    this.#logDir = join(ctx.paths.home, "runs");
    // Runs a previous daemon left behind: their mail goes back to the queue.
    for (const run of ctx.store.all<RunRow>(
      "SELECT * FROM runs WHERE state IN ('queued','running')",
    )) {
      this.#mailbox.requeue(JSON.parse(run.deliveries ?? "[]"));
      this.#update(run.id, { state: "failed", note: "the daemon restarted during the run" });
    }
  }

  get #cfg(): HeadlessConfig {
    return this.#ctx.config.headless;
  }

  get running(): number {
    return (
      this.#ctx.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE state = 'running'")
        ?.n ?? 0
    );
  }

  get(id: number): RunRow {
    const run = this.#ctx.store.get<RunRow>("SELECT * FROM runs WHERE id = ?", id);
    if (!run) throw notFound(`run ${runRef(id)}`);
    return run;
  }

  /** The run that is held, queued or running for an agent, if any. */
  activeFor(agentId: string): RunRow | undefined {
    return this.#ctx.store.get<RunRow>(
      "SELECT * FROM runs WHERE agent_id = ? AND state IN ('held','queued','running') ORDER BY id DESC LIMIT 1",
      agentId,
    );
  }

  requesterOf(sender: Sender): Requester {
    return sender.kind === "agent"
      ? { addr: sender.agent.name, agentId: sender.agent.id, trust: "local" }
      : { addr: `@${this.#mailbox.handle}`, agentId: null, trust: "user" };
  }

  bin(harness: Harness): string | undefined {
    const path =
      process.env[`AGENTLINK_${harness.toUpperCase()}_BIN`] || this.#cfg.runners[harness]?.bin;
    return path && executable(path) ? path : undefined;
  }

  /** The real directory, if it is inside an allowed root. */
  #inRoots(dir: string | null): string | undefined {
    if (!dir) return undefined;
    let real: string;
    try {
      real = realpathSync(dir);
      if (!statSync(real).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    for (const root of this.#cfg.roots) {
      try {
        const r = realpathSync(root);
        if (real === r || real.startsWith(r.endsWith("/") ? r : `${r}/`)) return real;
      } catch {
        // a root that no longer exists allows nothing
      }
    }
    return undefined;
  }

  /** Throws unless a run of `harness` may start in `dir` now; returns the real directory. */
  #check(harness: string, dir: string | null): string {
    const cfg = this.#cfg;
    if (!cfg.enabled)
      throw forbidden("headless runs are off on this machine (a person can enable them)");
    if (!isHarness(harness)) throw invalid(`agentlink cannot run ${harness} headlessly`);
    if (!cfg.runners[harness]?.enabled)
      throw forbidden(`headless ${harness} runs are not enabled on this machine`);
    if (this.#mailbox.paused) throw forbidden("agentlink is paused");
    const real = this.#inRoots(dir);
    if (!real)
      throw forbidden(
        `${dir ? homeShort(dir) : "its folder"} is outside the folders allowed for headless runs`,
      );
    if (!this.bin(harness)) throw invalid(`the ${harness} binary was not found`);
    return real;
  }

  /** resume: its own session; new: a spawned agent that has no session yet. */
  #mode(agent: AgentRow, harness: Harness): "resume" | "new" | undefined {
    if (agent.session_id)
      return RUNNERS[harness].sessionRe.test(agent.session_id) ? "resume" : undefined;
    return this.#registry.spawnDepth(agent.id).by ? "new" : undefined;
  }

  /** Hops of the run `agentId` is in right now, plus one (0 outside runs). */
  #runHops(agentId: string | null): number {
    if (!agentId) return 0;
    const h = this.#ctx.store.get<{ h: number | null }>(
      "SELECT MAX(hops) AS h FROM runs WHERE agent_id = ? AND state = 'running'",
      agentId,
    )?.h;
    return h == null ? 0 : h + 1;
  }

  #checkBudgets(agentId: string | undefined, kind: "wake" | "spawn", thread?: string | null) {
    const cfg = this.#cfg;
    const since = iso(new Date(this.#ctx.now().getTime() - 3600_000));
    const count = (where: string, ...params: string[]) =>
      this.#ctx.store.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM runs WHERE state != 'denied' AND ${where}`,
        ...params,
      )?.n ?? 0;
    const over = (used: number, limit: number, what: string) => {
      if (used >= limit)
        throw limited("headless_budget", `headless ${what} used up (${used}/${limit})`);
    };
    if (agentId)
      over(
        count("created_at > ? AND agent_id = ?", since, agentId),
        cfg.perAgentPerHour,
        "runs per agent and hour",
      );
    over(count("created_at > ?", since), cfg.globalPerHour, "runs per hour");
    if (kind === "spawn")
      over(count("created_at > ? AND kind = 'spawn'", since), cfg.spawnPerHour, "spawns per hour");
    if (thread) over(count("thread_id = ?", thread), cfg.perThreadRuns, "runs per conversation");
  }

  /**
   * Asks for a run that resumes an offline agent. Starts it (allow), holds it for a person
   * (hold), or throws with the reason. A run already pending for the agent is returned as is.
   */
  request(o: { agent: AgentRow; requester: Requester; trigger?: InboxItem }): RunRow {
    const cwd = this.#check(o.agent.tool, o.agent.cwd);
    const harness = o.agent.tool as Harness;
    const decision = headlessDecision(o.requester.trust, "wake", this.#cfg.from);
    if (decision === "refuse")
      throw forbidden(
        `${o.requester.trust === "local" || o.requester.trust === "user" ? o.requester.addr : `${o.requester.trust} senders`} may not wake agents headlessly here`,
      );
    const active = this.activeFor(o.agent.id);
    if (active) return active;
    const agent = this.#registry.refreshLiveness(o.agent);
    if (isLive(agent)) throw invalid(`${agent.name} is running; messages reach it directly`);
    if (!this.#mode(agent, harness))
      throw invalid(`${agent.name} has no ${harness} session agentlink can resume`);
    // A run asking for another run counts one hop further (runs waking runs stop at the limit).
    const hops = Math.max(o.trigger?.envelope.meta.hops ?? 0, this.#runHops(o.requester.agentId));
    if (hops >= LIMITS.maxHops)
      throw limited("hops", `too many hops (${hops}) for another headless run`);
    this.#checkBudgets(agent.id, "wake", o.trigger?.message.thread_id);
    const id = this.#insert({
      agent,
      harness,
      kind: "wake",
      cwd,
      requester: o.requester,
      trigger: o.trigger,
      model: undefined,
      held: decision === "hold",
      hops,
    });
    this.#pump();
    return this.get(id);
  }

  #insert(r: {
    agent: AgentRow;
    harness: Harness;
    kind: "wake" | "spawn";
    cwd: string;
    requester: Requester;
    trigger: InboxItem | undefined;
    model: string | undefined;
    held: boolean;
    hops: number;
  }): number {
    return this.#ctx.store.run(
      `INSERT INTO runs (agent_id, harness, kind, profile, model, state, requester, requester_agent_id, trust,
         trigger_id, thread_id, hops, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.agent.id,
      r.harness,
      r.kind,
      this.#cfg.runners[r.harness]?.profile ?? "read-only",
      r.model ?? null,
      r.held ? "held" : "queued",
      r.requester.addr,
      r.requester.agentId,
      r.requester.trust,
      r.trigger?.message.id ?? null,
      r.trigger?.message.thread_id ?? null,
      r.hops,
      r.cwd,
      iso(this.#ctx.now()),
    ).lastInsertRowid;
  }

  /** Spawns a new agent: registers it, sends it the task as an ask, and runs it. */
  spawn(
    sender: Sender,
    o: { harness: Harness; cwd: string; name?: string; model?: string; task: string },
  ): { agent: AgentRow; run: RunRow; sent: SendResult } {
    const requester = this.requesterOf(sender);
    const cwd = this.#check(o.harness, o.cwd);
    const decision = headlessDecision(requester.trust, "spawn", this.#cfg.from);
    if (decision === "refuse") throw forbidden(`${requester.addr} may not spawn agents here`);
    const depth = (requester.agentId ? this.#registry.spawnDepth(requester.agentId).depth : 0) + 1;
    if (depth > this.#cfg.maxSpawnDepth)
      throw forbidden("an agent started by spawn cannot spawn others (a person can allow it)");
    if (o.model && !MODEL_RE.test(o.model)) throw invalid(`invalid model name "${o.model}"`);
    const name = o.name?.trim().toLowerCase();
    if (name && !NAME_RE.test(name)) throw invalid(`invalid agent name "${o.name}"`);
    if (name && this.#registry.resolveName(name))
      throw new AgentLinkError(
        "name_taken",
        `there is already an agent named ${name} (resume it with: agentlink wake ${name})`,
        409,
      );
    if (this.#runHops(requester.agentId) >= LIMITS.maxHops)
      throw limited("hops", "too many hops for another headless run");
    this.#checkBudgets(undefined, "spawn");
    const { agent } = this.#registry.register({
      tool: o.harness,
      cwd,
      name: name ?? this.#registry.freeName(o.harness, cwd),
      state: "offline",
      ...(o.model ? { model: o.model } : {}),
    });
    this.#registry.markSpawned(agent.id, requester.addr, depth);
    const sent = this.#mailbox.send(sender, { kind: "ask", to: [agent.name], text: o.task });
    const trigger = sent.queued[0];
    const id = this.#insert({
      agent,
      harness: o.harness,
      kind: "spawn",
      cwd,
      requester,
      trigger,
      model: o.model,
      held: decision === "hold",
      hops: trigger?.envelope.meta.hops ?? 0,
    });
    this.#pump();
    return { agent: this.#registry.byId(agent.id) as AgentRow, run: this.get(id), sent };
  }

  /**
   * For mail queued to an offline agent: resumes it headlessly when the mail asks for an answer
   * and policy allows. Returns the note for the sender, or undefined when headless runs are off.
   */
  onOffline(agent: AgentRow, items: InboxItem[]): string | undefined {
    if (!this.#cfg.enabled) return undefined;
    const trigger = items.find(
      (i) =>
        WAKE_KINDS.has(i.message.kind) &&
        i.message.trust !== "external" &&
        (i.envelope.meta.hops ?? 0) < LIMITS.maxHops,
    );
    if (!trigger) return undefined;
    const requester: Requester = {
      addr: trigger.message.from_addr,
      agentId: trigger.message.from_agent_id,
      trust: trigger.message.trust,
    };
    try {
      return this.note(this.request({ agent, requester, trigger }), agent);
    } catch (error) {
      return `queued: ${agent.name} is offline and was not woken (${(error as Error).message}); it gets the message when it is back`;
    }
  }

  /** Sender-facing words for a run. */
  note(run: RunRow, agent: AgentRow): string {
    const how = `${RUNNERS[run.harness].label(run.kind === "wake")}, ${run.profile}, ${runRef(run.id)}`;
    const what = run.kind === "spawn" ? "starting" : "waking";
    if (run.state === "held")
      return `held: ${what} ${agent.name} headlessly needs a person's approval on its machine (${runRef(run.id)}); the message stays queued`;
    if (run.kind === "spawn") return `starting ${agent.name} headlessly (${how})`;
    return `${agent.name} is offline: waking it headlessly (${how})`;
  }

  #pump(): void {
    if (this.#closed || this.#mailbox.paused) return;
    while (this.running < this.#cfg.maxConcurrent) {
      const next = this.#ctx.store.get<RunRow>(
        "SELECT * FROM runs WHERE state = 'queued' ORDER BY id LIMIT 1",
      );
      if (!next) return;
      this.#update(next.id, { state: "running", started_at: iso(this.#ctx.now()) });
      this.#starting.add(next.id);
      void this.#start(next)
        .catch((error) =>
          this.#ctx.log.warn("headless run start failed", {
            run: runRef(next.id),
            error: String(error),
          }),
        )
        .finally(() => this.#starting.delete(next.id));
    }
  }

  #update(id: number, fields: Partial<Record<keyof RunRow, string | number | null>>): void {
    const keys = Object.keys(fields);
    this.#ctx.store.run(
      `UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
      ...keys.map((k) => fields[k as keyof RunRow] ?? null),
      id,
    );
  }

  #settle(run: RunRow, state: RunState, note: string): void {
    this.#update(run.id, { state, note, ended_at: iso(this.#ctx.now()) });
    this.engine?.refreshPending(run.agent_id);
    this.#pump();
  }

  async #start(run: RunRow): Promise<void> {
    let claimed: number[] = [];
    try {
      let agent = this.#registry.byId(run.agent_id);
      if (!agent) return this.#settle(run, "failed", "the agent was removed");
      const harness = run.harness;
      this.#check(harness, run.cwd);
      const mode = this.#mode(agent, harness);
      if (!mode) throw invalid(`${agent.name} has no session to resume`);
      const bin = this.bin(harness) as string;
      if (harness === "claude" && mode === "resume" && (await this.#claudeOpen(bin, run, agent)))
        throw invalid("that Claude Code session is open somewhere else; not resuming it");
      if (this.#closed || this.get(run.id).state !== "running") return;
      // Re-checked right before the spawn: never resume a session that is running.
      agent = this.#registry.refreshLiveness(this.#registry.byId(run.agent_id) ?? agent);
      if (isLive(agent))
        return this.#settle(run, "done", `${agent.name} came back; messages reach it directly`);
      const items = this.#mailbox.pending(agent.id).slice(0, LIMITS.maxInboxBatch);
      if (items.length === 0) return this.#settle(run, "done", "nothing left to deliver");
      const runner = RUNNERS[harness];
      const sessionId =
        mode === "resume"
          ? (agent.session_id as string)
          : runner.preassign
            ? randomUUID()
            : undefined;
      const cfg = this.#cfg;
      // The person's current settings win over those when the run was asked for (or held).
      const profile = cfg.runners[harness]?.profile ?? "read-only";
      const model = run.model ?? cfg.runners[harness]?.model;
      const { argv, env } = runner.argv({
        resume: mode === "resume",
        ...(sessionId ? { sessionId } : {}),
        cwd: run.cwd,
        profile,
        ...(model ? { model } : {}),
        ...(cfg.maxBudgetUsd ? { maxBudgetUsd: cfg.maxBudgetUsd } : {}),
      });
      // Claimed before the spawn, so the session's own start hook doesn't inject them again.
      claimed = items.map((i) => i.delivery.id);
      this.#mailbox.markSeen(claimed, `headless:${harness}`, "delivered");
      const child = spawn(bin, argv, {
        cwd: run.cwd,
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: this.#env(run.id, env),
      });
      const pid = child.pid;
      if (!pid) {
        const error = await new Promise<Error>((resolve) => child.once("error", resolve));
        throw new Error(`could not start ${harness}: ${error.message}`);
      }
      // Pre-registered in the same tick as the spawn: the child's first hook or CLI call
      // already resolves to this agent, never to the human.
      const pidStart = procInfo(pid)?.start;
      this.#registry.attachRun(agent.id, {
        id: run.id,
        pid,
        ...(pidStart ? { pidStart } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
      this.#update(run.id, {
        pid,
        profile,
        model: model ?? null,
        session_id: sessionId ?? null,
        argv: JSON.stringify([bin, ...argv]),
        deliveries: JSON.stringify(claimed),
      });
      this.#ctx.store.run(
        "INSERT INTO wake_log (agent_id, sender, method, at) VALUES (?, ?, ?, ?)",
        agent.id,
        run.requester,
        `headless:${harness}`,
        iso(this.#ctx.now()),
      );
      child.stdin?.on("error", () => {}); // a CLI that exits early closes its stdin
      const started = this.get(run.id);
      child.stdin?.end(this.#prompt(agent, items, started, mode));
      this.#watch(started, agent.id, child, pid);
    } catch (error) {
      if (claimed.length) this.#mailbox.requeue(claimed);
      if (!this.#closed) this.#settle(run, "failed", (error as Error).message);
    }
  }

  #env(runId: number, extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && !STRIP_ENV.test(k)) env[k] = v;
    return { ...env, ...extra, AGENTLINK_HOME: this.#ctx.paths.home, AGENTLINK_RUN: runRef(runId) };
  }

  /** `claude agents --json` lists sessions open anywhere (interactive and background). */
  #claudeOpen(bin: string, run: RunRow, agent: AgentRow): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        bin,
        ["agents", "--json"],
        { cwd: run.cwd, timeout: 10_000, maxBuffer: MAX_LOG, env: this.#env(run.id) },
        (error, stdout) => resolve(!error && String(stdout).includes(agent.session_id as string)),
      );
    });
  }

  #prompt(agent: AgentRow, items: InboxItem[], run: RunRow, mode: "resume" | "new"): string {
    const can =
      run.profile === "read-only"
        ? "You may read files but not edit them or run commands."
        : run.profile === "edit"
          ? "You may edit files in this folder; shell commands may be refused."
          : "You may edit files and run commands.";
    return [
      `agentlink ${mode === "resume" ? "resumed your session" : "started you"} headlessly (no person is watching) as ${agent.name}, because of the message(s) below. ${can}`,
      "Do what they ask if it is reasonable and within your permissions, then end with your answer: agentlink posts your final message as your reply (or answer yourself with agentlink reply <id>).",
      "",
      this.#mailbox.render(items, agent.name),
    ].join("\n");
  }

  #watch(run: RunRow, agentId: string, child: ChildProcess, pid: number): void {
    const runner = RUNNERS[run.harness];
    const live: Live = { pid, child, timers: [] };
    this.#live.set(run.id, live);
    child.on("error", (error) =>
      this.#ctx.log.warn("headless run error", { run: runRef(run.id), error: String(error) }),
    );
    live.timers.push(setTimeout(() => this.stop(run.id, "timed out"), this.#cfg.timeoutSec * 1000));
    mkdirSync(this.#logDir, { recursive: true, mode: 0o700 });
    const logPath = join(this.#logDir, `${run.id}.jsonl`);
    writeFileSync(logPath, "", { mode: 0o600 });
    const out: Out = {};
    let buf = "";
    let bytes = 0;
    let stderr = "";
    let sessionSaved = !!run.session_id;
    const onLine = (line: string) => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      out.started = true;
      runner.parse(obj(event), out);
      if (!sessionSaved && out.sessionId && runner.sessionRe.test(out.sessionId)) {
        sessionSaved = true;
        this.#registry.setSession(agentId, out.sessionId);
        this.#update(run.id, { session_id: out.sessionId });
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (bytes >= MAX_LOG) return; // the rest is drained, not kept
      const take = chunk.subarray(0, MAX_LOG - bytes);
      bytes += take.length;
      try {
        appendFileSync(logPath, take);
      } catch {
        // the log is a convenience
      }
      buf += take.toString("utf8");
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
    });
    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      onLine(buf);
      this.#ended(run.id, agentId, live, out, code, signal, stderr);
    };
    child.once("exit", (code, signal) => {
      // Whatever the agent left running in its process group goes too (it may hold the pipes).
      child.once("close", () => finish(code, signal));
      void endGroup(pid, true).then(() => setTimeout(() => finish(code, signal), 1_000).unref());
    });
  }

  #ended(
    runId: number,
    agentId: string,
    live: Live,
    out: Out,
    code: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ): void {
    for (const t of live.timers) clearTimeout(t);
    this.#live.delete(runId);
    if (this.#closed) return;
    const run = this.get(runId);
    const claimed = JSON.parse(run.deliveries ?? "[]") as number[];
    const lastErr = stderr.trim().split("\n").pop()?.slice(0, 300);
    const failed = !!live.stopping || code !== 0 || !!out.error;
    let resultId: string | undefined;
    if (!failed && out.text?.trim()) {
      resultId = this.#answer(run, agentId, out.text.trim());
      this.#mailbox.markSeen(claimed, `headless:${run.harness}`);
    } else if (failed || !out.started) {
      // Stopped, failed or never started: no answer, so the mail waits for its next session.
      this.#mailbox.requeue(claimed);
    }
    const state: RunState = live.stopping ? "stopped" : failed ? "failed" : "done";
    this.#update(runId, {
      state,
      ended_at: iso(this.#ctx.now()),
      exit_code: code,
      signal,
      cost_usd: out.costUsd ?? null,
      tokens_in: out.tokensIn ?? null,
      tokens_out: out.tokensOut ?? null,
      denials: out.denials ?? null,
      result_id: resultId ?? null,
      note:
        live.stopping ??
        out.error?.slice(0, 300) ??
        (failed ? lastErr || `exited with ${code ?? signal}` : null) ??
        (out.text ? null : "no answer in the output"),
    });
    const agent = this.#registry.byId(agentId);
    if (agent && isLive(agent) && (agent.pid === live.pid || !agent.pid || !isAlive(agent.pid)))
      this.#registry.setState(agentId, "offline");
    this.engine?.refreshPending(agentId);
    this.#pump();
  }

  /** Posts the run's final text as the agent's reply to each ask it was given and didn't answer. */
  #answer(run: RunRow, agentId: string, text: string): string | undefined {
    const agent = this.#registry.byId(agentId);
    if (!agent) return undefined;
    const body =
      text.length > MAX_REPLY
        ? `${text.slice(0, MAX_REPLY)}\n\n[cut at ${MAX_REPLY} characters; the full output: agentlink runs ${runRef(run.id)}]`
        : text;
    let first: string | undefined;
    for (const id of JSON.parse(run.deliveries ?? "[]") as number[]) {
      const d = this.#ctx.store.get<DeliveryRow>("SELECT * FROM deliveries WHERE id = ?", id);
      const m = d
        ? this.#ctx.store.get<MessageRow>("SELECT * FROM messages WHERE id = ?", d.message_id)
        : undefined;
      if (!d || !m || !EXPECTS_REPLY.has(m.kind) || m.kind === "handoff") continue;
      if (["replied", "acked", "refused", "expired"].includes(d.state)) continue; // it answered itself
      try {
        const res = this.#mailbox.send(
          { kind: "agent", agent },
          { kind: "reply", replyTo: m.id, text: body },
        );
        this.engine?.onQueued(res.queued);
        first ??= String(res.message.id);
      } catch (error) {
        this.#ctx.log.warn("headless reply not posted", {
          run: runRef(run.id),
          error: String(error),
        });
      }
    }
    return first;
  }

  /** SIGINT, then SIGTERM after 10s, then SIGKILL to the whole process group. */
  stop(id: number, why: string): RunRow {
    const run = this.get(id);
    const live = this.#live.get(id);
    if (run.state === "held" || run.state === "queued" || (run.state === "running" && !live)) {
      this.#update(id, {
        state: run.state === "held" ? "denied" : "stopped",
        note: why,
        ended_at: iso(this.#ctx.now()),
      });
      return this.get(id);
    }
    if (live && !live.stopping) {
      live.stopping = why;
      signalGroup(live.pid, "SIGINT");
      live.timers.push(
        setTimeout(() => signalGroup(live.pid, "SIGTERM"), STOP_GRACE_MS),
        setTimeout(() => signalGroup(live.pid, "SIGKILL"), 2 * STOP_GRACE_MS),
      );
    }
    return this.get(id);
  }

  /** agentlink pause: no new runs start and running ones are interrupted. */
  pauseAll(): void {
    for (const run of this.#ctx.store.all<RunRow>("SELECT * FROM runs WHERE state = 'running'"))
      this.stop(run.id, "agentlink was paused");
  }

  resume(): void {
    this.#pump();
  }

  /** A person approves or denies a held run (the human-only approvals path). */
  decide(id: number, decision: "approve" | "deny", by: string): RunRow {
    const run = this.get(id);
    if (run.state !== "held") throw invalid(`${runRef(id)} is ${run.state}, not held`);
    if (decision === "deny") {
      this.#update(id, {
        state: "denied",
        note: `denied by ${by}`,
        ended_at: iso(this.#ctx.now()),
      });
    } else {
      this.#update(id, { state: "queued", note: `approved by ${by}` });
      this.#pump();
    }
    return this.get(id);
  }

  list(opts: { agentId?: string; viewer?: string; limit: number; state?: string }): RunRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const and = (clause: string, ...values: string[]) => {
      where.push(clause);
      params.push(...values);
    };
    if (opts.agentId) and("agent_id = ?", opts.agentId);
    if (opts.state) and("state = ?", opts.state);
    if (opts.viewer) and("(agent_id = ? OR requester_agent_id = ?)", opts.viewer, opts.viewer);
    return this.#ctx.store.all<RunRow>(
      `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
      ...params,
      opts.limit,
    );
  }

  /** Compact view (GET /v1/runs). */
  view(r: RunRow): Record<string, unknown> {
    const log = join(this.#logDir, `${r.id}.jsonl`);
    return {
      id: runRef(r.id),
      agent: this.#registry.byId(r.agent_id)?.name ?? r.agent_id,
      harness: r.harness,
      kind: r.kind,
      profile: r.profile,
      model: r.model,
      state: r.state,
      requester: r.requester,
      trigger: r.trigger_id,
      thread: r.thread_id,
      cwd: r.cwd,
      sessionId: r.session_id,
      argv: r.argv ? JSON.parse(r.argv) : null,
      pid: r.pid,
      createdAt: r.created_at,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      exitCode: r.exit_code,
      signal: r.signal,
      costUsd: r.cost_usd,
      tokens:
        r.tokens_in == null && r.tokens_out == null ? null : { in: r.tokens_in, out: r.tokens_out },
      denials: r.denials,
      result: r.result_id,
      note: r.note,
      log: existsSync(log) ? log : null,
    };
  }

  /** Held runs in the shape of held messages (GET /v1/approvals; approve R12). */
  approvals(): Record<string, unknown>[] {
    return this.list({ state: "held", limit: 100 }).map((r) => {
      const agent = this.#registry.byId(r.agent_id);
      const trigger = r.trigger_id
        ? this.#ctx.store.get<{ preview: string }>(
            "SELECT preview FROM messages WHERE id = ?",
            r.trigger_id,
          )
        : undefined;
      return {
        delivery: { id: runRef(r.id), to: agent?.name ?? r.agent_id, state: "held" },
        message: {
          id: runRef(r.id),
          kind: `headless ${r.kind}`,
          from: r.requester,
          createdAt: r.created_at,
          thread: r.thread_id,
        },
        text: `${r.kind === "spawn" ? "Spawn" : "Resume"} ${agent?.name ?? "?"} headlessly: ${RUNNERS[r.harness].label(r.kind === "wake")} (${r.profile}) in ${homeShort(r.cwd)}${trigger ? `, for: "${trigger.preview}"` : ""}`,
        run: this.view(r),
      };
    });
  }

  /**
   * Daemon shutdown: interrupt runs (SIGTERM, then SIGKILL); their mail goes back to the queue.
   * Runs still starting never spawn. Resolves when the runs' processes are gone.
   */
  close(): Promise<void> {
    this.#closed = true;
    const stopped = {
      state: "stopped",
      note: "the daemon stopped",
      ended_at: iso(this.#ctx.now()),
    };
    const ended: Promise<void>[] = [];
    for (const [id, live] of this.#live) {
      for (const t of live.timers) clearTimeout(t);
      ended.push(endGroup(live.pid, false));
      this.#mailbox.requeue(JSON.parse(this.get(id).deliveries ?? "[]"));
      this.#update(id, stopped);
    }
    for (const id of this.#starting) if (!this.#live.has(id)) this.#update(id, stopped);
    this.#live.clear();
    return Promise.all(ended).then(() => undefined);
  }
}
