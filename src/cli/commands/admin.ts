import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadConfig, saveConfig } from "../../core/config.ts";
import { KINDS } from "../../core/envelope.ts";
import { POLICY_ACTIONS } from "../../core/policy.ts";
import { didYouMean } from "../../core/suggest.ts";
import { type Command, out, parse, UsageError } from "../args.ts";
import { ApiError, type Health } from "../client.ts";
import { c, indent, table } from "../format.ts";

export const init: Command = async (ctx) => {
  const { values } = parse(ctx.argv, { handle: { type: "string" } });
  const config = loadConfig(ctx.paths);
  if (values.handle) config.handle = values.handle.toLowerCase();
  saveConfig(ctx.paths, config);
  const health = await ctx.client.ensureDaemon();
  out(ctx, { config, health }, () =>
    [
      `${c.green("✓")} agentlink is ready. You are ${c.bold(`@${config.handle}`)} (home: ${ctx.paths.home}).`,
      "",
      "Next:",
      `  agentlink install all      ${c.dim("# wire up Claude Code, Codex, OpenCode, Gemini, …")}`,
      `  agentlink peers            ${c.dim("# see agents as they come online")}`,
      `  agentlink watch            ${c.dim("# live view of agent traffic")}`,
    ].join("\n"),
  );
  return 0;
};

async function waitDown(ctx: Parameters<Command>[0], ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await ctx.client.health(300))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export const daemon: Command = async (ctx) => {
  const { values, positionals } = parse(ctx.argv, { follow: { type: "boolean", short: "f" } });
  const sub = positionals[0] ?? "status";
  const describe = (h: Health) =>
    `agentlink daemon ${c.green("running")} · pid ${h.pid} · v${h.version} · ${h.agents} agent(s) online${h.paused ? c.yellow(" · paused") : ""}\n${c.dim(`  socket ${ctx.paths.socket}\n  log    ${ctx.paths.log}`)}`;
  switch (sub) {
    case "start": {
      const h = await ctx.client.ensureDaemon();
      out(ctx, h, () => describe(h));
      return 0;
    }
    case "status": {
      const h = await ctx.client.health();
      out(ctx, h ?? { ok: false }, () =>
        h
          ? describe(h)
          : `agentlink daemon ${c.dim("not running")} (start: agentlink daemon start)`,
      );
      return h ? 0 : 1;
    }
    case "stop": {
      if (!(await ctx.client.health())) {
        out(ctx, { ok: true, running: false }, () => c.dim("agentlink daemon is not running"));
        return 0;
      }
      await ctx.client.request("POST", "/v1/shutdown", {});
      const down = await waitDown(ctx);
      out(ctx, { ok: down }, () =>
        down ? `${c.green("✓")} daemon stopped` : c.yellow("daemon is still shutting down"),
      );
      return down ? 0 : 1;
    }
    case "restart": {
      if (await ctx.client.health()) {
        await ctx.client.request("POST", "/v1/shutdown", {});
        await waitDown(ctx);
      }
      const h = await ctx.client.ensureDaemon();
      out(ctx, h, () => describe(h));
      return 0;
    }
    case "logs": {
      if (!existsSync(ctx.paths.log)) {
        process.stdout.write(c.dim("no daemon log yet\n"));
        return 0;
      }
      const lines = readFileSync(ctx.paths.log, "utf8").trimEnd().split("\n");
      process.stdout.write(`${lines.slice(-50).join("\n")}\n`);
      if (values.follow) {
        let size = statSync(ctx.paths.log).size;
        watch(ctx.paths.log, () => {
          const next = statSync(ctx.paths.log).size;
          if (next > size) {
            const buf = readFileSync(ctx.paths.log).subarray(size);
            process.stdout.write(buf.toString("utf8"));
          }
          size = next;
        });
        await new Promise(() => {});
      }
      return 0;
    }
    default:
      throw new UsageError(
        `unknown daemon command "${sub}"${didYouMean(sub, ["start", "stop", "restart", "status", "logs"])}; use start|stop|restart|status|logs`,
      );
  }
};

export const policy: Command = async (ctx) => {
  const { positionals } = parse(ctx.argv, {});
  const [sub = "list", scope, ...assignments] = positionals;
  await ctx.client.ensureDaemon();
  if (sub === "list") {
    const res = await ctx.client.request<{
      defaults: Record<string, Record<string, string>>;
      overrides: { scope: string; kind: string; action: string }[];
    }>("GET", "/v1/policy");
    out(ctx, res, () => {
      const rows = Object.entries(res.defaults).map(([trust, kinds]) => [
        c.bold(trust),
        ...KINDS.map((k) => {
          const o = res.overrides.find((x) => x.scope === trust && x.kind === k);
          const action = o?.action ?? kinds[k] ?? "?";
          const colored =
            action === "deliver"
              ? c.green(action)
              : action === "hold"
                ? c.yellow(action)
                : c.red(action);
          return o ? `${colored}*` : colored;
        }),
      ]);
      const contacts = res.overrides.filter((o) => !(o.scope in res.defaults));
      return [
        table(rows, ["FROM", ...KINDS]),
        c.dim("* = override. Change with: agentlink policy set <scope> <kind>=deliver|hold|refuse"),
        ...contacts.map((o) => `${o.scope}: ${o.kind}=${o.action}`),
      ].join("\n");
    });
    return 0;
  }
  if (sub === "set" || sub === "reset") {
    if (!scope)
      throw new UsageError(
        "usage: agentlink policy set <scope> <kind>=<action>… | policy reset <scope> <kind>…",
      );
    for (const a of assignments) {
      const [kind, action] = sub === "set" ? a.split("=") : [a, undefined];
      if (!kind || !(KINDS as readonly string[]).includes(kind))
        throw new UsageError(`unknown kind "${kind}"`);
      if (sub === "set" && !(POLICY_ACTIONS as readonly string[]).includes(action ?? "")) {
        throw new UsageError(`action must be one of ${POLICY_ACTIONS.join(", ")}`);
      }
      await ctx.client.request("POST", "/v1/policy", {
        scope,
        kind,
        action: sub === "set" ? action : null,
      });
    }
    process.stdout.write(`${c.green("✓")} policy updated for ${scope}\n`);
    return 0;
  }
  throw new UsageError(
    `unknown policy command "${sub}"${didYouMean(sub, ["list", "set", "reset"])}; use: agentlink policy [list] | set <scope> <kind>=<action> | reset <scope> <kind>`,
  );
};

interface HeldItem {
  delivery: { id: number; to: string };
  message: { id: string; kind: string; from: string; createdAt: string };
  text: string;
}

export const approvals: Command = async (ctx) => {
  parse(ctx.argv, {});
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{ items: HeldItem[] }>("GET", "/v1/approvals");
  out(ctx, res, () =>
    res.items.length === 0
      ? c.dim("Nothing is waiting for approval.")
      : res.items
          .map(
            (i) =>
              `#${i.delivery.id} ${c.bold(i.message.kind)} ${c.cyan(i.message.from)} → ${i.delivery.to}\n${indent(i.text)}\n${c.dim(`  approve: agentlink approve ${i.delivery.id}   deny: agentlink deny ${i.delivery.id}`)}`,
          )
          .join("\n\n"),
  );
  return 0;
};

async function decide(ctx: Parameters<Command>[0], decision: "approve" | "deny"): Promise<number> {
  const { values, positionals } = parse(ctx.argv, { yes: { type: "boolean", short: "y" } });
  const [id] = positionals;
  if (!id) throw new UsageError(`usage: agentlink ${decision} <delivery-id>`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ApiError(
      "forbidden",
      `${decision} must be run by a human in an interactive terminal`,
      403,
    );
  }
  await ctx.client.ensureDaemon();
  if (!values.yes) {
    const held = await ctx.client.request<{ items: HeldItem[] }>("GET", "/v1/approvals");
    const key = id.replace(/^#/, "").toUpperCase();
    const matches = held.items.filter(
      (i) => String(i.delivery.id) === key || i.message.id.startsWith(key),
    );
    if (matches.length === 0) {
      throw new UsageError(`nothing held matches "${id}" (see: agentlink approvals)`);
    }
    if (matches.length > 1) {
      throw new UsageError(
        `"${id}" matches several held messages; use a number: ${matches.map((i) => `#${i.delivery.id}`).join(", ")}`,
      );
    }
    const item = matches[0] as HeldItem;
    process.stdout.write(
      `${c.bold(item.message.kind)} from ${item.message.from} to ${item.delivery.to}:\n${indent(item.text)}\n`,
    );
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${decision} #${id}? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      process.stdout.write(c.dim("cancelled\n"));
      return 1;
    }
  }
  await ctx.client.request("POST", `/v1/approvals/${encodeURIComponent(id.replace(/^#/, ""))}`, {
    decision,
  });
  process.stdout.write(
    `${c.green("✓")} ${decision === "approve" ? "approved; delivering" : "denied"} #${id}\n`,
  );
  return 0;
}

export const approve: Command = (ctx) => decide(ctx, "approve");
export const deny: Command = (ctx) => decide(ctx, "deny");

function control(action: "pause" | "resume" | "mute" | "unmute"): Command {
  return async (ctx) => {
    const { positionals } = parse(ctx.argv, {});
    const agent = positionals[0];
    if ((action === "mute" || action === "unmute") && !agent)
      throw new UsageError(`usage: agentlink ${action} <agent>`);
    await ctx.client.ensureDaemon();
    const res = await ctx.client.request("POST", "/v1/control", {
      action,
      ...(agent ? { agent } : {}),
    });
    out(ctx, res, () =>
      action === "pause"
        ? `${c.yellow("⏸")} agentlink paused: messages are queued but not delivered (resume: agentlink resume)`
        : action === "resume"
          ? `${c.green("▶")} agentlink resumed`
          : `${c.green("✓")} ${agent} ${action}d`,
    );
    return 0;
  };
}

export const pause = control("pause");
export const resume = control("resume");
export const mute = control("mute");
export const unmute = control("unmute");
