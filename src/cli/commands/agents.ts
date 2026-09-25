import { ancestry, findToolProcess } from "../../core/proc.ts";
import { type Command, out, parse, parseDuration, UsageError } from "../args.ts";
import { ago, c, stateColor, table } from "../format.ts";

interface AgentView {
  id: string;
  name: string;
  tool: string;
  state: string;
  stateAt: string;
  lastSeenAt: string;
  repo: string | null;
  branch: string | null;
  status: string | null;
  muted: boolean;
  capabilities: Record<string, boolean>;
  tmux?: string;
  local?: boolean;
  member?: string;
}

function reach(a: AgentView): string {
  const caps = a.capabilities ?? {};
  const bits = [];
  if (caps.push) bits.push("push");
  else if (caps.wake || a.tmux) bits.push("wake");
  if (caps.midTurn) bits.push("mid-turn");
  else if (caps.nextTurn) bits.push("next-turn");
  return bits.join(",") || "cli";
}

export const whoami: Command = async (ctx) => {
  parse(ctx.argv, {});
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{
    agent: AgentView | null;
    handle: string;
    paused: boolean;
  }>("GET", "/v1/whoami");
  out(ctx, res, () =>
    res.agent
      ? `${c.bold(res.agent.name)} (${res.agent.tool}, ${stateColor(res.agent.state)}) · owner @${res.handle}${res.paused ? c.yellow(" · agentlink is paused") : ""}`
      : `@${res.handle} (human, not inside an agent session)${res.paused ? c.yellow(" · agentlink is paused") : ""}`,
  );
  return 0;
};

export const peers: Command = async (ctx) => {
  const { values } = parse(ctx.argv, { all: { type: "boolean", short: "a" } });
  await ctx.client.ensureDaemon();
  const [res, who] = await Promise.all([
    ctx.client.request<{ agents: AgentView[] }>("GET", `/v1/agents${values.all ? "?all=1" : ""}`),
    ctx.client.request<{ agent: AgentView | null }>("GET", "/v1/whoami"),
  ]);
  out(ctx, res, () => {
    if (res.agents.length === 0) {
      return c.dim(
        values.all
          ? "No agents yet. Start an agent after `agentlink install`, or run `agentlink register` inside one."
          : "No agents online. (agentlink peers --all shows offline ones.)",
      );
    }
    return table(
      res.agents.map((a) => [
        c.bold(a.name) +
          (who.agent?.id === a.id ? c.dim(" (you)") : "") +
          (a.muted ? c.red(" muted") : ""),
        a.tool,
        stateColor(a.state),
        reach(a),
        (a.repo ?? "-").replace(/^github\.com\//, ""),
        a.branch ?? "-",
        a.status ?? "",
        c.dim(ago(a.state === "busy" || a.state === "idle" ? a.stateAt : a.lastSeenAt)),
      ]),
      ["NAME", "TOOL", "STATE", "REACH", "REPO", "BRANCH", "DOING", "SINCE"],
    );
  });
  return 0;
};

export const name: Command = async (ctx) => {
  const { values, positionals } = parse(ctx.argv, { agent: { type: "string" } });
  const [newName] = positionals;
  if (!newName) throw new UsageError("usage: agentlink name <new-name> [--agent <current-name>]");
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{ agent: AgentView }>("POST", "/v1/agents/rename", {
    name: newName,
    ...(values.agent ? { agent: values.agent } : {}),
  });
  out(ctx, res, () => `${c.green("✓")} this agent is now ${c.bold(res.agent.name)}`);
  return 0;
};

export const doing: Command = async (ctx) => {
  const { values, positionals } = parse(ctx.argv, { clear: { type: "boolean" } });
  const text = positionals.join(" ").trim();
  if (!text && !values.clear)
    throw new UsageError('usage: agentlink doing "<what you are working on>" | --clear');
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{ agent: AgentView }>("POST", "/v1/agents/status", {
    text: values.clear ? null : text,
  });
  out(ctx, res, () =>
    values.clear ? `${c.green("✓")} status cleared` : `${c.green("✓")} ${res.agent.name}: ${text}`,
  );
  return 0;
};

export const register: Command = async (ctx) => {
  const { values } = parse(ctx.argv, {
    tool: { type: "string", default: "generic" },
    name: { type: "string" },
    pid: { type: "string" },
    session: { type: "string" },
  });
  const tool = String(values.tool);
  let pid = values.pid ? Number(values.pid) : undefined;
  let pidStart: string | undefined;
  if (!pid) {
    const proc = findToolProcess(tool, ancestry(process.pid));
    pid = proc?.pid;
    pidStart = proc?.start;
  }
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{ agent: AgentView; created: boolean; resumed: boolean }>(
    "POST",
    "/v1/agents/register",
    {
      tool,
      cwd: process.cwd(),
      ...(pid ? { pid } : {}),
      ...(pidStart ? { pidStart } : {}),
      ...(values.name ? { name: values.name } : {}),
      ...(values.session ? { sessionId: values.session } : {}),
    },
  );
  out(ctx, res, () =>
    [
      `${c.green("✓")} registered ${c.bold(res.agent.name)} (${res.agent.tool})${res.resumed ? c.dim(" · resumed; queued mail will be delivered") : ""}`,
      c.dim("  check for messages with: agentlink inbox"),
    ].join("\n"),
  );
  return 0;
};

interface ClaimView {
  id: string;
  pattern: string;
  agent: string;
  reason: string | null;
  expires_at: string;
  repo_key: string;
}

export const claim: Command = async (ctx) => {
  const { values, positionals } = parse(ctx.argv, {
    ttl: { type: "string", default: "60m" },
    reason: { type: "string", short: "r" },
  });
  if (positionals.length === 0)
    throw new UsageError('usage: agentlink claim <path-or-glob>… [--ttl 60m] [--reason "…"]');
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{ claims: ClaimView[]; conflicts: ClaimView[] }>(
    "POST",
    "/v1/claims",
    {
      patterns: positionals,
      ttlMinutes: parseDuration(String(values.ttl), 3_600_000, "m") / 60_000,
      ...(values.reason ? { reason: values.reason } : {}),
    },
  );
  out(ctx, res, () =>
    [
      `${c.green("✓")} claimed ${positionals.join(", ")} ${c.dim(`(advisory, until ${new Date(res.claims[0]?.expires_at ?? Date.now()).toLocaleTimeString()})`)}`,
      ...res.conflicts.map((k) =>
        c.yellow(
          `  ! overlaps ${k.pattern} claimed by ${k.agent}${k.reason ? ` (${k.reason})` : ""}; coordinate with them first`,
        ),
      ),
    ].join("\n"),
  );
  return 0;
};

export const release: Command = async (ctx) => {
  const { values, positionals } = parse(ctx.argv, { all: { type: "boolean" } });
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{ released: number }>("POST", "/v1/claims/release", {
    ...(positionals.length ? { patterns: positionals } : {}),
    all: Boolean(values.all) || positionals.length === 0,
  });
  out(ctx, res, () => `${c.green("✓")} released ${res.released} claim(s)`);
  return 0;
};

export const claims: Command = async (ctx) => {
  parse(ctx.argv, {});
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{ claims: ClaimView[] }>("GET", "/v1/claims");
  out(ctx, res, () =>
    res.claims.length === 0
      ? c.dim("No active claims.")
      : table(
          res.claims.map((k) => [
            k.pattern,
            c.bold(k.agent),
            k.reason ?? "",
            c.dim(`until ${new Date(k.expires_at).toLocaleTimeString()}`),
            c.dim(k.repo_key),
          ]),
          ["PATTERN", "AGENT", "REASON", "EXPIRES", "REPO"],
        ),
  );
  return 0;
};
