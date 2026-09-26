#!/usr/bin/env node
import "../core/quiet-warnings.ts";
import { resolvePaths } from "../core/paths.ts";
import { closest } from "../core/suggest.ts";
import { VERSION } from "../version.ts";
import type { CliContext, Command } from "./args.ts";
import { commandHelp, guideText, OVERVIEW, wantsHelp } from "./help.ts";

const COMMANDS: Record<string, () => Promise<Command>> = {
  send: async () => (await import("./commands/messaging.ts")).send,
  tell: async () => (await import("./commands/messaging.ts")).send,
  ask: async () => (await import("./commands/messaging.ts")).ask,
  reply: async () => (await import("./commands/messaging.ts")).reply,
  ack: async () => (await import("./commands/messaging.ts")).ack,
  inbox: async () => (await import("./commands/messaging.ts")).inbox,
  todo: async () => (await import("./commands/messaging.ts")).todo,
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
  unregister: async () => (await import("./commands/agents.ts")).unregister,
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
  guide: async () => (await import("./commands/setup.ts")).guide,
  team: async () => (await import("./commands/team.ts")).team,
  relay: async () => (await import("./commands/team.ts")).relay,
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
  if (argv[0] === "hook" && !wantsHelp(argv)) {
    const { runHook } = await import("./hook.ts");
    return runHook(resolvePaths(), argv[1] ?? "generic", argv[2] ?? "", argv[3]);
  }
  const globals = extractGlobals(argv);
  if (globals.home) process.env.AGENTLINK_HOME = globals.home;
  const [command, ...rest] = globals.rest;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${OVERVIEW}\n`);
    return 0;
  }
  if (command === "help") {
    const topic = rest.find((a) => !a.startsWith("-"));
    if (topic === "guide" || topic === "agents") {
      process.stdout.write(await guideText());
      return 0;
    }
    const text = topic ? commandHelp(topic) : OVERVIEW;
    if (!text) {
      process.stderr.write(`agentlink: no help for "${topic}"\n\n${OVERVIEW}\n`);
      return 2;
    }
    process.stdout.write(`${text}\n`);
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-v" || command === "-V") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (wantsHelp(rest)) {
    const text = commandHelp(command);
    if (text) {
      process.stdout.write(`${text}\n`);
      return 0;
    }
  }
  if (command === "mcp") {
    const { runMcpServer } = await import("../mcp/server.ts");
    await runMcpServer({ paths: resolvePaths(), ...(globals.as ? { as: globals.as } : {}) });
    return 0;
  }
  const load = COMMANDS[command];
  if (!load) {
    const guess = closest(command, [...Object.keys(COMMANDS), "mcp", "help", "version"]);
    process.stderr.write(
      `agentlink: unknown command "${command}"${guess ? ` (did you mean "${guess}"?)` : ""}\nRun "agentlink --help" for the list.\n`,
    );
    return 2;
  }
  const { Client } = await import("./client.ts");
  const paths = resolvePaths();
  const ctx: CliContext = {
    paths,
    // Human-readable output gets terminal-safe strings; --json stays exactly as sent.
    client: new Client(paths, { ...(globals.as ? { as: globals.as } : {}), clean: !globals.json }),
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
    const command = process.argv[2];
    process.stderr.write(`agentlink: ${error.message}\n`);
    if (usage && command && commandHelp(command)) {
      process.stderr.write(`Run "agentlink ${command} --help" for usage.\n`);
    }
    // 3 = "no answer (yet)": the daemon restarted mid-wait, but what was sent is kept.
    process.exitCode = usage ? 2 : error.code === "daemon_restarted" ? 3 : 1;
  });
