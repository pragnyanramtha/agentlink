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
  overview: async () => (await import("./commands/history.ts")).overview,
  dash: async () => (await import("./commands/history.ts")).overview,
  search: async () => (await import("./commands/history.ts")).search,
  threads: async () => (await import("./commands/history.ts")).threads,
  prune: async () => (await import("./commands/history.ts")).prune,
  notify: async () => (await import("./commands/history.ts")).notify,
  ui: async () => (await import("./commands/ui.ts")).ui,
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
  headless: async () => (await import("./commands/headless.ts")).headless,
  spawn: async () => (await import("./commands/headless.ts")).spawn,
  wake: async () => (await import("./commands/headless.ts")).wake,
  runs: async () => (await import("./commands/headless.ts")).runs,
  stop: async () => (await import("./commands/headless.ts")).stop,
  install: async () => (await import("./commands/setup.ts")).install,
  uninstall: async () => (await import("./commands/setup.ts")).uninstall,
  doctor: async () => (await import("./commands/setup.ts")).doctor,
  guide: async () => (await import("./commands/setup.ts")).guide,
  setup: async () => (await import("./commands/setup.ts")).setup,
  team: async () => (await import("./commands/team.ts")).team,
  relay: async () => (await import("./commands/team.ts")).relay,
};

/** Pulls global flags out of argv (anywhere on the line). */
function extractGlobals(argv: string[]): {
  rest: string[];
  json: boolean;
  verbose: boolean;
  as?: string;
  home?: string;
} {
  const rest: string[] = [];
  let json = false;
  let verbose = false;
  let as: string | undefined;
  let home: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === "--json") json = true;
    else if (arg === "--verbose") verbose = true;
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
  return { rest, json, verbose, ...(as ? { as } : {}), ...(home ? { home } : {}) };
}

/** What failed, for error output: --json, and the most specific help page ("team invite"). */
const errOut = { json: false, help: undefined as string | undefined };

function fail(code: string, message: string, hint?: string): void {
  process.stderr.write(
    errOut.json
      ? `${JSON.stringify({ error: { code, message } })}\n`
      : `${code === "paused" ? "" : "agentlink: "}${message}\n${hint ? `${hint}\n` : ""}`,
  );
}

async function main(argv: string[]): Promise<number> {
  // Hooks run on every tool call: keep this path free of heavy imports.
  if (argv[0] === "hook" && !wantsHelp(argv)) {
    const { runHook } = await import("./hook.ts");
    return runHook(resolvePaths(), argv[1] ?? "generic", argv[2] ?? "", argv[3]);
  }
  const end = argv.indexOf("--");
  errOut.json = (end >= 0 ? argv.slice(0, end) : argv).includes("--json");
  const globals = extractGlobals(argv);
  if (globals.home) process.env.AGENTLINK_HOME = globals.home;
  const [command, ...rest] = globals.rest;
  const sub = rest[0] && !rest[0].startsWith("-") ? `${command} ${rest[0]}` : "";
  errOut.help = commandHelp(sub) ? sub : command && commandHelp(command) ? command : undefined;
  // Bare `agentlink` in a person's terminal: the dashboard, once agentlink is set up (a fresh
  // machine gets the help text). Agents (not a terminal) and --json get the help text, as before.
  if (!command && !globals.json && process.stdout.isTTY) {
    const { Client } = await import("./client.ts");
    const paths = resolvePaths();
    const client = new Client(paths, { ...(globals.as ? { as: globals.as } : {}), clean: true });
    const { existsSync } = await import("node:fs");
    const up = existsSync(paths.config) && (await client.ensureDaemon().catch(() => undefined));
    if (up) {
      const [{ showOverview }, { c }] = await Promise.all([
        import("./commands/history.ts"),
        import("./format.ts"),
      ]);
      const footer = `\n\n${c.dim("agentlink --help for all commands")}`;
      const ctx: CliContext = { paths, client, json: false, argv: [] };
      if (
        await showOverview(ctx, footer).then(
          () => true,
          () => false,
        )
      )
        return 0;
    }
  }
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
    const subtopic = rest.filter((a) => !a.startsWith("-"))[1];
    const text = topic
      ? (subtopic && commandHelp(`${topic} ${subtopic}`)) || commandHelp(topic)
      : OVERVIEW;
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
    const sub = rest.find((a) => !a.startsWith("-"));
    const text = (sub && commandHelp(`${command} ${sub}`)) || commandHelp(command);
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
    fail(
      "unknown_command",
      `unknown command "${command}"${guess ? ` (did you mean "${guess}"?)` : ""}`,
      'Run "agentlink --help" for the list.',
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
    verbose: globals.verbose,
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
    fail(
      usage ? "usage" : (error.code ?? "error"),
      error.message,
      usage && errOut.help ? `Run "agentlink ${errOut.help} --help" for usage.` : undefined,
    );
    // 3 = "no answer (yet)": the daemon restarted mid-wait, but what was sent is kept.
    process.exitCode = usage ? 2 : error.code === "daemon_restarted" ? 3 : 1;
  });
