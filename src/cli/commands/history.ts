import { createInterface } from "node:readline/promises";
import { loadConfig, saveConfig } from "../../core/config.ts";
import { didYouMean } from "../../core/suggest.ts";
import {
  type CliContext,
  type Command,
  FILTER_OPTIONS,
  filterQuery,
  out,
  parse,
  parseDuration,
  UsageError,
} from "../args.ts";
import { ApiError } from "../client.ts";
import { ago, c, clip, indent, mark, short, table, when } from "../format.ts";

type Tally = { busy: number; idle: number; offline: number };
export interface Overview {
  version: string;
  pid: number;
  handle: string;
  host: string;
  paused: boolean;
  team: null | {
    name: string;
    relay: string;
    connected: boolean;
    members: number;
    membersOnline: number;
  };
  agents: { local: Tally; remote: Tally };
  unread: number;
  todo: number;
  held?: number;
  outbox: number;
  db: { messages: number; bytes: number };
}
interface AgentRow {
  name: string;
  state: string;
  modelShort?: string | null;
  status?: string | null;
  local?: boolean;
  member?: string;
}
interface ThreadRow {
  thread: string;
  subject: string;
  participants: string[];
  messages: number;
  lastAt: string;
  lastFrom: string;
  lastPreview: string;
  open: boolean;
  unread: number;
}
interface SearchRow {
  id: string;
  thread: string;
  kind: string;
  from: string;
  to: string[];
  createdAt: string;
  snippet: string;
  tokens: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

/** The dashboard: who is here, what waits for you, open conversations, what to do next. */
export function overviewText(
  ov: Overview,
  agents: AgentRow[],
  threads: ThreadRow[],
  now = Date.now(),
): string {
  const team = ov.team
    ? ` · team ${c.bold(ov.team.name)} ${ov.team.connected ? c.green("connected") : c.red("relay offline")}${
        ov.team.members > 1
          ? c.dim(` (${ov.team.membersOnline}/${ov.team.members} machines online)`)
          : ""
      }`
    : c.dim(" · no team");
  const lines = [
    `${c.bold("agentlink")} ${c.dim(ov.version)} · ${c.cyan(`@${ov.handle}`)} on ${ov.host}${team}`,
  ];
  if (ov.paused)
    lines.push(c.yellow("⏸ paused: messages are queued, not delivered (agentlink resume)"));

  const { local, remote } = ov.agents;
  const [busy, idle, offline] = [
    local.busy + remote.busy,
    local.idle + remote.idle,
    local.offline + remote.offline,
  ];
  lines.push(
    "",
    `${c.bold("Agents")}    ${[c.yellow(`${busy} busy`), c.green(`${idle} idle`), c.dim(`${offline} offline`)].join(c.dim(" · "))}`,
  );
  const machines = new Map<string, string[]>([[ov.handle, []]]);
  for (const a of agents) {
    const remoteAgent = a.local === false;
    const machine = remoteAgent ? (a.member ?? a.name.split("/")[0] ?? "?") : ov.handle;
    const name = remoteAgent ? a.name.slice(machine.length + 1) || a.name : a.name;
    const dot = a.state === "busy" ? c.yellow("●") : a.state === "idle" ? c.green("○") : c.dim("○");
    const label = `${dot} ${a.state === "busy" || a.state === "idle" ? c.bold(name) : c.dim(name)}${a.modelShort ? c.dim(` ${a.modelShort}`) : ""}`;
    const list = machines.get(machine) ?? [];
    list.push(a.status ? `${label} ${c.dim(`(${clip(a.status, 32)})`)}` : label);
    machines.set(machine, list);
  }
  const rows = [...machines].map(([machine, list]) => {
    const here = machine === ov.handle;
    const extra = here && local.offline ? [c.dim(`+${local.offline} offline`)] : [];
    const shown = list.length || extra.length ? [...list, ...extra] : [c.dim("none online")];
    return [here ? `${machine} ${c.dim("(here)")}` : machine, shown.join("  ")];
  });
  lines.push(indent(table(rows)));

  const counts = [
    ov.unread ? c.bold(`${ov.unread} unread`) : c.dim("0 unread"),
    ov.todo ? c.yellow(`${ov.todo} waiting for your answer`) : c.dim("nothing waiting for you"),
    ...(ov.held ? [`${c.yellow(`${ov.held} held`)} ${c.dim("for your approval")}`] : []),
    ...(ov.outbox ? [c.dim(`${ov.outbox} queued for the relay`)] : []),
    c.dim(`${plural(ov.db.messages, "message")} stored (${mb(ov.db.bytes)})`),
  ];
  lines.push("", `${c.bold("Messages")}  ${counts.join(c.dim(" · "))}`);

  if (threads.length) {
    lines.push("", c.bold("Open conversations"));
    lines.push(
      indent(
        table(
          threads.map((t) => [
            c.dim(short(t.thread)),
            c.dim(ago(t.lastAt, now)),
            t.participants.join(", "),
            `${t.unread ? `${c.bold(`${t.unread} new`)} ` : ""}${c.dim(`"${clip(t.subject, 60)}"`)}`,
          ]),
        ),
      ),
    );
  }

  const hints: string[] = [];
  if (busy + idle + offline === 0)
    hints.push("no agents yet: run agentlink setup, then restart your agent sessions");
  if (ov.held) hints.push("held messages wait for you: agentlink approvals");
  if (ov.paused) hints.push("deliver again: agentlink resume");
  if (ov.todo) hints.push("answer what waits for you: agentlink todo");
  else if (ov.unread) hints.push("read your mail: agentlink inbox");
  if (ov.team && !ov.team.connected) hints.push("check the connection: agentlink team status");
  if (threads[0]) hints.push(`open a conversation: agentlink thread ${short(threads[0].thread)}`);
  if (!ov.team) hints.push("connect another machine or a friend: agentlink team invite");
  hints.splice(2);
  hints.push("live web viewer: agentlink ui · find old messages: agentlink search <words>");
  lines.push("", ...hints.map((h) => c.dim(`→ ${h}`)));
  return lines.join("\n");
}

export function searchText(
  res: { results: SearchRow[]; fts: boolean },
  query: string,
  limit: number,
  now = Date.now(),
): string {
  const n = res.results.length;
  const lines = n
    ? [
        table(
          res.results.map((r) => [
            c.dim(short(r.id)),
            c.dim(when(r.createdAt, now)),
            c.bold(r.kind),
            `${c.cyan(r.from)} → ${r.to.join(", ") || "-"}`,
            c.dim(`~${r.tokens}`),
            mark(clip(r.snippet, 300)),
          ]),
          ["ID", "WHEN", "KIND", "FROM → TO", "TOKENS", "MATCH"],
        ),
        c.dim(
          `${plural(n, "result")}${n >= limit ? ` (more: -n ${limit * 2})` : ""} · full message: agentlink show <id> · conversation: agentlink thread <id>`,
        ),
      ]
    : [
        c.dim(
          `No messages match${query ? ` "${query}"` : ""}. Try fewer or other words, or fewer filters.`,
        ),
      ];
  if (!res.fts) lines.push(c.dim("(plain text match: the full-text index is not available here)"));
  return lines.join("\n");
}

export function threadsText(threads: ThreadRow[], now = Date.now(), open = false): string {
  if (!threads.length)
    return c.dim(
      open
        ? "Nothing open: no asks, requests or handoffs waiting for you or for an answer."
        : "No conversations yet.",
    );
  return [
    table(
      threads.map((t) => [
        c.dim(short(t.thread)),
        c.dim(when(t.lastAt, now)),
        t.participants.join(", "),
        String(t.messages),
        [t.open ? c.yellow("open") : "", t.unread ? c.bold(`${t.unread} unread`) : ""]
          .filter(Boolean)
          .join(" ") || c.dim("-"),
        c.dim(
          `"${clip(t.subject, 50)}"${t.messages > 1 ? ` → ${t.lastFrom}: "${clip(t.lastPreview, 50)}"` : ""}`,
        ),
      ]),
      ["THREAD", "LAST", "WHO", "MSGS", "STATE", "CONVERSATION"],
    ),
    c.dim("whole conversation: agentlink thread <id>"),
  ].join("\n");
}

/** Prints the dashboard (also what bare `agentlink` shows on a terminal). */
export async function showOverview(ctx: CliContext, footer = ""): Promise<number> {
  const [ov, agents, threads] = await Promise.all([
    ctx.client.request<Overview>("GET", "/v1/overview"),
    ctx.json ? undefined : ctx.client.request<{ agents: AgentRow[] }>("GET", "/v1/agents"),
    ctx.json
      ? undefined
      : ctx.client.request<{ threads: ThreadRow[] }>("GET", "/v1/threads?open=1&limit=5"),
  ]);
  out(ctx, ov, () => overviewText(ov, agents?.agents ?? [], threads?.threads ?? []) + footer);
  return 0;
}

export const overview: Command = async (ctx) => {
  parse(ctx.argv, {});
  await ctx.client.ensureDaemon();
  return showOverview(ctx);
};

const limitOf = (value: string) => {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1 || n > 100) throw new UsageError("-n must be 1 to 100");
  return n;
};

export const search: Command = async (ctx) => {
  const { values, positionals } = parse(ctx.argv, {
    ...FILTER_OPTIONS,
    limit: { type: "string", short: "n", default: "20" },
  });
  const words = positionals.join(" ").trim();
  const limit = limitOf(values.limit);
  const q = await filterQuery(values);
  if (!words && !q.size)
    throw new UsageError(
      "usage: agentlink search <words…> [--from <agent>] [--kind ask] [--since 2d] [-n 20]",
    );
  if (words) q.set("q", words);
  q.set("limit", String(limit));
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{ results: SearchRow[]; fts: boolean }>(
    "GET",
    `/v1/search?${q}`,
  );
  out(ctx, res, () => searchText(res, words, limit));
  return 0;
};

export const threads: Command = async (ctx) => {
  const { values, positionals } = parse(ctx.argv, {
    with: { type: "string", short: "w" },
    open: { type: "boolean", short: "o" },
    limit: { type: "string", short: "n", default: "20" },
  });
  if (positionals[0])
    throw new UsageError(
      `threads lists conversations; to open one: agentlink thread ${positionals[0]}`,
    );
  const q = new URLSearchParams({ limit: String(limitOf(values.limit)) });
  if (values.with) q.set("with", values.with);
  if (values.open) q.set("open", "1");
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{ threads: ThreadRow[] }>("GET", `/v1/threads?${q}`);
  out(ctx, res, () => threadsText(res.threads, Date.now(), Boolean(values.open)));
  return 0;
};

interface PruneResult {
  dryRun: boolean;
  cutoff: string;
  messages: number;
  deliveries: number;
  threads: number;
  kept: number;
}

function pruneText(r: PruneResult): string {
  const what = `${plural(r.messages, "message")} older than ${when(r.cutoff)} (${plural(r.deliveries, "receipt")}; ${plural(r.threads, "conversation")} removed entirely)`;
  const kept = r.kept
    ? c.dim(
        `\n  kept ${plural(r.kept, "older message")}: unread, unanswered, held or still in flight`,
      )
    : "";
  if (!r.messages) return `${c.dim("Nothing to prune.")}${kept}`;
  return `${r.dryRun ? `Would delete ${what}` : `${c.green("✓")} deleted ${what}`}${kept}`;
}

export const prune: Command = async (ctx) => {
  const { values } = parse(ctx.argv, {
    "older-than": { type: "string" },
    "dry-run": { type: "boolean", short: "n" },
    yes: { type: "boolean", short: "y" },
  });
  if (!values["older-than"])
    throw new UsageError("usage: agentlink prune --older-than 30d [--dry-run] [--yes]");
  const olderThanMs = parseDuration(values["older-than"], 0, "d");
  if (olderThanMs < 3_600_000) throw new UsageError("--older-than must be at least 1h");
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const dryRun = Boolean(values["dry-run"]);
  if (!dryRun && !values.yes && !tty)
    throw new UsageError(
      "prune deletes history: add --yes (or see what it would delete with --dry-run)",
    );
  await ctx.client.ensureDaemon();
  const call = (dry: boolean) =>
    ctx.client.request<PruneResult>("POST", "/v1/prune", { olderThanMs, dryRun: dry });
  if (!dryRun && !values.yes) {
    const preview = await call(true);
    const say = (s: string) => (ctx.json ? process.stderr : process.stdout).write(`${s}\n`);
    say(pruneText(preview));
    if (!preview.messages) {
      if (ctx.json) process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
      return 0;
    }
    const rl = createInterface({
      input: process.stdin,
      output: ctx.json ? process.stderr : process.stdout,
    });
    const answer = (await rl.question("Delete them? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      say(c.dim("cancelled"));
      return 1;
    }
  }
  const res = await call(dryRun);
  out(ctx, res, () => pruneText(res));
  return 0;
};

export const notify: Command = async (ctx) => {
  const { positionals } = parse(ctx.argv, {});
  const sub = positionals[0] ?? "status";
  if (sub === "on" || sub === "off") {
    const desktop = sub === "on";
    // The setting is the user's: refuse from inside an agent session, before touching the file.
    const up = await ctx.client.health();
    if (up) {
      const who = await ctx.client.request<{ agent: { name: string } | null }>("GET", "/v1/whoami");
      if (who.agent)
        throw new ApiError(
          "forbidden",
          `only a person can change notifications (this runs inside the agent session "${who.agent.name}")`,
          403,
        );
    }
    const config = loadConfig(ctx.paths);
    config.notify = { ...config.notify, desktop };
    saveConfig(ctx.paths, config);
    if (up) await ctx.client.request("POST", "/v1/config/reload", {});
    out(ctx, { desktop }, () =>
      desktop
        ? `${c.green("✓")} desktop notifications on: mail for you and approvals needed ${c.dim("(check: agentlink notify test)")}`
        : `${c.green("✓")} desktop notifications off`,
    );
    return 0;
  }
  if (sub === "status") {
    const desktop = loadConfig(ctx.paths).notify.desktop;
    out(ctx, { desktop }, () =>
      desktop
        ? `desktop notifications ${c.green("on")} ${c.dim("(test: agentlink notify test · off: agentlink notify off)")}`
        : `desktop notifications ${c.dim("off")} ${c.dim("(turn on: agentlink notify on)")}`,
    );
    return 0;
  }
  if (sub === "test") {
    await ctx.client.ensureDaemon();
    const res = await ctx.client.request<{
      found: boolean;
      sent: boolean;
      notifier: string | null;
      enabled: boolean;
    }>("POST", "/v1/notify/test", {});
    out(ctx, res, () => {
      if (!res.found)
        return c.yellow(
          process.platform === "darwin"
            ? "No notifier found: agentlink uses osascript, which was not found on PATH."
            : "No notifier found: install notify-send (Debian/Ubuntu: sudo apt install libnotify-bin; Fedora: libnotify), or set AGENTLINK_NOTIFY_BIN for the daemon.",
        );
      const sent = res.sent
        ? `${c.green("✓")} sent a test notification ${c.dim(`via ${res.notifier}`)}`
        : c.yellow(`could not run ${res.notifier}`);
      return res.enabled
        ? sent
        : `${sent}\n${c.dim("notifications are off; turn on: agentlink notify on")}`;
    });
    return res.sent ? 0 : 1;
  }
  throw new UsageError(
    `unknown notify command "${sub}"${didYouMean(sub, ["on", "off", "test", "status"])}; use: agentlink notify on|off|test|status`,
  );
};
