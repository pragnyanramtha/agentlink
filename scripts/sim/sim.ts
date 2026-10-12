// agentlink simulation: N sandbox machines (real daemons), a relay, K fake agents per machine,
// a seeded random workload with chaos (restarts, outages, pause, renames, held mail, team
// leave/join, headless wake/spawn), a ground-truth ledger and invariant checks. Never touches
// ~/.agentlink or real agent CLIs: every daemon runs in a temp sandbox with fake CLIs on PATH.
//
//   node scripts/sim/sim.ts --seed 1 --minutes 2 --machines 2 --agents 3            (canary)
//   node scripts/sim/sim.ts --seed 7 --minutes 25 --machines 4 --agents 8 --rate 300 --chaos 2
//   multi-host: --workers 'local,http://10.0.0.2:47951#token' --placement 0,1 --relay-url ws://ip:port
//
// Writes <out>/report.json and <out>/report.md (violations, latencies, resource curves).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HttpResult, type Json, percentile, rng, sleep } from "./lib.ts";
import { localWorker, remoteWorker, type WorkerApi } from "./worker.ts";

// ------------------------------------------------------------------ options
const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : fallback;
};
const flag = (name: string) => argv.includes(name);
const SEED = Number(opt("--seed", "1"));
const MINUTES = Number(opt("--minutes", "2"));
const N_MACHINES = Number(opt("--machines", "2"));
const K_AGENTS = Number(opt("--agents", "3"));
const RATE = Number(opt("--rate", "40")); // new conversations per minute (all agents)
const CHAOS = Number(opt("--chaos", "1")); // 0 none, 1 some, 2 a lot, 3 brutal
const VERIFY = !flag("--trust"); // kernel caller checks (the real thing) unless --trust
const REAL_HOOKS = Number(opt("--real-hooks", "0.05")); // share of hooks via the real CLI process
const OUT = opt("--out", "") || mkdtempSync(join(tmpdir(), "als-out-"));
const DIR = opt("--dir", "") || mkdtempSync(join(tmpdir(), "als-"));
const RELAY_PORT = Number(opt("--relay-port", "47910"));
const RELAY_URL = opt("--relay-url", "");
const WORKERS = opt("--workers", "local");
const PLACEMENT = opt("--placement", "").split(",").filter(Boolean).map(Number);
const KEEP = flag("--keep");
const QUIESCE_S = Number(opt("--quiesce", "90"));
const PRELOAD = Number(opt("--preload", "0")); // history messages per machine before the workload
const STORM_EVERY = Number(opt("--storm-every", "0")); // seconds between concurrent-hook storms
const SLOW_GIT = Number(opt("--slow-git-ms", "0")); // every git call on the machines takes this long
mkdirSync(OUT, { recursive: true });

const R = rng(SEED);
const T0 = Date.now();
const since0 = () => ((Date.now() - T0) / 1000).toFixed(1);
const log = (...a: unknown[]) => console.log(`[${since0()}s]`, ...a);

// ------------------------------------------------------------------ workers
const workers: WorkerApi[] = WORKERS.split(",").map((spec, i) => {
  if (spec === "local") return localWorker(join(DIR, `w${i}`));
  const [url, token] = spec.split("#") as [string, string];
  return remoteWorker(url, token);
});
const placement = (i: number) => workers[PLACEMENT[i] ?? 0] as WorkerApi;

// ------------------------------------------------------------------ model
type AgentState = "offline" | "idle" | "busy";
interface Machine {
  name: string;
  w: WorkerApi;
  up: boolean;
  paused: boolean;
  pauseWindows: [number, number][];
  downWindows: [number, number][];
  headless: boolean;
  eventsSeq: number;
}
interface Agent {
  key: string;
  m: Machine;
  tool: string;
  project: string;
  cwd: string;
  model: string;
  title: string;
  name: string;
  id?: string;
  session: string;
  state: AgentState;
  restarting: boolean;
  todo: Map<string, number>;
  wake?: () => void;
  aliases: string[];
  sse: boolean;
  starts: number;
  ids: Set<string>;
}
interface LRecipient {
  addr: string;
  key?: string;
  machine: string;
  human?: boolean;
}
interface LMsg {
  id: string;
  kind: string;
  from: string; // agent key or "@mN"
  fromMachine: string;
  to: LRecipient[];
  thread: string;
  replyTo?: string;
  nonce: string;
  sentAt: number;
  sync: { to: string; state: string; note?: string }[];
  wait?: { start: number; end?: number; reply?: string; timedOut?: boolean; replies?: string[] };
  answers: Map<string, { id: string; at: number; kind: string; ack?: string }>;
}

const machines: Machine[] = [];
const agents: Agent[] = [];
const ledger = new Map<string, LMsg>();
const injections = new Map<string, { n: number; vias: string[]; first: number }>();
const injectionLog: { t: number; machine: string; key: string; id: string; via: string }[] = [];
const hookStats: {
  t: number;
  machine: string;
  event: string;
  ms: number;
  ok: boolean;
  err?: string;
  real: boolean;
}[] = [];
const sendErrors = new Map<string, number>();
const apiStats: { t: number; route: string; ms: number; status: number }[] = [];
const errSamples = new Map<string, { n: number; samples: string[] }>();
function noteErr(route: string, status: number, data: unknown, error?: string) {
  if (status === 200) return;
  const msg = String(
    (data as { error?: { message?: string } })?.error?.message ?? error ?? "",
  ).slice(0, 160);
  const k = `${route} ${status}`;
  const e = errSamples.get(k) ?? { n: 0, samples: [] };
  e.n += 1;
  if (e.samples.length < 4 && !e.samples.includes(msg)) e.samples.push(msg);
  errSamples.set(k, e);
}
const violations: { kind: string; detail: string; at: number; data?: unknown }[] = [];
const approvals = new Map<string, { at: number; decision: string }>(); // `${machine}|${deliveryId}`
const hsse = new Map<string, { states: string[]; ts: number[]; id: string; to: string }>();
const sseAgent = new Map<string, Set<string>>(); // agent key → message ids seen via its SSE
const chaosLog: { t: number; what: string }[] = [];
const sessionToKey = new Map<string, string>();
const runsSpawned: string[] = [];
const relayDown: [number, number][] = [];
let stopping = false;
let noNew = false;
let counter = 0;

const violate = (kind: string, detail: string, data?: unknown) => {
  if (violations.filter((v) => v.kind === kind).length < 200) {
    violations.push({ kind, detail, at: Date.now(), ...(data ? { data } : {}) });
  }
  if (violations.filter((v) => v.kind === kind).length <= 3) log(`VIOLATION ${kind}: ${detail}`);
};
const chaos = (what: string) => {
  chaosLog.push({ t: Date.now(), what });
  log(`chaos: ${what}`);
};

// ------------------------------------------------------------------ calls
async function human(m: Machine, method: string, path: string, body?: unknown, tty = false) {
  const t = Date.now();
  const r = await m.w.call<HttpResult>("machineReq", {
    name: m.name,
    method,
    path,
    body,
    tty,
  });
  apiStats.push({ t, route: `human ${method} ${path.split("?")[0]}`, ms: r.ms, status: r.status });
  noteErr(`human ${method} ${path.split("?")[0]}`, r.status, r.data, r.error);
  return r;
}
async function api<T = Json>(
  a: Agent,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 15_000,
): Promise<HttpResult<T>> {
  const t = Date.now();
  const r = await a.m.w.call<HttpResult<T>>("agentCall", {
    key: a.key,
    op: "api",
    args: { method, path, body, timeoutMs },
    timeoutMs: timeoutMs + 10_000,
  });
  const route = `${method} ${path
    .split("?")[0]
    ?.replace(/\/[0-9A-Z]{20,}/g, "/:id")
    .replace(/\/R?\d+$/, "/:n")}`;
  apiStats.push({ t, route, ms: r.ms ?? 0, status: r.status });
  noteErr(route, r.status, r.data, r.error);
  return r;
}
function payload(a: Agent, extra: Json = {}): Json {
  return {
    session_id: a.session,
    cwd: a.cwd,
    model: a.model,
    session_title: a.title,
    ...extra,
  };
}
/** The hooks `agentlink setup` installs per CLI (targets.ts), or the OpenCode plugin calls. */
const INSTALLED: Record<string, string[]> = {
  claude: ["session-start", "prompt-submit", "post-tool", "stop", "notification", "session-end"],
  codex: ["session-start", "prompt-submit", "post-tool", "stop"],
  cursor: ["session-start", "post-tool", "stop", "session-end"],
  copilot: ["session-start", "prompt-submit", "post-tool", "stop", "notification", "session-end"],
  gemini: ["session-start", "prompt-submit", "post-tool", "stop", "session-end"],
  opencode: ["session-start", "prompt-submit", "turn-complete"],
};
async function hook(a: Agent, event0: string, extra: Json = {}, tag = ""): Promise<Json> {
  // OpenCode's plugin reports a finished turn as turn-complete
  const event = a.tool === "opencode" && event0 === "stop" ? "turn-complete" : event0;
  if (!(INSTALLED[a.tool] ?? []).includes(event)) return { skipped: true };
  const real = event !== "session-start" && a.tool !== "opencode" && R.chance(REAL_HOOKS);
  const t = Date.now();
  const r = await a.m.w.call<Json>("agentCall", {
    key: a.key,
    op: "hook",
    args: { event, payload: payload(a, extra), real },
  });
  const ms = Number(r.ms ?? 0);
  const ok = real ? r.code === 0 && !String(r.stderr ?? "") : r.status === 200;
  hookStats.push({
    t,
    machine: a.m.name,
    event: `${tag}${event}`,
    ms,
    ok,
    real,
    ...(ok ? {} : { err: String(r.error ?? r.stderr ?? r.status) }),
  });
  if (!real) noteErr(`hook ${event}`, Number(r.status), r.data, r.error as string | undefined);
  return r;
}

// ------------------------------------------------------------------ identities
const TOOLS = ["claude", "codex", "opencode", "gemini", "claude", "codex", "copilot", "cursor"];
const MODELS: Record<string, string[]> = {
  claude: ["claude-opus-4-5-20251101", "claude-sonnet-4-5-20250929"],
  codex: ["gpt-5.1-codex", "gpt-5.1-codex-max"],
  opencode: ["anthropic/claude-sonnet-4-5", "openai/gpt-5-mini"],
  gemini: ["gemini-2.5-pro"],
  copilot: ["gpt-5"],
  cursor: ["gpt-5", "claude-4.5-sonnet"],
};
const PROJECTS = ["api", "web", "docs", "infra", "mobile", "billing", "search", "data", "qa"];
const TITLES = [
  "fix login token refresh",
  "checkout page redesign",
  "API reference for v2",
  "terraform drift in staging",
  "push notification retries",
  "invoice PDF export",
  "ranking eval harness",
  "nightly ETL backfill",
  "flaky e2e triage",
];
const uuid = () =>
  `${R.int(0x10000000, 0xffffffff).toString(16)}-${R.int(0x1000, 0xffff).toString(16)}-4${R.int(0x100, 0xfff).toString(16)}-a${R.int(0x100, 0xfff).toString(16)}-${R.int(0x10000000, 0xffffffff).toString(16)}${R.int(0x1000, 0xffff).toString(16)}`;

// ------------------------------------------------------------------ events
function knownMsg(id: string): LMsg | undefined {
  return ledger.get(id);
}
function recordInject(a: Agent, id: string, via: string, t: number) {
  const k = `${a.key}|${id}`;
  const e = injections.get(k) ?? { n: 0, vias: [], first: t };
  e.n += 1;
  e.vias.push(via);
  injections.set(k, e);
  injectionLog.push({ t, machine: a.m.name, key: a.key, id, via });
  const m = knownMsg(id);
  if (m && ["ask", "request", "handoff", "review_request"].includes(m.kind)) {
    if (m.to.some((r) => r.key === a.key) && !m.answers.has(a.key)) a.todo.set(id, t);
  }
}
const seqByWorker = new Map<WorkerApi, number>();
async function eventLoop() {
  for (;;) {
    const last = stopping;
    for (const w of workers) {
      let res: { events: Json[]; seq: number };
      try {
        res = await w.call("events", { since: seqByWorker.get(w) ?? 0 });
      } catch {
        continue;
      }
      seqByWorker.set(w, res.seq);
      for (const e of res.events) handleEvent(e);
    }
    if (last) break;
    await sleep(250);
  }
}
function agentByKey(key: string) {
  return agents.find((a) => a.key === key);
}
function handleEvent(e: Json) {
  const t = Number(e.t);
  switch (e.type) {
    case "inject": {
      const ids = (e.ids as string[]) ?? [];
      let a: Agent | undefined;
      if (e.via === "codex-queue") a = agentByKey(sessionToKey.get(String(e.session)) ?? "");
      else if (e.via === "headless") {
        runsSpawned.push(String(e.run));
        return; // resolved from the runs table at the end
      } else a = agentByKey(String(e.agent));
      if (!a) return;
      for (const id of ids) recordInject(a, id, String(e.via), t);
      if (ids.length && a.state === "idle" && String(e.via) !== "hook:post-tool") a.wake?.();
      return;
    }
    case "hsse": {
      const k = `${e.machine}|${e.did}`;
      const h = hsse.get(k) ?? { states: [], ts: [], id: String(e.id), to: String(e.to) };
      h.states.push(String(e.state));
      h.ts.push(t);
      hsse.set(k, h);
      return;
    }
    case "sse": {
      if (e.kind === "message" && e.id) {
        const s = sseAgent.get(String(e.agent)) ?? new Set();
        s.add(String(e.id));
        sseAgent.set(String(e.agent), s);
      }
      return;
    }
    case "daemon-exit":
      if (!String(e.signal ?? "") && Number(e.code) !== 0)
        violate("daemon-crash", `${e.machine} exited with ${e.code}`, e);
      return;
    case "relay-exit":
      return;
    default:
      return;
  }
}

// ------------------------------------------------------------------ setup
async function setup() {
  log(`sandbox ${DIR} · out ${OUT} · seed ${SEED} · verify ${VERIFY}`);
  const relayWorker = workers[0] as WorkerApi;
  const createToken = `simtok${R.word()}${R.int(1000, 9999)}`;
  const relay = await relayWorker.call<Json>("relayStart", {
    host: RELAY_URL ? "0.0.0.0" : "127.0.0.1",
    port: RELAY_PORT,
    createToken,
  });
  const relayUrl = RELAY_URL || String(relay.url);
  log(`relay ${relayUrl}`);
  for (let i = 0; i < N_MACHINES; i++) {
    const m: Machine = {
      name: `m${i}`,
      w: placement(i),
      up: false,
      paused: false,
      pauseWindows: [],
      downWindows: [],
      headless: i === N_MACHINES - 1,
      eventsSeq: 0,
    };
    const r = await m.w.call<Json>("machineStart", {
      name: m.name,
      verify: VERIFY,
      sweepMs: 1000,
      ...(SLOW_GIT ? { slowGitMs: SLOW_GIT } : {}),
    });
    if (r.error) throw new Error(`${m.name}: ${r.error}`);
    m.up = true;
    machines.push(m);
  }
  const m0 = machines[0] as Machine;
  const created = await human(m0, "POST", "/v1/team/create", {
    name: "simteam",
    relay: relayUrl,
    createToken,
  });
  if (created.status !== 200) throw new Error(`team create: ${JSON.stringify(created.data)}`);
  for (const m of machines.slice(1)) {
    const inv = await human(m0, "POST", "/v1/team/invite", { uses: 1, code: false });
    const joined = await human(m, "POST", "/v1/team/join", { invite: inv.data.invite });
    if (joined.status !== 200) throw new Error(`join ${m.name}: ${JSON.stringify(joined.data)}`);
  }
  for (const m of machines) await m.w.call("humanSse", { name: m.name });

  // policy: teammates' requests wait for approval on m1; m0's handoffs are refused on the last.
  if (machines.length > 1) {
    const m1 = machines[1] as Machine;
    const r1 = await human(
      m1,
      "POST",
      "/v1/policy",
      { scope: "teammate", kind: "request", action: "hold" },
      true,
    );
    if (r1.status !== 200) log("policy hold failed", r1);
  }
  if (machines.length > 2) {
    const last = machines[machines.length - 1] as Machine;
    await human(
      last,
      "POST",
      "/v1/policy",
      { scope: "m0", kind: "handoff", action: "refuse" },
      true,
    );
  }
  // local holds too: local review requests are held on m0
  await human(
    m0,
    "POST",
    "/v1/policy",
    { scope: "local", kind: "review_request", action: "hold" },
    true,
  );

  // agents
  for (const m of machines) {
    const used = new Set<string>();
    for (let k = 0; k < K_AGENTS; k++) {
      const tool = TOOLS[k % TOOLS.length] as string;
      let project = R.pick(PROJECTS);
      // a second session of the same tool in a project gets a branch/model/number suffix
      if (used.has(`${tool}-${project}`) && R.chance(0.5)) project = R.pick(PROJECTS);
      used.add(`${tool}-${project}`);
      const branch = R.chance(0.3) ? `feat-${R.word()}` : "main";
      const proj = await m.w.call<{ cwd: string }>("project", {
        name: m.name,
        project,
        branch,
      });
      const a: Agent = {
        key: `${m.name}.a${k}`,
        m,
        tool,
        project,
        cwd: proj.cwd,
        model: R.pick(MODELS[tool] ?? ["model-x"]),
        title: R.pick(TITLES),
        name: "",
        session: tool === "opencode" ? `ses_${R.word()}${R.int(1000, 9999)}` : uuid(),
        state: "offline",
        restarting: false,
        todo: new Map(),
        aliases: [],
        sse: k === 0,
        starts: 0,
        ids: new Set(),
      };
      sessionToKey.set(a.session, a.key);
      agents.push(a);
      await startAgent(a);
    }
  }
  // presence: every machine lists every other machine's agents
  const deadline = Date.now() + 20_000;
  for (const m of machines) {
    while (Date.now() < deadline) {
      const r = await human(m, "GET", "/v1/agents");
      const remote = ((r.data.agents as Json[]) ?? []).filter((x) => !x.local).length;
      if (remote >= agents.length - agents.filter((a) => a.m === m).length) break;
      await sleep(300);
    }
  }
  // headless on the last machine (a person enables it at a terminal)
  const hm = machines[machines.length - 1] as Machine;
  const root = await hm.w.call<{ cwd: string }>("project", { name: hm.name, project: "spawned" });
  const roots = root.cwd.replace(/\/spawned$/, "");
  for (const body of [
    { enabled: true },
    { runner: { harness: "codex", enabled: true } },
    { runner: { harness: "claude", enabled: true } },
    { runner: { harness: "opencode", enabled: true } },
    { addRoot: roots },
    {
      set: {
        perAgentPerHour: 100,
        globalPerHour: 200,
        spawnPerHour: 50,
        perThreadRuns: 10,
        timeoutSec: 60,
      },
    },
  ]) {
    const r = await human(hm, "POST", "/v1/headless", body, true);
    if (r.status !== 200) violate("harness", `headless setup failed: ${JSON.stringify(r.data)}`);
  }
  for (const m of machines) {
    const who = await human(m, "GET", "/v1/whoami");
    if ((who.data as Json).agent)
      violate(
        "harness",
        `${m.name}: the orchestrator resolves to agent ${JSON.stringify((who.data as Json).agent).slice(0, 200)}`,
      );
  }
  log(`setup done: ${machines.length} machines, ${agents.length} agents`);
}

async function startAgent(a: Agent, resume = false) {
  a.restarting = true;
  await a.m.w.call<Json>("agentStart", {
    key: a.key,
    machine: a.m.name,
    tool: a.tool,
    cwd: a.cwd,
  });
  a.starts += 1;
  if (a.tool === "claude") {
    await a.m.w.call("agentCall", {
      key: a.key,
      op: "claudeInbox",
      args: { path: join(a.cwd, "..", "..", "..", "sock", `${a.key}.sock`) },
    });
  }
  const res = await hook(a, "session-start", { source: resume ? "resume" : "startup" });
  const id = (res.data as { env?: { AGENTLINK_AGENT?: string } } | undefined)?.env?.AGENTLINK_AGENT;
  if (id) {
    if (a.id && a.id !== id) {
      violate(
        "resume-new-identity",
        `${a.key} resumed session ${a.session} (new pid) but became agent ${id}, was ${a.id}`,
      );
    }
    a.id = id;
    a.ids.add(id);
  }
  const who = await api<{ agent?: { name: string; id: string } | null }>(a, "GET", "/v1/whoami");
  if (who.data.agent) {
    if (a.name && who.data.agent.name !== a.name) a.aliases.push(a.name);
    a.name = who.data.agent.name;
    a.id ??= who.data.agent.id;
  } else {
    log(`warn: ${a.key} is not recognised after start`, who.status, who.data);
  }
  if (a.tool === "opencode") {
    await a.m.w.call("agentCall", { key: a.key, op: "opencode", args: { agentId: a.id } });
  }
  if (a.sse) await a.m.w.call("agentCall", { key: a.key, op: "sse" });
  a.state = "idle";
  a.restarting = false;
}

// ------------------------------------------------------------------ messaging
const nonce = () => `n${R.word()}${(++counter).toString(36)}`;
function addrFor(from: Agent | Machine, to: Agent): string {
  const fm = "key" in from ? from.m : from;
  return fm === to.m ? to.name : `${to.m.name}/${to.name}`;
}
const TEXT: Record<string, string[]> = {
  ask: [
    "which env var holds the refresh token ttl",
    "is the orders endpoint paginated by cursor",
    "what is the p95 after the cache change",
  ],
  request: [
    "please run the index migration on staging",
    "please regenerate the api client from the v2 spec",
  ],
  handoff: ["handing off the invoice rounding bug", "passing the flaky login e2e to you"],
  info: ["fyi main is frozen for the release", "heads up staging db restarts at 14 30"],
  review_request: ["please review the retry policy change", "review the rate limiter middleware"],
};

let tokens = 0;
let lastRefill = Date.now();
function takeToken(): boolean {
  const now = Date.now();
  tokens = Math.min(RATE / 6, tokens + ((now - lastRefill) / 60_000) * RATE);
  lastRefill = now;
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

async function send(
  a: Agent,
  kind: string,
  to: Agent[],
  opts: { wait?: number; human?: Machine } = {},
): Promise<string | undefined> {
  const n = nonce();
  const text = `${R.pick(TEXT[kind] ?? ["hello"])} ${n}`;
  const recipients: LRecipient[] = opts.human
    ? [{ addr: `@${opts.human.name}`, machine: opts.human.name, human: true }]
    : to.map((b) => ({ addr: addrFor(a, b), key: b.key, machine: b.m.name }));
  const body: Json = {
    to: recipients.map((r) => (r.human && r.machine === a.m.name ? `@${r.machine}` : r.addr)),
    kind,
    text,
    ...(opts.wait ? { waitMs: opts.wait } : {}),
  };
  const start = Date.now();
  const res = await api<{
    message?: { id: string; thread: string };
    deliveries?: { to: string; state: string; note?: string }[];
    reply?: { message: { id: string } };
    replies?: { message: { id: string } }[];
    timedOut?: boolean;
    error?: { code: string };
  }>(a, "POST", "/v1/messages", body, (opts.wait ?? 0) + 15_000);
  if (res.status !== 200 || !res.data.message) {
    const code = res.data.error?.code ?? res.error ?? String(res.status);
    sendErrors.set(`${kind}:${code}`, (sendErrors.get(`${kind}:${code}`) ?? 0) + 1);
    return undefined;
  }
  const id = res.data.message.id;
  const m: LMsg = {
    id,
    kind,
    from: a.key,
    fromMachine: a.m.name,
    to: recipients,
    thread: res.data.message.thread,
    nonce: n,
    sentAt: start,
    sync: (res.data.deliveries ?? []).map((d) => ({
      to: d.to,
      state: d.state,
      ...(d.note ? { note: d.note } : {}),
    })),
    answers: new Map(),
  };
  if (opts.wait) {
    m.wait = {
      start,
      end: Date.now(),
      timedOut: !!res.data.timedOut,
      ...(res.data.reply ? { reply: res.data.reply.message.id } : {}),
      replies: (res.data.replies ?? (res.data.reply ? [res.data.reply] : [])).map(
        (r) => r.message.id,
      ),
    };
  }
  ledger.set(id, m);
  // the reply reached the asker through its wait: it has seen it
  for (const rid of m.wait?.replies ?? []) recordInject(a, rid, "longpoll", Date.now());
  return id;
}

async function answer(b: Agent, id: string) {
  const m = ledger.get(id);
  b.todo.delete(id);
  if (!m || m.answers.has(b.key)) return;
  const group = m.to.length > 1;
  const fromAgent = agentByKey(m.from);
  let res: HttpResult<{ message?: { id: string }; error?: { code: string } }>;
  let kind = "reply";
  let ack: string | undefined;
  if (m.kind === "handoff") {
    kind = "ack";
    ack = R.chance(0.75) ? "accept" : "decline";
    res = await api(b, "POST", `/v1/messages/${id}/ack`, { ack, note: `${ack} ${nonce()}` });
  } else {
    kind = m.kind === "review_request" ? "review_result" : "reply";
    const all = group && R.chance(0.4);
    res = await api(b, "POST", "/v1/messages", {
      kind,
      replyTo: id,
      text: `answer ${nonce()} to ${m.nonce}`,
      ...(all ? { replyAll: true } : {}),
    });
  }
  if (res.status === 200 && res.data.message) {
    m.answers.set(b.key, {
      id: res.data.message.id,
      at: Date.now(),
      kind,
      ...(ack ? { ack } : {}),
    });
    // answers are messages too (no further answers expected)
    ledger.set(res.data.message.id, {
      id: res.data.message.id,
      kind,
      from: b.key,
      fromMachine: b.m.name,
      to: fromAgent
        ? [{ addr: addrFor(b, fromAgent), key: fromAgent.key, machine: fromAgent.m.name }]
        : [],
      thread: m.thread,
      replyTo: id,
      nonce: "",
      sentAt: Date.now(),
      sync: [],
      answers: new Map(),
    });
  } else {
    const code = res.data.error?.code ?? res.error ?? String(res.status);
    sendErrors.set(`${kind}:${code}`, (sendErrors.get(`${kind}:${code}`) ?? 0) + 1);
  }
}

function others(a: Agent, n: number, remoteOk = true): Agent[] {
  const pool = agents.filter((b) => b !== a && b.name && (remoteOk || b.m === a.m));
  return R.shuffle(pool).slice(0, n);
}

async function startConversation(a: Agent) {
  const r = R.next();
  const remote = machines.length > 1 && R.chance(0.45);
  if (r < 0.3) {
    const [b] = others(a, 1, remote);
    if (b) await send(a, "ask", [b], R.chance(0.3) ? { wait: R.int(3_000, 25_000) } : {});
  } else if (r < 0.42) {
    const [b] = others(a, 1, remote);
    if (b) await send(a, "request", [b]);
  } else if (r < 0.54) {
    // group handoff: competing accepts
    const bs = others(a, R.chance(0.5) ? 2 : 1, remote);
    if (bs.length) await send(a, "handoff", bs);
  } else if (r < 0.68) {
    await send(a, "info", others(a, R.int(2, 4), remote));
  } else if (r < 0.78) {
    const [b] = others(a, 1, remote);
    if (b) await send(a, "review_request", [b]);
  } else if (r < 0.9) {
    await send(a, "ask", others(a, R.int(2, 3), remote), R.chance(0.2) ? { wait: 8_000 } : {});
  } else if (r < 0.95) {
    await send(a, "ask", [], { human: R.chance(0.5) ? a.m : R.pick(machines) });
  } else {
    await query(a);
  }
}

/** Reads that must never show an agent someone else's conversation. */
async function query(a: Agent) {
  const sample = [...ledger.values()].filter((m) => m.nonce && Date.now() - m.sentAt > 3_000);
  const m = sample.length ? R.pick(sample) : undefined;
  const r = R.next();
  if (m && r < 0.4) {
    const res = await api<{ results?: { id: string }[]; paused?: boolean }>(
      a,
      "GET",
      `/v1/search?q=${m.nonce}&limit=20`,
    );
    for (const hit of res.data.results ?? []) await checkVisible(a, hit.id, "search");
    // While the machine is paused, reads answer empty on purpose.
    if (
      m.from === a.key &&
      res.status === 200 &&
      !res.data.paused &&
      !(res.data.results ?? []).some((h) => h.id === m.id)
    )
      violate("search-miss", `${a.key} cannot find its own message ${m.id} by ${m.nonce}`);
  } else if (m && r < 0.6) {
    const res = await api<{ message?: { id: string } }>(a, "GET", `/v1/messages/${m.id}?peek=1`);
    if (res.status === 200) await checkVisible(a, m.id, "show");
  } else if (m && r < 0.75) {
    const res = await api<{ messages?: { message: { id: string } }[] }>(
      a,
      "GET",
      `/v1/threads/${m.thread}`,
    );
    for (const x of res.data.messages ?? []) await checkVisible(a, x.message.id, "thread");
  } else if (r < 0.9) {
    const res = await api<{ messages?: { message: { id: string } }[] }>(
      a,
      "GET",
      "/v1/log?limit=50",
    );
    for (const x of res.data.messages ?? []) await checkVisible(a, x.message.id, "log");
  } else {
    await api(a, "GET", "/v1/threads?limit=20&open=1");
    await api(a, "GET", "/v1/todo");
  }
}

/** Ground truth (database): the agent sent it or it was delivered to it (not held/refused). */
async function checkVisible(a: Agent, id: string, via: string) {
  if (!a.id) return;
  const rows = await a.m.w.call<Json[]>("query", {
    name: a.m.name,
    sql: `SELECT (SELECT from_agent_id FROM messages WHERE id = ?) AS f,
            (SELECT COUNT(*) FROM deliveries WHERE message_id = ? AND to_agent_id IN (${[...a.ids].map(() => "?").join(",")}) AND state NOT IN ('held','refused')) AS n`,
    params: [id, id, ...a.ids],
  });
  const row = rows[0] ?? {};
  if (!a.ids.has(String(row.f)) && Number(row.n) === 0)
    violate("leak", `${a.key} (${a.name}) sees ${id} via ${via} but is not a participant`, row);
}

// ------------------------------------------------------------------ agent behaviour
async function turn(a: Agent) {
  a.state = "busy";
  await hook(a, "prompt-submit");
  const steps = R.int(1, 4);
  for (let s = 0; s < steps && a.state === "busy" && !a.restarting; s++) {
    await hook(a, "pre-tool", { tool_name: "Bash" });
    await sleep(R.int(80, 700));
    await act(a);
    await hook(a, "post-tool", { tool_name: "Bash" });
  }
  for (let i = 0; i < 3 && !a.restarting; i++) {
    const r = await hook(a, "stop");
    const out = String((r.data as Json | undefined)?.stdout ?? r.stdout ?? "");
    if (!out.includes('"decision"') && !out.includes("followup_message")) break;
    await act(a);
  }
  if (a.state === "busy") a.state = "idle";
}

async function act(a: Agent) {
  if (a.restarting || a.state === "offline") return;
  for (const [id] of [...a.todo]) {
    if (R.chance(stopping || noNew ? 1 : 0.6)) await answer(a, id);
  }
  if (!noNew && takeToken()) await startConversation(a);
  else if (!noNew && R.chance(0.08)) await query(a);
  if (R.chance(0.03)) {
    a.title = R.pick(TITLES);
    await api(a, "POST", "/v1/agents/status", { text: `working on ${a.title}` });
  }
  if (R.chance(0.1)) {
    // a CLI-style inbox read (agentlink inbox)
    const res = await api<{ items?: { message: { id: string } }[] }>(a, "GET", "/v1/inbox");
    for (const it of res.data.items ?? []) recordInject(a, it.message.id, "inbox", Date.now());
  }
}

async function agentLoop(a: Agent) {
  while (!stopping) {
    if (a.state === "offline" || a.restarting || !a.m.up) {
      await sleep(300);
      continue;
    }
    await new Promise<void>((res) => {
      const t = setTimeout(res, R.int(800, noNew ? 2_000 : 9_000));
      a.wake = () => {
        clearTimeout(t);
        res();
      };
    });
    a.wake = undefined;
    if (stopping || (a.state as AgentState) === "offline" || a.restarting) continue;
    try {
      await turn(a);
    } catch (error) {
      log(`turn ${a.key} failed`, String(error));
      if (a.state === "busy") a.state = "idle";
    }
  }
}

// ------------------------------------------------------------------ chaos
async function takeOffline(a: Agent) {
  if (a.state === "offline" || a.restarting) return;
  a.restarting = true;
  if (R.chance(0.5)) await hook(a, "session-end");
  await a.m.w.call("agentKill", { key: a.key });
  a.state = "offline";
  a.restarting = false;
  chaos(`${a.key} (${a.name}) offline`);
}
async function resume(a: Agent) {
  if (a.state !== "offline" || a.restarting || !a.m.up) return;
  chaos(`${a.key} (${a.name}) resumes session ${a.session.slice(0, 8)} with a new pid`);
  await startAgent(a, true);
}
async function restartDaemon(m: Machine, kill: boolean) {
  chaos(`${m.name} daemon ${kill ? "SIGKILL" : "restart"}`);
  m.up = false;
  const t = Date.now();
  await m.w.call("machineStop", { name: m.name, signal: kill ? "SIGKILL" : "SIGTERM" });
  await sleep(R.int(300, 2_500));
  const r = await m.w.call<Json>("machineStart", { name: m.name, verify: VERIFY });
  if (r.error) violate("daemon-restart-failed", `${m.name}: ${r.error}`);
  m.downWindows.push([t, Date.now()]);
  m.up = true;
  await m.w.call("humanSse", { name: m.name });
  for (const a of agents.filter((x) => x.m === m && x.sse && x.state !== "offline"))
    await m.w.call("agentCall", { key: a.key, op: "sse" });
}
async function relayOutage() {
  const w = workers[0] as WorkerApi;
  const kill = R.chance(0.4);
  chaos(`relay ${kill ? "SIGKILL" : "stop"}`);
  const t = Date.now();
  await w.call("relayStop", { signal: kill ? "SIGKILL" : "SIGTERM" });
  await sleep(R.int(4_000, 20_000));
  await w.call("relayRestart");
  relayDown.push([t, Date.now()]);
  chaos("relay back");
}
async function pauseFor(m: Machine) {
  chaos(`${m.name} paused`);
  const r = await human(m, "POST", "/v1/control", { action: "pause" });
  if (r.status !== 200) return;
  m.paused = true;
  const t = Date.now();
  await sleep(R.int(3_000, 10_000));
  const res = await human(m, "POST", "/v1/control", { action: "resume" }, true);
  if (res.status !== 200)
    violate("harness", `${m.name}: resume failed ${res.status} ${JSON.stringify(res.data)}`);
  m.pauseWindows.push([t, Date.now()]);
  if (res.status === 200) m.paused = false;
  chaos(`${m.name} resumed`);
}
async function renameOne() {
  const a = R.pick(agents.filter((x) => x.state !== "offline" && !x.restarting && x.name));
  if (!a) return;
  const next = `${a.tool}-${R.word()}`;
  const r = await api<{ agent?: { name: string } }>(a, "POST", "/v1/agents/rename", { name: next });
  if (r.status === 200 && r.data.agent) {
    chaos(`${a.key} renamed ${a.name} → ${r.data.agent.name}`);
    a.aliases.push(a.name);
    a.name = r.data.agent.name;
  }
}
async function teamChurn() {
  if (machines.length < 3) return;
  const m = machines[machines.length - 2] as Machine;
  chaos(`${m.name} leaves the team`);
  await human(m, "POST", "/v1/team/leave", {});
  await sleep(R.int(3_000, 8_000));
  const inv = await human(machines[0] as Machine, "POST", "/v1/team/invite", {
    uses: 1,
    code: false,
  });
  const j = await human(m, "POST", "/v1/team/join", { invite: inv.data.invite });
  chaos(
    `${m.name} rejoins: ${j.status} ${j.status === 200 ? "" : JSON.stringify(j.data).slice(0, 200)}`,
  );
  if (j.status !== 200)
    violate("rejoin-failed", `${m.name}: ${JSON.stringify(j.data).slice(0, 300)}`);
}
async function headlessWork() {
  const hm = machines[machines.length - 1] as Machine;
  const offline = agents.filter(
    (a) => a.m === hm && a.state === "offline" && ["codex", "claude", "opencode"].includes(a.tool),
  );
  const asker = R.pick(agents.filter((a) => a.m === hm && a.state !== "offline" && !a.restarting));
  if (!asker) return;
  if (offline.length && R.chance(0.6)) {
    const target = R.pick(offline);
    chaos(`headless: ${asker.key} asks offline ${target.name} (wake)`);
    await send(asker, "ask", [target], R.chance(0.5) ? { wait: 15_000 } : {});
  } else {
    chaos(`headless: ${asker.key} spawns codex`);
    const r = await api<{ run?: { id: string }; agent?: { name: string } }>(
      asker,
      "POST",
      "/v1/spawn",
      {
        harness: R.pick(["codex", "claude", "opencode"]),
        task: `sim task ${nonce()}`,
        cwd: asker.cwd,
      },
    );
    if (r.status !== 200)
      sendErrors.set(`spawn:${r.status}`, (sendErrors.get(`spawn:${r.status}`) ?? 0) + 1);
  }
}
async function approvalsLoop() {
  while (!stopping) {
    await sleep(R.int(2_000, 5_000));
    for (const m of machines) {
      if (!m.up) continue;
      const r = await human(m, "GET", "/v1/approvals");
      for (const it of (r.data.items as Json[]) ?? []) {
        const d = it.delivery as Json;
        const id = String(d.id);
        const decision = noNew || R.chance(0.8) ? "approve" : "deny";
        const at = Date.now();
        const res = await human(
          m,
          "POST",
          `/v1/approvals/${id.replace(/^R/, "R")}`,
          { decision },
          true,
        );
        if (res.status === 200) approvals.set(`${m.name}|${id}`, { at, decision });
      }
    }
  }
}
async function chaosLoop() {
  if (CHAOS <= 0) return;
  let churned = false;
  const every = [0, 15_000, 7_000, 3_000][Math.min(CHAOS, 3)] as number;
  while (!stopping && !noNew) {
    await sleep(R.int(every / 2, every * 1.5));
    if (stopping || noNew) break;
    const r = R.next();
    try {
      if (r < 0.3) {
        const a = R.pick(agents.filter((x) => x.state !== "offline" && !x.restarting));
        if (a) {
          await takeOffline(a);
          setTimeout(() => void resume(a), R.int(4_000, 30_000));
        }
      } else if (r < 0.4) {
        await restartDaemon(R.pick(machines), R.chance(0.3));
      } else if (r < 0.48 && machines.length > 1) {
        await relayOutage();
      } else if (r < 0.58) {
        await pauseFor(R.pick(machines));
      } else if (r < 0.66) {
        await renameOne();
      } else if (r < 0.8) {
        await headlessWork();
      } else if (r < 0.85) {
        await human(
          R.pick(machines),
          "POST",
          "/v1/prune",
          { olderThanMs: 3_600_000, dryRun: R.chance(0.5) },
          true,
        );
      } else if (r < 0.88 && !churned && Date.now() - T0 > (MINUTES * 60_000) / 2) {
        churned = true;
        await teamChurn();
      } else {
        // presence churn: a title change through the hook payload
        const a = R.pick(agents.filter((x) => x.state !== "offline" && !x.restarting));
        if (a) {
          a.title = `${R.pick(TITLES)} ${R.word()}`;
          await hook(a, "prompt-submit");
        }
      }
    } catch (error) {
      log("chaos step failed", String(error));
    }
  }
}

/** Every running agent of a machine fires hooks at once (several sessions finishing tool calls). */
async function hookStorm(m: Machine) {
  const live = agents.filter((a) => a.m === m && a.state !== "offline" && !a.restarting);
  chaos(`${m.name}: hook storm (${live.length} agents × 4 hooks)`);
  await Promise.all(
    live.flatMap((a) => [
      hook(a, "post-tool", { tool_name: "Read" }, "storm:"),
      hook(a, "pre-tool", { tool_name: "Read" }, "storm:"),
      hook(a, "post-tool", { tool_name: "Edit" }, "storm:"),
      hook(a, "prompt-submit", {}, "storm:"),
    ]),
  );
}
async function stormLoop() {
  if (!STORM_EVERY) return;
  while (!stopping && !noNew) {
    await sleep(STORM_EVERY * 1000);
    if (stopping || noNew) break;
    const m = R.pick(machines.filter((x) => x.up));
    if (m) await hookStorm(m).catch((e) => log("storm failed", String(e)));
  }
}

/** History before the workload (a big database): a person's FYIs, read by their recipients. */
async function preload() {
  if (!PRELOAD) return;
  log(`preload: ${PRELOAD} messages per machine`);
  await Promise.all(
    machines.map(async (m) => {
      const mine = agents.filter((a) => a.m === m && a.name);
      for (let i = 0; i < PRELOAD; i += 8) {
        await Promise.all(
          Array.from({ length: Math.min(8, PRELOAD - i) }, (_, j) => {
            const a = mine[(i + j) % mine.length] as Agent;
            return human(m, "POST", "/v1/messages", {
              to: [a.name],
              kind: "info",
              text: `history ${R.word()} ${R.word()} ${R.word()} build ${i + j} of the ${R.pick(PROJECTS)} pipeline finished`,
            });
          }),
        );
        if (i % 200 === 0) {
          for (const a of mine) {
            const res = await api<{ items?: { message: { id: string } }[] }>(
              a,
              "GET",
              "/v1/inbox?limit=200",
            );
            for (const it of res.data.items ?? [])
              recordInject(a, it.message.id, "inbox", Date.now());
          }
        }
      }
      for (const a of mine) {
        for (let k = 0; k < 3; k++) {
          const res = await api<{ items?: { message: { id: string } }[] }>(
            a,
            "GET",
            "/v1/inbox?limit=200",
          );
          for (const it of res.data.items ?? [])
            recordInject(a, it.message.id, "inbox", Date.now());
        }
      }
    }),
  );
  log("preload done");
}

// ------------------------------------------------------------------ quiesce + checks
async function quiesce() {
  noNew = true;
  log("quiesce: no new conversations; healing everything");
  await sleep(3_000);
  const w0 = workers[0] as WorkerApi;
  await w0.call("relayRestart").catch(() => undefined);
  for (const m of machines) {
    if (!m.up) {
      await m.w.call("machineStart", { name: m.name, verify: VERIFY });
      m.up = true;
    }
    const res = await human(m, "POST", "/v1/control", { action: "resume" }, true);
    if (res.status !== 200)
      violate("harness", `${m.name}: resume failed ${res.status} ${JSON.stringify(res.data)}`);
    m.paused = false;
  }
  for (const a of agents) if (a.state === "offline" && !a.restarting) await resume(a);
  const deadline = Date.now() + QUIESCE_S * 1000;
  let quietRounds = 0;
  while (Date.now() < deadline) {
    await sleep(3_000);
    let pending = 0;
    for (const m of machines) {
      const rows = await m.w.call<Json[]>("query", {
        name: m.name,
        sql: `SELECT COUNT(*) AS n FROM deliveries d JOIN agents a ON a.id = d.to_agent_id
              WHERE d.state IN ('queued','delivered','held') AND a.state IN ('busy','idle')`,
      });
      pending += Number(rows[0]?.n ?? 0);
      const out = await m.w.call<Json[]>("query", {
        name: m.name,
        sql: "SELECT COUNT(*) AS n FROM outbox",
      });
      pending += Number(out[0]?.n ?? 0);
    }
    const todo = agents.reduce((s, a) => s + a.todo.size, 0);
    log(`quiesce: ${pending} pending deliveries/outbox, ${todo} unanswered todos`);
    if (pending === 0 && todo === 0) {
      if (++quietRounds >= 2) break;
    } else quietRounds = 0;
    for (const a of agents) if (a.state === "idle") a.wake?.();
  }
  await sleep(4_000); // receipts in flight
  stopping = true;
  await sleep(1_500);
}

const RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  held: 2,
  delivered: 3,
  seen: 4,
  acked: 5,
  replied: 6,
  refused: 6,
  expired: 6,
  failed: 6,
};
async function checks() {
  log("checks");
  const db = async (m: Machine, sql: string, params: (string | number | null)[] = []) =>
    m.w.call<Json[]>("query", { name: m.name, sql, params });
  const byName = (name: string) => machines.find((m) => m.name === name) as Machine;

  // 1. deliveries: every one ended somewhere sensible
  const deliveriesBy = new Map<string, Json[]>();
  for (const m of machines) {
    const rows = await db(
      m,
      `SELECT d.*, m.kind AS kind, m.from_agent_id AS from_agent_id, m.from_addr AS from_addr, m.trust AS trust
       FROM deliveries d JOIN messages m ON m.id = d.message_id`,
    );
    deliveriesBy.set(m.name, rows);
  }
  const agentIdToKey = new Map<string, Agent>();
  for (const a of agents) for (const id of a.ids) agentIdToKey.set(`${a.m.name}|${id}`, a);

  const finalStates: Record<string, number> = {};
  let stuck = 0;
  let seenNoInject = 0;
  const seenNoInjectByTool: Record<string, number> = {};
  for (const m of machines) {
    const live = new Set(
      (await db(m, "SELECT id FROM agents WHERE state IN ('busy','idle')")).map((r) =>
        String(r.id),
      ),
    );
    for (const d of deliveriesBy.get(m.name) ?? []) {
      finalStates[String(d.state)] = (finalStates[String(d.state)] ?? 0) + 1;
      const state = String(d.state);
      const isSystem = d.from_addr === "agentlink";
      if (
        ["queued", "delivered", "held"].includes(state) &&
        d.to_agent_id &&
        live.has(String(d.to_agent_id))
      ) {
        stuck++;
        violate(
          "stuck-delivery",
          `${m.name} delivery #${d.id} of ${d.message_id} (${d.kind}) to ${d.to_addr} is still ${state} after quiesce`,
          d,
        );
      }
      if (state === "sent" || (state === "queued" && d.method === "relay")) {
        // our copy to a teammate: must match what their machine says
        const [handle] = String(d.to_addr).replace(/^@/, "").split("/");
        const peer = machines.find((x) => x.name === handle);
        const theirs = peer
          ? (deliveriesBy.get(peer.name) ?? []).filter((x) => x.message_id === d.message_id)
          : [];
        violate(
          "remote-not-settled",
          `${m.name} → ${d.to_addr}: ${d.message_id} (${d.kind}) still ${state} here; on ${handle}: ${theirs.map((x) => x.state).join(",") || "missing"}`,
          { here: d, there: theirs },
        );
      }
      // seen / acked / replied by an agent: it must have been shown to it somewhere
      if (d.to_agent_id && ["seen", "acked", "replied"].includes(state) && !isSystem) {
        const a = agentIdToKey.get(`${m.name}|${d.to_agent_id}`);
        if (!a) continue;
        const inj = injections.get(`${a.key}|${d.message_id}`);
        const viaHeadless = String(d.method ?? "").startsWith("headless");
        if (!inj && !viaHeadless && d.method !== "longpoll") {
          seenNoInject++;
          seenNoInjectByTool[a.tool] = (seenNoInjectByTool[a.tool] ?? 0) + 1;
          violate(
            "marked-seen-never-shown",
            `${m.name}: ${d.kind} ${d.message_id} to ${a.key} (${a.tool}) is ${state} via ${d.method} but was never injected or read`,
            d,
          );
        }
      }
    }
    // duplicate delivery rows
    const dups = await db(
      m,
      "SELECT message_id, to_agent_id, COUNT(*) AS n FROM deliveries WHERE to_agent_id IS NOT NULL GROUP BY message_id, to_agent_id HAVING n > 1",
    );
    for (const d of dups)
      violate("duplicate-delivery-row", `${m.name}: ${d.message_id} → ${d.to_agent_id} ×${d.n}`);
  }

  // 2. receipts: the sender's view of a teammate's delivery matches the teammate's
  let receiptMismatch = 0;
  for (const m of machines) {
    for (const d of deliveriesBy.get(m.name) ?? []) {
      if (d.method !== "relay" && !String(d.to_addr).includes("/")) continue;
      if (!String(d.to_addr).includes("/") && !String(d.to_addr).startsWith("@")) continue;
      const [handle, agentName] = String(d.to_addr).replace(/^@/, "").split("/");
      if (handle === m.name) continue;
      const peer = machines.find((x) => x.name === handle);
      if (!peer) continue;
      const theirs = (deliveriesBy.get(peer.name) ?? []).filter(
        (x) =>
          x.message_id === d.message_id &&
          (agentName ? x.to_agent_id !== null : x.to_agent_id === null),
      );
      if (theirs.length === 0) {
        if (!["failed", "refused", "expired"].includes(String(d.state)))
          violate(
            "remote-missing",
            `${m.name} says ${d.message_id} → ${d.to_addr} is ${d.state}, but ${handle} has no delivery`,
            d,
          );
        continue;
      }
      const there = agentName
        ? (theirs.find((x) => {
            const a = agentIdToKey.get(`${peer.name}|${x.to_agent_id}`);
            return a && (a.name === agentName || a.aliases.includes(agentName));
          }) ?? theirs[0])
        : theirs[0];
      const ts = String(there?.state);
      const hs = String(d.state);
      const expect = ts === "queued" || ts === "delivered" ? ["sent", "delivered"] : [ts];
      if (!expect.includes(hs)) {
        receiptMismatch++;
        violate(
          "receipt-mismatch",
          `${d.message_id} (${d.kind}) → ${d.to_addr}: sender ${m.name} says ${hs}, recipient ${handle} says ${ts}`,
          { here: d, there },
        );
      }
    }
  }

  // 3. silent loss: async failures must reach the sender as a notice
  for (const m of machines) {
    const notices = await db(m, "SELECT envelope FROM messages WHERE from_addr = 'agentlink'");
    const noticeText = notices.map((n) => String(n.envelope)).join("\n");
    for (const d of deliveriesBy.get(m.name) ?? []) {
      if (!["failed", "expired", "refused"].includes(String(d.state)) || !d.from_agent_id) continue;
      const lm = ledger.get(String(d.message_id));
      const sync = lm?.sync.find((s) => s.to === d.to_addr);
      if (sync && ["failed", "refused", "expired"].includes(sync.state)) continue; // told at once
      if (!noticeText.includes(String(d.message_id).slice(0, 12)))
        violate(
          "failure-without-notice",
          `${m.name}: ${d.kind} ${d.message_id} → ${d.to_addr} ended ${d.state} (${d.note}) and the sender got no notice`,
          d,
        );
    }
  }

  // 4. duplicate injections
  let dupInject = 0;
  for (const [k, e] of injections) {
    const real = e.vias.filter((v) => v !== "inbox" && v !== "longpoll");
    if (real.length > 1 || (e.vias.includes("longpoll") && real.length > 0)) {
      dupInject++;
      violate("duplicate-injection", `${k} shown ${e.n}× via ${e.vias.join(", ")}`);
    }
  }

  // 5. waits resolved by replies
  for (const m of ledger.values()) {
    if (!m.wait?.end) continue;
    for (const [key, ans] of m.answers) {
      if (ans.kind === "ack") continue;
      const b = agentByKey(key);
      const remote = b && b.m.name !== m.fromMachine;
      const margin = remote ? 2_500 : 400;
      const outage = relayDown.some(([s, e]) => ans.at < e && (m.wait?.end ?? 0) > s);
      if (ans.at + margin < m.wait.end && !m.wait.replies?.includes(ans.id) && !(remote && outage))
        violate(
          "waiter-not-resolved",
          `ask ${m.id} waited until +${m.wait.end - m.sentAt}ms but ${key}'s reply ${ans.id} came at +${ans.at - m.sentAt}ms`,
          { wait: m.wait },
        );
    }
  }

  // 6. held mail never shown before approval; nothing shown while paused
  for (const [k, h] of hsse) {
    const [machine, did] = k.split("|") as [string, string];
    const heldAt = h.states.indexOf("held");
    if (heldAt < 0) continue;
    const decision = approvals.get(`${machine}|${did}`);
    const m = byName(machine);
    const rows = (deliveriesBy.get(machine) ?? []).filter((x) => String(x.id) === did);
    const a = rows[0]?.to_agent_id
      ? agentIdToKey.get(`${machine}|${rows[0].to_agent_id}`)
      : undefined;
    if (!a || !m) continue;
    const inj = injectionLog.filter((x) => x.key === a.key && x.id === h.id);
    for (const x of inj) {
      if (!decision || decision.decision === "deny" || x.t < decision.at)
        violate(
          "held-shown-early",
          `${machine} delivery #${did} (${h.id}) shown via ${x.via} at ${x.t} before approval ${JSON.stringify(decision)}`,
        );
    }
  }
  for (const x of injectionLog) {
    const m = byName(x.machine);
    if (x.via === "inbox" || x.via === "longpoll") continue;
    if (m.pauseWindows.some(([s, e]) => x.t > s + 300 && x.t < e - 50))
      violate(
        "shown-while-paused",
        `${x.machine}: ${x.id} shown to ${x.key} via ${x.via} while paused`,
      );
  }

  // 7. receipts never go backwards (human SSE stream)
  const allowedBack = new Set(["held>queued", "delivered>queued"]);
  for (const [k, h] of hsse) {
    for (let i = 1; i < h.states.length; i++) {
      const a = h.states[i - 1] as string;
      const b = h.states[i] as string;
      if ((RANK[b] ?? 0) < (RANK[a] ?? 0) && !allowedBack.has(`${a}>${b}`))
        violate("receipt-backwards", `${k} (${h.id} → ${h.to}): ${h.states.join(" → ")}`);
    }
  }

  // 8. per-agent SSE: only conversations it takes part in
  for (const [key, ids] of sseAgent) {
    const a = agentByKey(key);
    if (!a) continue;
    for (const id of ids) await checkVisible(a, id, "sse");
  }

  // 9. thread status vs ledger, and search visibility, sampled
  const sample = R.shuffle([...ledger.values()].filter((m) => m.nonce)).slice(0, 60);
  for (const m of sample) {
    const sender = agentByKey(m.from);
    if (!sender) continue;
    const st = await api<{ state?: string; awaiting?: string[] }>(
      sender,
      "GET",
      `/v1/threads/${m.thread}`,
    );
    if (st.status !== 200) {
      violate(
        "thread-unreadable",
        `${sender.key} cannot read its own thread ${m.thread}: ${st.status}`,
      );
      continue;
    }
    const expecting = ["ask", "request", "handoff", "review_request"].includes(m.kind);
    if (expecting) {
      for (const r of m.to) {
        if (r.human) continue;
        const answered = m.answers.has(r.key ?? "");
        const listed = (st.data.awaiting ?? []).some(
          (x) =>
            x === r.addr ||
            x.endsWith(`/${agentByKey(r.key ?? "")?.name}`) ||
            x === agentByKey(r.key ?? "")?.name,
        );
        if (answered && listed && m.kind !== "handoff")
          violate(
            "thread-awaiting-answered",
            `thread ${m.thread}: ${r.addr} answered ${m.id} but is still listed as awaiting (${st.data.state})`,
          );
        if (
          m.kind === "handoff" &&
          m.to.length > 1 &&
          [...m.answers.values()].some((x) => x.ack === "accept") &&
          listed &&
          !answered
        )
          violate(
            "handoff-taken-still-awaiting",
            `group handoff ${m.id} was accepted but ${r.addr} is still listed as owing an answer (${st.data.state})`,
          );
      }
    }
    // search: participants on each machine find it; nobody else does
    for (const a of agents) {
      if (a.state === "offline" || !a.name) continue;
      const res = await api<{ results?: { id: string }[] }>(a, "GET", `/v1/search?q=${m.nonce}`);
      const found = (res.data.results ?? []).some((h) => h.id === m.id);
      if (found) await checkVisible(a, m.id, "search");
      if (a.key === m.from && !found)
        violate("search-miss", `${a.key} cannot find its own ${m.id} (${m.nonce})`);
    }
  }

  // 10. logs
  const logFindings: Json[] = [];
  for (const m of machines) {
    const f = await m.w.call<Json>("files", { name: m.name });
    const lines = String(f.log).split("\n");
    const errs = lines.filter((l) => / (ERROR|WARN) /.test(l));
    const byMsg = new Map<string, number>();
    for (const l of errs) {
      const k = l.replace(/^\S+ /, "").replace(/\{.*$/, "").trim();
      byMsg.set(k, (byMsg.get(k) ?? 0) + 1);
    }
    const errorsOnly = lines.filter((l) => / ERROR /.test(l));
    logFindings.push({
      machine: m.name,
      counts: Object.fromEntries(byMsg),
      errorSamples: errorsOnly.slice(0, 5),
    });
    if (String(f.crash).trim()) violate("crash-log", `${m.name}: ${String(f.crash).slice(0, 800)}`);
    if (errorsOnly.length)
      violate(
        "daemon-error-log",
        `${m.name}: ${errorsOnly.length} ERROR lines, e.g. ${errorsOnly[0]?.slice(0, 400)}`,
      );
    if (String(f.hookErrors).trim())
      logFindings.push({
        machine: m.name,
        hookErrors: String(f.hookErrors).split("\n").filter(Boolean).slice(-20),
      });
  }
  const rf = await (workers[0] as WorkerApi).call<Json>("files", { name: "relay" });
  const relayErr = String(rf.log)
    .split("\n")
    .filter((l) => / (ERROR|WARN) /.test(l));
  logFindings.push({ relay: true, warnOrError: relayErr.length, samples: relayErr.slice(0, 5) });
  if (String(rf.crash).trim()) violate("relay-crash-log", String(rf.crash).slice(0, 800));

  return {
    finalStates,
    stuck,
    seenNoInject,
    seenNoInjectByTool,
    receiptMismatch,
    dupInject,
    logFindings,
  };
}

async function resources() {
  const out: Json = {};
  const series = (text: string) =>
    text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Json;
        } catch {
          return undefined;
        }
      })
      .filter((x): x is Json => !!x);
  const summarize = (rows: Json[]) => {
    if (rows.length === 0) return {};
    const pick = (k: string) => rows.map((r) => Number(r[k]));
    const eldMax = rows.map((r) => Number((r.eld as Json).max));
    const eldP99 = rows.map((r) => Number((r.eld as Json).p99));
    const n = rows.length;
    const head = rows.slice(0, Math.max(1, Math.floor(n / 5)));
    const tail = rows.slice(-Math.max(1, Math.floor(n / 5)));
    const avg = (xs: Json[], k: string) => xs.reduce((s, r) => s + Number(r[k]), 0) / xs.length;
    const step = Math.max(1, Math.floor(n / 30));
    return {
      samples: n,
      rssMB: {
        first: avg(head, "rss") / 1e6,
        last: avg(tail, "rss") / 1e6,
        max: Math.max(...pick("rss")) / 1e6,
      },
      heapMB: {
        first: avg(head, "heap") / 1e6,
        last: avg(tail, "heap") / 1e6,
        max: Math.max(...pick("heap")) / 1e6,
      },
      fds: { first: avg(head, "fds"), last: avg(tail, "fds"), max: Math.max(...pick("fds")) },
      handles: {
        first: avg(head, "handles"),
        last: avg(tail, "handles"),
        max: Math.max(...pick("handles")),
      },
      eldMaxMs: {
        p50: percentile(eldMax, 50),
        p99: percentile(eldMax, 99),
        max: Math.max(...eldMax),
      },
      eldP99Ms: { p50: percentile(eldP99, 50), max: Math.max(...eldP99) },
      elu: { avg: avg(rows, "elu"), max: Math.max(...pick("elu")) },
      curve: rows
        .filter((_, i) => i % step === 0)
        .map((r) => ({
          s: Math.round((Number(r.t) - T0) / 1000),
          rssMB: Math.round(Number(r.rss) / 1e5) / 10,
          fds: r.fds,
          eldMax: Math.round(Number((r.eld as Json).max)),
          elu: r.elu,
        })),
    };
  };
  for (const m of machines) {
    const f = await m.w.call<Json>("files", { name: m.name });
    out[m.name] = { ...summarize(series(String(f.stats))), dbMB: Number(f.dbBytes) / 1e6 };
  }
  const rf = await (workers[0] as WorkerApi).call<Json>("files", { name: "relay" });
  out.relay = summarize(series(String(rf.stats)));
  return out;
}

function hookSummary() {
  const groups = new Map<string, number[]>();
  const fails = new Map<string, Map<string, number>>();
  for (const h of hookStats) {
    const k = `${h.real ? "cli" : "inproc"} ${h.event}`;
    if (h.ok) groups.set(k, [...(groups.get(k) ?? []), h.ms]);
    else {
      const f = fails.get(k) ?? new Map();
      const e = String(h.err).slice(0, 60);
      f.set(e, (f.get(e) ?? 0) + 1);
      fails.set(k, f);
    }
  }
  const all = hookStats.filter((h) => h.ok && !h.real).map((h) => h.ms);
  const timeouts = hookStats.filter((h) => !h.ok && /timeout/.test(String(h.err)));
  // what was going on when hooks timed out
  const ctx = timeouts.map((h) => {
    const m = machines.find((x) => x.name === h.machine);
    const down = m?.downWindows.some(([s, e]) => h.t >= s - 2_000 && h.t <= e + 2_000);
    const near = chaosLog.filter((c) => Math.abs(c.t - h.t) < 3_000).map((c) => c.what);
    return {
      t: Math.round((h.t - T0) / 1000),
      machine: h.machine,
      event: h.event,
      daemonRestart: !!down,
      near,
    };
  });
  return {
    overall: {
      n: all.length,
      p50: percentile(all, 50),
      p95: percentile(all, 95),
      p99: percentile(all, 99),
      max: Math.max(...all),
    },
    byEvent: Object.fromEntries(
      [...groups].map(([k, xs]) => [
        k,
        {
          n: xs.length,
          p50: percentile(xs, 50),
          p95: percentile(xs, 95),
          p99: percentile(xs, 99),
          max: Math.max(...xs),
        },
      ]),
    ),
    failures: Object.fromEntries([...fails].map(([k, f]) => [k, Object.fromEntries(f)])),
    timeouts: ctx.slice(0, 100),
    timeoutCount: timeouts.length,
  };
}

function apiSummary() {
  const g = new Map<string, { ms: number[]; st: Record<string, number> }>();
  for (const a of apiStats) {
    const e = g.get(a.route) ?? { ms: [], st: {} };
    e.ms.push(a.ms);
    e.st[a.status] = (e.st[a.status] ?? 0) + 1;
    g.set(a.route, e);
  }
  return Object.fromEntries(
    [...g].map(([k, e]) => [
      k,
      {
        n: e.ms.length,
        p50: percentile(e.ms, 50),
        p95: percentile(e.ms, 95),
        p99: percentile(e.ms, 99),
        max: Math.max(...e.ms),
        status: e.st,
      },
    ]),
  );
}

// ------------------------------------------------------------------ main
async function main() {
  const events = eventLoop();
  let report: Json = {};
  try {
    await setup();
    await preload();
    const loops = agents.map((a) => agentLoop(a));
    const bg = [chaosLoop(), approvalsLoop(), stormLoop()];
    const end = T0 + MINUTES * 60_000;
    while (Date.now() < end) {
      await sleep(10_000);
      const sent = ledger.size;
      const online = agents.filter((a) => a.state !== "offline").length;
      log(
        `progress: ${sent} messages in ledger, ${online}/${agents.length} agents online, ${violations.length} violations`,
      );
    }
    await quiesce();
    await Promise.allSettled([...loops, ...bg]);
    const results = await checks();
    report = {
      config: {
        SEED,
        MINUTES,
        N_MACHINES,
        K_AGENTS,
        RATE,
        CHAOS,
        VERIFY,
        REAL_HOOKS,
        workers: workers.map((w) => w.label),
        placement: PLACEMENT,
      },
      durationS: (Date.now() - T0) / 1000,
      messages: ledger.size,
      byKind: [...ledger.values()].reduce<Record<string, number>>((acc, m) => {
        acc[m.kind] = (acc[m.kind] ?? 0) + 1;
        return acc;
      }, {}),
      sendErrors: Object.fromEntries(sendErrors),
      errors: Object.fromEntries(errSamples),
      injections: injections.size,
      results,
      violationCounts: violations.reduce<Record<string, number>>((acc, v) => {
        acc[v.kind] = (acc[v.kind] ?? 0) + 1;
        return acc;
      }, {}),
      violations,
      hooks: hookSummary(),
      api: apiSummary(),
      resources: await resources(),
      chaos: chaosLog.map((c) => ({ s: Math.round((c.t - T0) / 1000), what: c.what })),
      agents: agents.map((a) => ({
        key: a.key,
        tool: a.tool,
        name: a.name,
        ids: [...a.ids],
        starts: a.starts,
        aliases: a.aliases,
      })),
    };
  } catch (error) {
    report.fatal = String((error as Error)?.stack ?? error);
    log("FATAL", report.fatal);
  } finally {
    stopping = true;
    await events.catch(() => undefined);
    writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(OUT, "report.md"), markdown(report));
    log(`report: ${join(OUT, "report.md")}`);
    for (const w of workers) await w.call("shutdown").catch(() => undefined);
    if (!KEEP) rmSync(DIR, { recursive: true, force: true });
    else log(`kept sandbox ${DIR}`);
  }
}

function markdown(r: Json): string {
  const lines = [`# agentlink sim report (seed ${SEED})`, ""];
  if (r.fatal) lines.push("FATAL:", "```", String(r.fatal), "```");
  lines.push(
    "```json",
    JSON.stringify(
      {
        config: r.config,
        durationS: r.durationS,
        messages: r.messages,
        byKind: r.byKind,
        sendErrors: r.sendErrors,
        violationCounts: r.violationCounts,
      },
      null,
      2,
    ),
    "```",
  );
  lines.push("## hooks", "```json", JSON.stringify(r.hooks, null, 2).slice(0, 20_000), "```");
  lines.push("## results", "```json", JSON.stringify(r.results, null, 2).slice(0, 20_000), "```");
  lines.push("## first violations of each kind");
  const seen = new Set<string>();
  for (const v of (r.violations as { kind: string; detail: string }[]) ?? []) {
    if (seen.has(v.kind)) continue;
    seen.add(v.kind);
    lines.push(`- **${v.kind}**: ${v.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

process.on("SIGINT", () => {
  stopping = true;
  noNew = true;
});
await main();
process.exit(0);
