// A sandboxed agentlink for looking at the web UI: two daemons ("noor", this machine, and "teo",
// a teammate) linked through a local relay, fake agent sessions with real-looking identities and
// a steady stream of traffic. Everything lives in a temp dir; the real ~/.agentlink is untouched.
//
//   node scripts/demo-ui.ts            start (prints the login link; Ctrl+C stops)
//   node scripts/demo-ui.ts --link     print a fresh login link for the running demo
//   node scripts/demo-ui.ts --stop     stop the running demo
//   options: --port 47802 (UI port), --keep (keep the sandbox dir on exit)
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POINTER = join(tmpdir(), "agentlink-demo-ui.json");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pointer {
  pid: number;
  sandbox: string;
  port: number;
}
function running(): Pointer | undefined {
  if (!existsSync(POINTER)) return undefined;
  try {
    const p = JSON.parse(readFileSync(POINTER, "utf8")) as Pointer;
    process.kill(p.pid, 0);
    return p;
  } catch {
    return undefined;
  }
}

if (flag("--link") || flag("--stop")) {
  const p = running();
  if (!p) {
    console.error("agentlink demo: not running");
    process.exit(1);
  }
  if (flag("--stop")) {
    process.kill(p.pid, "SIGTERM");
    console.log(`agentlink demo: stopping (pid ${p.pid})`);
    process.exit(0);
  }
  const file = join(p.sandbox, "login-url.txt");
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  process.kill(p.pid, "SIGUSR1");
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const now = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (now && now !== before) {
      console.log(now.trim());
      process.exit(0);
    }
  }
  console.error("agentlink demo: no new link (is it still starting?)");
  process.exit(1);
}

if (running()) {
  console.error(`agentlink demo: already running (${POINTER}); use --link or --stop`);
  process.exit(1);
}

// ------------------------------------------------------------------ sandbox (before any import
// that reads HOME: display paths use the home directory)
const sandbox = mkdtempSync(join(tmpdir(), "agentlink-demo-"));
const fakeHome = join(sandbox, "home");
mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;
process.env.AGENTLINK_HOME = join(sandbox, "noor");
const uiPort = Number(opt("--port", "47802"));

const { silentLogger } = await import("../src/core/log.ts");
const { resolvePaths } = await import("../src/core/paths.ts");
const { procInfo } = await import("../src/core/proc.ts");
const { startDaemon } = await import("../src/daemon/main.ts");
const { startRelay } = await import("../src/relay/server.ts");

type Json = Record<string, unknown>;
interface Machine {
  handle: string;
  home: string;
  socket: string;
  daemon: Awaited<ReturnType<typeof startDaemon>>;
}
interface Agent {
  name: string;
  tool: string;
  model: string;
  project: string;
  title: string;
  m: Machine;
  pid: number;
  start?: string;
}

const children: ChildProcess[] = [];

async function machine(handle: string): Promise<Machine> {
  const home = join(sandbox, handle);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ handle, wake: { tmux: false }, notify: { desktop: false } }),
  );
  const paths = resolvePaths({ AGENTLINK_HOME: home, HOME: fakeHome } as NodeJS.ProcessEnv);
  const daemon = await startDaemon({
    trustClientCaller: true,
    paths,
    logger: silentLogger,
    sweepMs: 2_000,
  });
  return { handle, home, socket: paths.socket, daemon };
}

/** One request on a machine's socket, claiming a caller (the daemon trusts it in this sandbox). */
function raw<T = Json>(
  m: Machine,
  method: string,
  path: string,
  body?: unknown,
  caller: { as?: string; tty?: boolean; chain?: unknown[] } = {},
): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const header = Buffer.from(
      JSON.stringify({ pid: 0, chain: caller.chain ?? [], tty: caller.tty ?? false, ...caller }),
    ).toString("base64url");
    const req = request(
      {
        socketPath: m.socket,
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
          let data: unknown = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            data = { text };
          }
          resolve({ status: res.statusCode ?? 0, data: data as T });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function agent(
  m: Machine,
  spec: Omit<Agent, "m" | "pid" | "start">,
  state: "busy" | "idle",
): Promise<Agent> {
  const dir = join(fakeHome, "work", spec.project);
  mkdirSync(dir, { recursive: true });
  // argv[0] looks like the agent CLI, so hooks find "its" process; the cwd is its project.
  const child = spawn("bash", ["-c", `exec -a /usr/local/bin/${spec.tool} sleep 86400`], {
    cwd: dir,
    stdio: "ignore",
  });
  children.push(child);
  const pid = child.pid as number;
  await sleep(30);
  const start = procInfo(pid)?.start;
  const res = await raw(m, "POST", "/v1/agents/register", {
    tool: spec.tool,
    name: spec.name,
    pid,
    ...(start ? { pidStart: start } : {}),
    cwd: dir,
    model: spec.model,
    title: spec.title,
    state,
  });
  if (res.status !== 200) throw new Error(`register ${spec.name}: ${JSON.stringify(res.data)}`);
  return { ...spec, m, pid, ...(start ? { start } : {}) };
}

/** A hook as the agent CLI would fire it: prompt-submit picks up mail and marks it busy. */
function hook(a: Agent, event: "prompt-submit" | "stop") {
  const chain = [
    { pid: 990_001, ppid: 990_002, cmd: ["node", "/opt/agentlink/dist/cli/index.js", "hook"] },
    { pid: 990_002, ppid: a.pid, cmd: ["/bin/sh", "-c", `agentlink hook ${a.tool} ${event}`] },
    {
      pid: a.pid,
      ppid: 1,
      ...(a.start ? { start: a.start } : {}),
      cmd: [`/usr/local/bin/${a.tool}`],
    },
  ];
  return raw(a.m, "POST", `/v1/hooks/${a.tool}/${event}`, {
    payload: {},
    chain,
    env: { cwd: join(fakeHome, "work", a.project) },
  }).catch(() => undefined);
}
const send = (a: Agent, body: Json) =>
  raw<{ message: { id: string }; deliveries: { to: string; state: string }[] }>(
    a.m,
    "POST",
    "/v1/messages",
    body,
    { as: a.name },
  );
const readMsg = (a: Agent, id: string) =>
  raw(a.m, "GET", `/v1/messages/${id}`, undefined, { as: a.name });

// ------------------------------------------------------------------ start
const relayDir = join(sandbox, "relay");
const relay = await startRelay({ dataDir: relayDir, port: 0, logger: silentLogger });
const noor = await machine("noor");
const teo = await machine("teo");
let team = false;
try {
  const created = await raw(noor, "POST", "/v1/team/create", {
    name: "northwind",
    relay: relay.url,
  });
  if (created.status !== 200) throw new Error(JSON.stringify(created.data));
  const inv = await raw<{ invite: string }>(noor, "POST", "/v1/team/invite", { uses: 1 });
  const joined = await raw(teo, "POST", "/v1/team/join", { invite: inv.data.invite });
  if (joined.status !== 200) throw new Error(JSON.stringify(joined.data));
  team = true;
} catch (error) {
  console.error(`agentlink demo: no teammate machine (${String(error)}); continuing solo`);
}

const L = [
  await agent(
    noor,
    {
      name: "claude-api",
      tool: "claude",
      model: "claude-opus-4-5-20251101",
      project: "api",
      title: "fix login token refresh",
    },
    "busy",
  ),
  await agent(
    noor,
    {
      name: "codex-web",
      tool: "codex",
      model: "gpt-5.1-codex",
      project: "web",
      title: "checkout page redesign",
    },
    "idle",
  ),
  await agent(
    noor,
    {
      name: "opencode-docs",
      tool: "opencode",
      model: "anthropic/claude-sonnet-4-5",
      project: "docs",
      title: "API reference for v2",
    },
    "idle",
  ),
  await agent(
    noor,
    {
      name: "gemini-infra",
      tool: "gemini",
      model: "gemini-2.5-pro",
      project: "infra",
      title: "terraform drift in staging",
    },
    "busy",
  ),
  await agent(
    noor,
    {
      name: "claude-mobile",
      tool: "claude",
      model: "claude-sonnet-4-5-20250929",
      project: "mobile",
      title: "push notification retries",
    },
    "idle",
  ),
  await agent(
    noor,
    {
      name: "cursor-billing",
      tool: "cursor",
      model: "gpt-5",
      project: "billing",
      title: "invoice PDF export",
    },
    "idle",
  ),
];
const T = team
  ? [
      await agent(
        teo,
        {
          name: "codex-search",
          tool: "codex",
          model: "gpt-5.1-codex-max",
          project: "search",
          title: "ranking eval harness",
        },
        "busy",
      ),
      await agent(
        teo,
        {
          name: "claude-data",
          tool: "claude",
          model: "claude-opus-4-5",
          project: "data",
          title: "nightly ETL backfill",
        },
        "idle",
      ),
      await agent(
        teo,
        {
          name: "opencode-qa",
          tool: "opencode",
          model: "openai/gpt-5-mini",
          project: "qa",
          title: "flaky e2e triage",
        },
        "idle",
      ),
    ]
  : [];
if (team) {
  // Requests from teo's agents wait for noor's approval; handoffs from teo are refused.
  await raw(
    noor,
    "POST",
    "/v1/policy",
    { scope: "teo", kind: "request", action: "hold" },
    { tty: true },
  );
  await raw(
    noor,
    "POST",
    "/v1/policy",
    { scope: "teo", kind: "handoff", action: "refuse" },
    { tty: true },
  );
  for (let i = 0; i < 40; i++) {
    const r = await raw<{ agents: { name: string }[] }>(noor, "GET", "/v1/agents");
    if (r.data.agents.filter((a) => a.name.startsWith("teo/")).length >= T.length) break;
    await sleep(200);
  }
}

// ------------------------------------------------------------------ traffic
const pick = <X>(xs: X[]): X => xs[Math.floor(Math.random() * xs.length)] as X;
const two = (xs: Agent[]): [Agent, Agent] => {
  const a = pick(xs);
  let b = pick(xs);
  while (b === a) b = pick(xs);
  return [a, b];
};
const jitter = (lo: number, hi: number) => sleep(lo + Math.random() * (hi - lo));
const addr = (from: Agent, to: Agent) => (from.m === to.m ? to.name : `${to.m.handle}/${to.name}`);

const ASKS = [
  [
    "Which env var holds the refresh token TTL? I only see `AUTH_TTL` in .env.example.",
    "It's `REFRESH_TTL_SECONDS`, read in src/auth/config.ts. Default is 14 days.",
  ],
  [
    "Is the /v2/orders endpoint paginated by cursor or offset?",
    "Cursor. Pass `after=<id>`; pages are 50 items, `has_more` tells you when to stop.",
  ],
  [
    "Did anyone change the Stripe webhook secret on staging this week?",
    "Yes, rotated Tuesday. The new one is in the staging vault under billing/stripe.",
  ],
  [
    "What's the p95 for checkout after your cache change?",
    "Down from 840ms to 310ms on staging. Prod rollout is behind the `checkout_cache` flag.",
  ],
  [
    "Can I drop the legacy `user_prefs` table or is mobile still reading it?",
    "Mobile still reads it on app versions below 4.12. Keep it until the forced upgrade lands.",
  ],
  [
    "Where do the OpenAPI specs get generated from?",
    "From the zod schemas: `pnpm gen:openapi` writes docs/openapi.yaml.",
  ],
  [
    "Which Terraform workspace does the preview env use?",
    "`preview`, with state in the s3 bucket nw-tf-state. Don't apply from laptops; CI does it.",
  ],
];
const HANDOFFS = [
  "Handing off the invoice rounding bug: repro in billing/tests/rounding.spec.ts, fails on EUR with 3 line items.",
  "Taking a break from the docs build; the broken links are all under /reference/webhooks. Can you pick it up?",
  "Passing the flaky login e2e to you: it fails when the token refresh races the redirect.",
];
const REVIEWS = [
  [
    "Please review PR #482: retry policy for push notifications (exponential, capped at 5).",
    "Looks good. One nit: jitter should be applied before the cap, not after. Approving once fixed.",
  ],
  [
    "Review request: the new rate limiter middleware in api/src/middleware/limit.ts.",
    "LGTM. Consider exempting /healthz, otherwise the load balancer trips it under load.",
  ],
  [
    "Could you review the terraform plan for the staging VPC peering?",
    "Plan is fine, but it replaces the NAT gateway. Schedule it outside business hours.",
  ],
];
const FYIS = [
  "FYI: main is frozen for the 2.3 release from 16:00 UTC. Only cherry-picks with a ticket.",
  "Heads up: staging database restarts at 14:30 for the minor version upgrade (about 3 minutes).",
  "FYI: the shared OpenAI key was rotated; pull the new one from the vault before your next run.",
];
const REQUESTS = [
  "Please run the search index migration on staging; I need the new analyzer for the eval.",
  "Can you regenerate the API client from the v2 spec and open a PR against mobile?",
  "Please bump the ETL worker memory to 4 GiB in infra; the backfill keeps getting OOM-killed.",
];
const HUMAN = [
  "Should the login fix ship behind a flag, or straight to everyone?",
  "The invoice export changes rounding for 0.3% of invoices. OK to proceed?",
  "Can I delete the stale preview environments older than 30 days?",
];

async function exchange(
  kind: "ask" | "review_request",
  text: string,
  answer: string,
  a: Agent,
  b: Agent,
) {
  const sent = await send(a, { to: [addr(a, b)], kind, text });
  const id = sent.data.message?.id;
  if (!id) return;
  await jitter(1200, 2600);
  await hook(b, "prompt-submit");
  await jitter(900, 2000);
  await readMsg(b, id);
  await jitter(1800, 4200);
  const rep = await send(b, {
    kind: kind === "ask" ? "reply" : "review_result",
    replyTo: id,
    text: answer,
  });
  await hook(b, "stop");
  const rid = rep.data.message?.id;
  if (!rid) return;
  await jitter(1500, 3500);
  await hook(a, "prompt-submit");
  await jitter(600, 1500);
  await readMsg(a, rid);
}
async function handoff(a: Agent, b: Agent) {
  const sent = await send(a, { to: [addr(a, b)], kind: "handoff", text: pick(HANDOFFS) });
  const id = sent.data.message?.id;
  if (!id || a.m !== b.m) return;
  await jitter(1500, 3000);
  await hook(b, "prompt-submit");
  await jitter(1000, 2500);
  await readMsg(b, id);
  await jitter(1000, 2500);
  const ack = await raw<{ message?: { id: string } }>(
    b.m,
    "POST",
    `/v1/messages/${id}/ack`,
    { ack: pick(["accept", "accept", "decline"]) },
    { as: b.name },
  );
  if (!ack.data.message) return;
  await jitter(1500, 3500);
  await readMsg(a, ack.data.message.id);
}
async function fyi(a: Agent) {
  const others = L.filter((x) => x !== a);
  const to = others.sort(() => Math.random() - 0.5).slice(0, 3);
  const sent = await send(a, { to: to.map((b) => b.name), kind: "info", text: pick(FYIS) });
  const id = sent.data.message?.id;
  if (!id) return;
  for (const b of to) {
    await jitter(700, 2500);
    await readMsg(b, id);
  }
}
async function heldCount(): Promise<number> {
  const r = await raw<{ items: unknown[] }>(noor, "GET", "/v1/approvals");
  return r.data.items?.length ?? 0;
}
async function humanCount(): Promise<number> {
  const r = await raw<{ todo: number }>(noor, "GET", "/v1/overview");
  return r.data.todo ?? 0;
}
async function busyFlicker() {
  const a = pick([...L, ...T]);
  await hook(a, "prompt-submit");
  await jitter(4000, 9000);
  await hook(a, "stop");
}

let tick = 0;
let stopping = false;
async function step() {
  tick++;
  const r = Math.random();
  if (team && tick % 11 === 0 && (await heldCount()) < 3) {
    const a = pick(T),
      b = pick(L);
    await send(a, { to: [`noor/${b.name}`], kind: "request", text: pick(REQUESTS) });
  } else if (team && tick % 17 === 0) {
    await send(pick(T), { to: [`noor/${pick(L).name}`], kind: "handoff", text: pick(HANDOFFS) });
  } else if (tick % 13 === 0 && (await humanCount()) < 3) {
    await send(pick(L), { to: ["@noor"], kind: "ask", text: pick(HUMAN) });
  } else if (r < 0.34) {
    const [q, ans] = pick(ASKS) as [string, string];
    const [a, b] = two(L);
    await exchange("ask", q, ans, a, b);
  } else if (r < 0.5 && team) {
    const [q, ans] = pick(ASKS) as [string, string];
    if (Math.random() < 0.5) await exchange("ask", q, ans, pick(L), pick(T));
    else await exchange("ask", q, ans, pick(T), pick(L));
  } else if (r < 0.64) {
    const [q, ans] = pick(REVIEWS) as [string, string];
    const [a, b] = two(L);
    await exchange("review_request", q, ans, a, b);
  } else if (r < 0.76) {
    const [a, b] = two(L);
    await handoff(a, b);
  } else if (r < 0.86) {
    await fyi(pick(L));
  } else {
    await busyFlicker();
  }
}
async function traffic() {
  while (!stopping) {
    step().catch((error) => console.error("agentlink demo: traffic step failed", String(error)));
    await jitter(2500, 5000);
  }
}

// A little history first, so the UI has something to show at once.
await Promise.all([
  exchange(
    "ask",
    (ASKS[0] as string[])[0] as string,
    (ASKS[0] as string[])[1] as string,
    L[1] as Agent,
    L[0] as Agent,
  ),
  fyi(L[3] as Agent),
  handoff(L[5] as Agent, L[2] as Agent),
  team
    ? send(T[0] as Agent, {
        to: [`noor/${(L[0] as Agent).name}`],
        kind: "request",
        text: REQUESTS[0],
      })
    : Promise.resolve(),
  send(L[4] as Agent, { to: ["@noor"], kind: "ask", text: HUMAN[0] }),
]);
void traffic();

// ------------------------------------------------------------------ login links + lifecycle
const ui = noor.daemon.services.ui;
if (!ui) throw new Error("this daemon has no web UI");
async function link(): Promise<string> {
  const { url } = await (ui as { session(port?: number): Promise<{ url: string }> }).session(
    uiPort,
  );
  writeFileSync(join(sandbox, "login-url.txt"), `${url}\n`);
  return url;
}
writeFileSync(POINTER, JSON.stringify({ pid: process.pid, sandbox, port: uiPort }));
const url = await link();
console.log(`agentlink demo is running (pid ${process.pid})
  sandbox:   ${sandbox}  (HOME and AGENTLINK_HOME point here; ~/.agentlink is untouched)
  machines:  noor (this machine, ${L.length} agents)${team ? `, teo (teammate, ${T.length} agents) via relay ${relay.url}` : ""}
  open:      ${url}
             (one-time link, valid 2 minutes; new one: node scripts/demo-ui.ts --link)
  stop:      Ctrl+C, or node scripts/demo-ui.ts --stop`);

process.on("SIGUSR1", () => {
  link().then(
    (u) => console.log(`login link: ${u}`),
    (e) => console.error(String(e)),
  );
});
async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGKILL");
  await Promise.allSettled([noor.daemon.close(), teo.daemon.close()]);
  await relay.close().catch(() => undefined);
  try {
    rmSync(POINTER, { force: true });
  } catch {}
  if (!flag("--keep")) rmSync(sandbox, { recursive: true, force: true });
  console.log("agentlink demo: stopped");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
