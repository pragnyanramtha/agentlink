import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { LIMITS } from "../../core/limits.ts";
import { findBin } from "../../daemon/runners/index.ts";
import {
  type CliContext,
  type Command,
  optionalValue,
  out,
  parse,
  parseDuration,
  readAllStdin,
  readText,
  UsageError,
} from "../args.ts";
import { ago, c, clip, statusLine, table } from "../format.ts";

const HARNESSES = ["claude", "codex", "opencode", "gemini"];

interface RunView {
  id: string;
  agent: string;
  harness: string;
  kind: string;
  profile: string;
  model: string | null;
  state: string;
  requester: string;
  cwd: string;
  sessionId: string | null;
  argv: string[] | null;
  pid: number | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  costUsd: number | null;
  tokens: { in: number | null; out: number | null } | null;
  denials: number | null;
  result: string | null;
  note: string | null;
  log: string | null;
}
interface HeadlessView {
  enabled: boolean;
  roots: string[];
  from: { local: { wake: string; spawn: string }; teammate: { wake: string } };
  maxConcurrent: number;
  perAgentPerHour: number;
  globalPerHour: number;
  spawnPerHour: number;
  perThreadRuns: number;
  timeoutSec: number;
  maxBudgetUsd?: number;
  maxSpawnDepth: number;
  running: number;
  runners: {
    harness: string;
    enabled: boolean;
    profile: string;
    model: string | null;
    bin: string | null;
    experimental: boolean;
    argv: { new: string[]; resume: string[] };
    env: Record<string, string> | null;
  }[];
}
interface Answer {
  reply?: { text: string; message: { from: string } };
  note: string;
  run: RunView | null;
}

const real = (dir: string) => {
  try {
    return realpathSync(resolve(dir));
  } catch {
    return resolve(dir);
  }
};

function describeSettings(h: HeadlessView, verbose: boolean): string {
  const onOff = h.enabled ? c.green("on") : c.yellow("off");
  const rows = h.runners.map((r) => [
    r.harness + (r.experimental ? c.dim(" (experimental)") : ""),
    r.enabled ? c.green("enabled") : c.dim("off"),
    r.profile,
    r.model ?? "-",
    r.bin ?? (r.enabled ? c.yellow("not found") : "-"),
  ]);
  const lines = [
    `headless runs: ${onOff} · ${h.running} running · roots: ${h.roots.length ? h.roots.join(", ") : c.yellow("none (nothing can run)")}`,
    table(rows, ["RUNNER", "STATE", "PROFILE", "MODEL", "BINARY"]),
    c.dim(
      `limits: ${h.maxConcurrent} at a time · ${h.perAgentPerHour}/agent/h · ${h.globalPerHour}/h · ${h.spawnPerHour} spawns/h · ${h.perThreadRuns}/conversation · ${h.timeoutSec}s timeout${h.maxBudgetUsd ? ` · $${h.maxBudgetUsd}/run` : ""} · spawn depth ${h.maxSpawnDepth}`,
    ),
    c.dim(
      `who: local wake=${h.from.local.wake} spawn=${h.from.local.spawn} · teammate wake=${h.from.teammate.wake} · external refused`,
    ),
  ];
  if (verbose)
    for (const r of h.runners)
      lines.push(
        "",
        `${c.bold(r.harness)} (${r.profile}):`,
        `  new:    ${r.argv.new.join(" ")}`,
        `  resume: ${r.argv.resume.join(" ")}`,
        ...(r.env ? [`  env:    ${Object.entries(r.env).map(([k, v]) => `${k}=${v}`)}`] : []),
      );
  if (!h.enabled || !h.roots.length || !h.runners.some((r) => r.enabled))
    lines.push(
      c.dim(
        "\nTurn on (in your terminal): agentlink headless on · headless enable codex · headless roots add ~/work",
      ),
    );
  return lines.join("\n");
}

const SETTINGS_USAGE =
  "usage: agentlink headless [show] | on | off | enable <harness> [--profile read-only|edit|full] [--model m] [--bin path] | disable <harness> | roots [add|remove <dir>] | set <key>=<value>…";

export const headless: Command = async (ctx) => {
  const { values, positionals } = parse(ctx.argv, {
    profile: { type: "string" },
    model: { type: "string" },
    bin: { type: "string" },
  });
  const [sub = "show", ...args] = positionals;
  let body: Record<string, unknown> | undefined;
  if (sub === "on" || sub === "off") body = { enabled: sub === "on" };
  else if (sub === "enable" || sub === "disable") {
    const harness = args[0] ?? "";
    if (!HARNESSES.includes(harness)) throw new UsageError(SETTINGS_USAGE);
    // Found on your PATH now; the daemon keeps the absolute path.
    const bin = values.bin ? resolve(values.bin) : sub === "enable" ? findBin(harness) : undefined;
    body = {
      runner: {
        harness,
        enabled: sub === "enable",
        ...(values.profile ? { profile: values.profile } : {}),
        ...(values.model ? { model: values.model === "none" ? null : values.model } : {}),
        ...(bin ? { bin } : {}),
      },
    };
  } else if (sub === "roots" && (args[0] === "add" || args[0] === "remove")) {
    if (!args[1]) throw new UsageError(SETTINGS_USAGE);
    body = args[0] === "add" ? { addRoot: real(args[1]) } : { removeRoot: real(args[1]) };
  } else if (sub === "set") {
    if (!args.length) throw new UsageError(SETTINGS_USAGE);
    const set: Record<string, string | number | null> = {};
    for (const a of args) {
      const [key, value] = a.split("=", 2);
      if (!key || value === undefined) throw new UsageError(SETTINGS_USAGE);
      set[key] = value === "none" ? null : /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    }
    body = { set };
  } else if (!["show", "status", "roots"].includes(sub)) throw new UsageError(SETTINGS_USAGE);
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<HeadlessView>(body ? "POST" : "GET", "/v1/headless", body);
  out(ctx, res, () => describeSettings(res, !!ctx.verbose || sub === "enable"));
  return 0;
};

function printAnswer(ctx: CliContext, res: Answer, waitMs: number): number {
  out(ctx, res, () => {
    if (res.reply) return res.reply.text;
    const lines = [`${c.green("✓")} ${res.note}`];
    if (res.run)
      lines.push(
        c.dim(
          `  ${waitMs ? "no answer yet; it" : "the answer"} comes to your inbox · agentlink runs ${res.run.id} · stop: agentlink stop ${res.run.id}`,
        ),
      );
    return lines.join("\n");
  });
  return waitMs && !res.reply ? 3 : 0;
}

async function waiting<T>(ctx: CliContext, waitMs: number, who: string, fn: () => Promise<T>) {
  const stop =
    waitMs > 0 && !ctx.json
      ? statusLine(
          (s) => `waiting for ${who}… ${s}s (Ctrl-C to stop; the answer still reaches your inbox)`,
        )
      : () => {};
  try {
    return await fn();
  } finally {
    stop();
  }
}

export const spawn: Command = async (ctx) => {
  const { values, positionals } = parse(optionalValue(ctx.argv, "wait", "w"), {
    cwd: { type: "string" },
    name: { type: "string" },
    model: { type: "string" },
    wait: { type: "string", short: "w" },
    stdin: { type: "boolean" },
  });
  const [harness, ...rest] = positionals;
  const task = harness ? await readText(rest, Boolean(values.stdin)) : "";
  if (!harness || !task.trim())
    throw new UsageError(
      'usage: agentlink spawn <claude|codex|opencode|gemini> [--cwd dir] [--name x] [--model m] [--wait [2m]] "<task>"',
    );
  const waitMs =
    values.wait !== undefined ? parseDuration(values.wait, LIMITS.cliAskDefaultWaitMs) : 0;
  await ctx.client.ensureDaemon();
  const res = await waiting(ctx, waitMs, harness, () =>
    ctx.client.request<Answer & { run: RunView }>(
      "POST",
      "/v1/spawn",
      {
        harness,
        task,
        cwd: real(values.cwd ?? process.cwd()),
        ...(values.name ? { name: values.name } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(waitMs ? { waitMs } : {}),
      },
      { timeoutMs: waitMs ? waitMs + 10_000 : 15_000 },
    ),
  );
  return printAnswer(ctx, res, waitMs);
};

export const wake: Command = async (ctx) => {
  const { values, positionals } = parse(optionalValue(ctx.argv, "wait", "w"), {
    wait: { type: "string", short: "w" },
    stdin: { type: "boolean" },
  });
  const [agent, ...rest] = positionals;
  if (!agent) throw new UsageError('usage: agentlink wake <agent> ["<message>"] [--wait [2m]]');
  const text = rest.length ? rest.join(" ") : values.stdin ? (await readAllStdin()).trim() : "";
  const waitMs =
    values.wait !== undefined ? parseDuration(values.wait, LIMITS.cliAskDefaultWaitMs) : 0;
  await ctx.client.ensureDaemon();
  const res = await waiting(ctx, waitMs, agent, () =>
    ctx.client.request<Answer>(
      "POST",
      "/v1/wake",
      { agent, ...(text ? { text } : {}), ...(waitMs && text ? { waitMs } : {}) },
      { timeoutMs: waitMs ? waitMs + 10_000 : 15_000 },
    ),
  );
  return printAnswer(ctx, res, text ? waitMs : 0);
};

export const runs: Command = async (ctx) => {
  const { values, positionals } = parse(ctx.argv, {
    limit: { type: "string", short: "n" },
    agent: { type: "string" },
    state: { type: "string" },
  });
  await ctx.client.ensureDaemon();
  const [ref] = positionals;
  if (ref) {
    const { run } = await ctx.client.request<{ run: RunView }>(
      "GET",
      `/v1/runs/${encodeURIComponent(ref)}`,
    );
    out(ctx, { run }, () =>
      [
        `${c.bold(run.id)} ${run.state} · ${run.kind} ${run.agent} (${run.harness}, ${run.profile}${run.model ? `, ${run.model}` : ""}) · asked by ${run.requester}`,
        `  in       ${run.cwd}`,
        `  command  ${run.argv?.join(" ") ?? "-"}   (prompt on stdin)`,
        `  started  ${ago(run.startedAt)}${run.endedAt ? ` · ended ${ago(run.endedAt)}` : ""}${run.exitCode !== null || run.signal ? ` · exit ${run.exitCode ?? run.signal}` : ""}`,
        ...(run.costUsd !== null || run.tokens
          ? [
              `  used     ${run.costUsd !== null ? `$${run.costUsd.toFixed(4)} ` : ""}${run.tokens ? `${run.tokens.in ?? "?"} in / ${run.tokens.out ?? "?"} out tokens` : ""}`,
            ]
          : []),
        ...(run.denials ? [`  denied   ${run.denials} tool use(s) by its permissions`] : []),
        ...(run.result ? [`  answer   agentlink show ${run.result}`] : []),
        ...(run.note ? [`  note     ${run.note}`] : []),
        ...(run.log ? [`  output   ${run.log}`] : []),
      ].join("\n"),
    );
    return 0;
  }
  const q = new URLSearchParams();
  if (values.limit) q.set("limit", values.limit);
  if (values.agent) q.set("agent", values.agent);
  if (values.state) q.set("state", values.state);
  const res = await ctx.client.request<{ runs: RunView[] }>("GET", `/v1/runs?${q}`);
  out(ctx, res, () =>
    res.runs.length === 0
      ? c.dim("No headless runs yet (see: agentlink headless).")
      : table(
          res.runs.map((r) => [
            r.id,
            r.state,
            r.agent,
            `${r.kind} ${r.harness} ${r.profile}`,
            r.requester,
            ago(r.createdAt),
            clip(r.note ?? "", 50),
          ]),
          ["RUN", "STATE", "AGENT", "WHAT", "ASKED BY", "WHEN", "NOTE"],
        ),
  );
  return 0;
};

export const stop: Command = async (ctx) => {
  const { positionals } = parse(ctx.argv, {});
  const [ref] = positionals;
  if (!ref) throw new UsageError("usage: agentlink stop <run-id|agent>");
  await ctx.client.ensureDaemon();
  const { run } = await ctx.client.request<{ run: RunView }>(
    "POST",
    `/v1/runs/${encodeURIComponent(ref)}/stop`,
    {},
  );
  out(ctx, { run }, () =>
    run.state === "running"
      ? `${c.yellow("■")} stopping ${run.id} (${run.agent}): interrupted; terminated after 10s if it keeps running`
      : `${c.green("✓")} ${run.id} is ${run.state}`,
  );
  return 0;
};
