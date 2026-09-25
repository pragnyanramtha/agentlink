#!/usr/bin/env node
import "../core/quiet-warnings.ts";
import { resolvePaths } from "../core/paths.ts";
import { VERSION } from "../version.ts";
import type { CliContext, Command } from "./args.ts";

const HELP = `agentlink ${VERSION}: let AI coding agents talk to each other

Talk
  agentlink peers [--all]                       who is online (busy/idle/offline) and what they do
  agentlink ask <agent> "<question>"            ask and wait for the answer (--timeout 110s, --no-wait)
  agentlink send <agent>[,…] "<message>"        send (--kind info|ask|request|handoff, --wait, --stdin)
  agentlink reply <id> "<answer>"               answer a message
  agentlink ack <id> [--accept|--decline]       acknowledge / accept or decline a handoff
  agentlink inbox [--all] [--wait 60s]          read your messages
  agentlink show <id> [--part N]                show a message (or one attachment)
  agentlink thread <id>                         show a whole conversation
  agentlink status [<id>]                       delivery receipts (queued/delivered/seen/replied)

Coordinate
  agentlink doing "<text>"                      tell peers what you are working on
  agentlink claim <glob>… [--ttl 60m]           advisory claim on files; release [<glob>…]; claims
  agentlink name <new-name>                     rename this agent
  agentlink register [--tool <t>] [--name n]    register an agent that has no hooks

Setup & control
  agentlink init [--handle <you>]               set up and start the daemon
  agentlink install <tool…|all> [--dry-run]     wire up claude codex opencode gemini copilot cursor kiro devin
  agentlink uninstall <tool…|all>               remove agentlink from those tools
  agentlink doctor                              check everything
  agentlink daemon start|stop|restart|status|logs
  agentlink watch | log                         live traffic | recent messages
  agentlink pause | resume | mute <agent> | unmute <agent>
  agentlink policy [list|set|reset]             who may send what (deliver/hold/refuse)
  agentlink approvals | approve <id> | deny <id>

Global flags: --json  --as <agent-name>  --home <dir>
Docs: agentlink-plan.md · SECURITY.md`;

const COMMANDS: Record<string, () => Promise<Command>> = {
  send: async () => (await import("./commands/messaging.ts")).send,
  tell: async () => (await import("./commands/messaging.ts")).send,
  ask: async () => (await import("./commands/messaging.ts")).ask,
  reply: async () => (await import("./commands/messaging.ts")).reply,
  ack: async () => (await import("./commands/messaging.ts")).ack,
  inbox: async () => (await import("./commands/messaging.ts")).inbox,
  show: async () => (await import("./commands/messaging.ts")).show,
  thread: async () => (await import("./commands/messaging.ts")).thread,
  status: async () => (await import("./commands/messaging.ts")).status,
  log: async () => (await import("./commands/messaging.ts")).log,
  watch: async () => (await import("./commands/messaging.ts")).watch,
  whoami: async () => (await import("./commands/agents.ts")).whoami,
  peers: async () => (await import("./commands/agents.ts")).peers,
  name: async () => (await import("./commands/agents.ts")).name,
  doing: async () => (await import("./commands/agents.ts")).doing,
  register: async () => (await import("./commands/agents.ts")).register,
  claim: async () => (await import("./commands/agents.ts")).claim,
  release: async () => (await import("./commands/agents.ts")).release,
  claims: async () => (await import("./commands/agents.ts")).claims,
  init: async () => (await import("./commands/admin.ts")).init,
  daemon: async () => (await import("./commands/admin.ts")).daemon,
  policy: async () => (await import("./commands/admin.ts")).policy,
  approvals: async () => (await import("./commands/admin.ts")).approvals,
  approve: async () => (await import("./commands/admin.ts")).approve,
  deny: async () => (await import("./commands/admin.ts")).deny,
  pause: async () => (await import("./commands/admin.ts")).pause,
  resume: async () => (await import("./commands/admin.ts")).resume,
  mute: async () => (await import("./commands/admin.ts")).mute,
  unmute: async () => (await import("./commands/admin.ts")).unmute,
  install: async () => (await import("./commands/setup.ts")).install,
  uninstall: async () => (await import("./commands/setup.ts")).uninstall,
  doctor: async () => (await import("./commands/setup.ts")).doctor,
};

/** Pulls global flags out of argv (anywhere on the line). */
function extractGlobals(argv: string[]): {
  rest: string[];
  json: boolean;
  as?: string;
  home?: string;
} {
  const rest: string[] = [];
  let json = false;
  let as: string | undefined;
  let home: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === "--json") json = true;
    else if (arg === "--as" || arg === "--home") {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      if (arg === "--as") as = value;
      else home = value;
      i++;
    } else if (arg.startsWith("--as=")) as = arg.slice(5);
    else if (arg.startsWith("--home=")) home = arg.slice(7);
    else rest.push(arg);
  }
  return { rest, json, ...(as ? { as } : {}), ...(home ? { home } : {}) };
}

async function main(argv: string[]): Promise<number> {
  // Hooks run on every tool call: keep this path free of heavy imports.
  if (argv[0] === "hook") {
    const { runHook } = await import("./hook.ts");
    return runHook(resolvePaths(), argv[1] ?? "generic", argv[2] ?? "", argv[3]);
  }
  const globals = extractGlobals(argv);
  if (globals.home) process.env.AGENTLINK_HOME = globals.home;
  const [command, ...rest] = globals.rest;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === "mcp") {
    const { runMcpServer } = await import("../mcp/server.ts");
    await runMcpServer({ paths: resolvePaths(), ...(globals.as ? { as: globals.as } : {}) });
    return 0;
  }
  const load = COMMANDS[command];
  if (!load) {
    process.stderr.write(`agentlink: unknown command "${command}"\n\n${HELP}\n`);
    return 2;
  }
  const { Client } = await import("./client.ts");
  const paths = resolvePaths();
  const ctx: CliContext = {
    paths,
    client: new Client(paths, globals.as ? { as: globals.as } : {}),
    json: globals.json,
    ...(globals.as ? { as: globals.as } : {}),
    argv: rest,
  };
  const run = await load();
  return run(ctx);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (error: Error & { code?: string }) => {
    const { UsageError } = await import("./args.ts");
    const usage = error instanceof UsageError;
    process.stderr.write(`agentlink: ${error.message}\n`);
    process.exitCode = usage ? 2 : 1;
  });
