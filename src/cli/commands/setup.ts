import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  INSTALL_TOOLS,
  type InstallContext,
  type InstallTool,
  instructionPath,
  isWired,
  onPath,
  planCore,
  planTool,
  skillPath,
  TOOL_BINARIES,
  VirtualFs,
  windowsInstalls,
} from "../../adapters/install/targets.ts";
import { applyChanges, renderDiff } from "../../adapters/install/util.ts";
import { probePeerLookup, ssBinary } from "../../core/peer.ts";
import { hasInterop, socketlessFs, wslVersion } from "../../core/wsl.ts";
import { type CliContext, type Command, out, parse, UsageError } from "../args.ts";
import { lastStartError, startHint } from "../client.ts";
import { c } from "../format.ts";

function launcher(): { node: string; entry: string } {
  const script = process.argv[1];
  if (!script) throw new Error("cannot locate the agentlink CLI entry point");
  return { node: process.execPath, entry: realpathSync(resolve(script)) };
}

function context(ctx: CliContext, opts: { project?: string; mcp: boolean }): InstallContext {
  const home = process.env.HOME || homedir();
  if (opts.project && !existsSync(resolve(opts.project))) {
    throw new UsageError(`project directory ${opts.project} does not exist`);
  }
  return {
    home,
    agentlinkHome: ctx.paths.home,
    socket: ctx.paths.socket,
    pendingDir: ctx.paths.pendingDir,
    shim: join(ctx.paths.home, "bin", "agentlink"),
    scope: opts.project ? "project" : "user",
    ...(opts.project ? { projectDir: resolve(opts.project) } : {}),
    mcp: opts.mcp,
    env: process.env,
  };
}

function resolveTools(names: string[], install: boolean): InstallTool[] {
  if (names.length === 0)
    throw new UsageError(`name the tools (${INSTALL_TOOLS.join(" ")}) or "all"`);
  if (names.includes("all")) {
    return install ? INSTALL_TOOLS.filter((t) => onPath(TOOL_BINARIES[t])) : [...INSTALL_TOOLS];
  }
  for (const n of names) {
    if (!(INSTALL_TOOLS as readonly string[]).includes(n)) {
      throw new UsageError(`unknown tool "${n}" (choose from: ${INSTALL_TOOLS.join(", ")}, all)`);
    }
  }
  return names as InstallTool[];
}

async function run(
  ctx: CliContext,
  install: boolean,
  report?: { changed: boolean },
): Promise<number> {
  const { values, positionals } = parse(ctx.argv, {
    project: { type: "string", short: "p" },
    "dry-run": { type: "boolean", short: "n" },
    "no-mcp": { type: "boolean" },
  });
  const tools = resolveTools(positionals, install);
  const ictx = context(ctx, {
    ...(values.project ? { project: values.project } : {}),
    mcp: !values["no-mcp"],
  });
  const fs = new VirtualFs();
  const notes: string[] = [];
  // The launcher is shared by every hook on this machine; only a user-level "uninstall all" removes it.
  const removeCore = !install && positionals.includes("all") && ictx.scope === "user";
  if (install || removeCore) notes.push(...planCore(ictx, fs, install, launcher()));
  const plans = tools.map((tool) => planTool(tool, ictx, fs, install));
  if (!install) {
    // Keep instruction blocks that tools we are not removing still use (e.g. a shared AGENTS.md).
    for (const other of INSTALL_TOOLS.filter((t) => !tools.includes(t))) {
      if (!isWired(other, ictx)) continue;
      for (const path of [instructionPath(other, ictx), skillPath(other, ictx)])
        if (path) fs.revert(path);
    }
  }
  const changes = fs.changes();
  const steps = plans.flatMap((p) => p.steps);
  notes.push(...plans.flatMap((p) => p.notes.map((n) => `${p.tool}: ${n}`)));

  if (values["dry-run"]) {
    const verb = (ch: (typeof changes)[number]) =>
      ch.symlink ? "link" : ch.before === null ? "create" : ch.after === null ? "delete" : "modify";
    const summary = [
      c.bold(
        `Would change ${changes.length} file(s)${steps.length ? ` and run ${steps.length} command(s)` : ""}:`,
      ),
      ...changes.map((ch) => `  ${verb(ch).padEnd(7)} ${ch.path}`),
      ...steps.map((st) => `  run     ${st.cmd.join(" ")}`),
      c.dim("Details follow. Nothing was changed."),
    ].join("\n");
    out(ctx, { changes, steps, notes }, () =>
      [
        ...(changes.length || steps.length ? [summary] : []),
        ...changes.map((ch) =>
          ch.symlink
            ? `symlink ${ch.path} → ${ch.after ?? "(removed)"}`
            : renderDiff(ch.path, ch.before, ch.after),
        ),
        ...steps.map((s) => `${c.cyan("run")} ${s.cmd.join(" ")}  ${c.dim(`# ${s.why}`)}`),
        ...notes.map((n) => c.dim(`note: ${n}`)),
        changes.length || steps.length ? "" : c.dim("Nothing to change."),
      ].join("\n\n"),
    );
    return 0;
  }

  const backupDir = join(ctx.paths.backupsDir, new Date().toISOString().replace(/[:.]/g, "-"));
  const applied = applyChanges(
    changes,
    backupDir,
    ictx.home,
    ictx.projectDir ? [ictx.projectDir] : [],
  );
  const failed: string[] = [];
  for (const step of steps) {
    const r = spawnSync(step.cmd[0] as string, step.cmd.slice(1), {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (r.status !== 0) {
      failed.push(
        `${step.cmd.join(" ")}: ${(r.stderr || r.stdout || String(r.error ?? "")).trim().slice(0, 200)}`,
      );
    }
  }
  if (install) await ctx.client.ensureDaemon().catch(() => undefined);
  const backedUp = existsSync(backupDir);
  if (report) report.changed = applied.length > 0;
  out(ctx, { tools, applied, steps, failed, notes, ...(backedUp ? { backupDir } : {}) }, () =>
    [
      `${c.green("✓")} ${install ? "installed" : "removed"} agentlink ${install ? "for" : "from"} ${tools.join(", ") || "(no tools found)"}${ictx.scope === "project" ? ` in ${ictx.projectDir}` : ""}`,
      ...applied.map((a) => c.dim(`  ${a.action.padEnd(8)} ${a.path}`)),
      ...steps
        .filter((st) => !failed.some((f) => f.startsWith(st.cmd.join(" "))))
        .map((st) => c.dim(`  ran      ${st.cmd.join(" ")}`)),
      ...failed.map((f) => c.yellow(`  ! ${f}`)),
      applied.length === 0 && steps.length === 0 ? c.dim("  nothing to change") : "",
      backedUp ? c.dim(`  backups: ${backupDir}`) : "",
      ...notes.map((n) => `  ${c.yellow("note")} ${n}`),
      install && applied.length
        ? "\nStart your agent sessions (restart running ones once so they load agentlink), then check: agentlink peers"
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return failed.length ? 1 : 0;
}

export const install: Command = (ctx) => run(ctx, true);
export const uninstall: Command = (ctx) => run(ctx, false);

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The git project around `cwd` if agentlink is wired into it (so doctor checks it without --project). */
function wiredProject(ctx: CliContext, cwd: string): string | undefined {
  let dir = resolve(cwd);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, ".git"))) {
      const pctx = context(ctx, { project: dir, mcp: false });
      return INSTALL_TOOLS.some((t) => isWired(t, pctx)) ? dir : undefined;
    }
    dir = dirname(dir);
  }
  return undefined;
}

/** The AGENTLINK_HOME a launcher script is pinned to, if it is one of ours. */
function launcherHome(path: string): string | undefined {
  try {
    const text = readFileSync(realpathSync(path), "utf8").slice(0, 2_000);
    const pinned = /AGENTLINK_HOME:=([^}"]+)/.exec(text)?.[1];
    if (pinned) return pinned;
    // An older launcher without a pinned home uses AGENTLINK_HOME or the default ~/.agentlink.
    return text.includes("agentlink launcher")
      ? join(process.env.HOME || homedir(), ".agentlink")
      : undefined;
  } catch {
    return undefined;
  }
}

const WINDOWS_AGENTS =
  'Windows installs. agentlink inside WSL only sees agents running inside WSL: install the CLI inside WSL, or use VS Code/Cursor Remote-WSL or Codex\'s "run in WSL"';

/** Agent CLIs found only as Windows installs (PATH entries on /mnt/<drive>). */
function windowsOnly(): string[] {
  return INSTALL_TOOLS.filter((t) => !onPath(TOOL_BINARIES[t])).flatMap((t) =>
    windowsInstalls(TOOL_BINARIES[t]),
  );
}

function wslRow(version: number): { ok: boolean | null; label: string; detail: string } {
  if (version === 1)
    return {
      ok: false,
      label: "WSL",
      detail:
        "WSL 1: agentlink cannot verify which agent is calling here; switch this distro to WSL 2 (in Windows PowerShell: wsl --set-version <distro> 2)",
    };
  return {
    ok: null,
    label: "WSL",
    detail: `WSL 2${hasInterop() ? "" : " (Windows interop is off: the web UI and notifications can't reach Windows)"}; agents running on Windows can't reach this agentlink`,
  };
}

export const doctor: Command = async (ctx) => {
  const { values } = parse(ctx.argv, { project: { type: "string", short: "p" } });
  const project = values.project ?? wiredProject(ctx, process.cwd());
  const ictx = context(ctx, { ...(project ? { project } : {}), mcp: true });
  const rows: { ok: boolean | null; label: string; detail: string }[] = [];
  if (project && !values.project) {
    rows.push({
      ok: null,
      label: "project",
      detail: `${project} (found from the current directory)`,
    });
  }
  let refused: string | undefined;
  const health = await ctx.client.health().catch((error: Error) => {
    refused = error.message;
    return undefined;
  });
  const startError = health || refused ? undefined : lastStartError(ctx.paths);
  const hint = startError && startHint(startError, ctx.paths);
  rows.push({
    ok: !!health,
    label: "daemon",
    detail: health
      ? `running (pid ${health.pid}, ${health.agents} agent(s) online)`
      : refused
        ? `running, but refuses this terminal: ${refused}`
        : startError
          ? `last start failed: ${startError}${hint ? `; ${hint}` : ""} (log: ${ctx.paths.log})`
          : "not running (agentlink daemon start)",
  });
  for (const dir of new Set([ctx.paths.home, dirname(ctx.paths.socket)])) {
    const fs = socketlessFs(dir);
    if (fs)
      rows.push({
        ok: false,
        label: "home",
        detail: `${dir} is on a ${fs} filesystem (a Windows drive?): Unix sockets don't work there; use a Linux path, e.g. export AGENTLINK_HOME=~/.agentlink`,
      });
  }
  rows.push({
    ok: executable(ictx.shim),
    label: "launcher",
    detail: executable(ictx.shim) ? ictx.shim : `missing ${ictx.shim} (agentlink install <tool>)`,
  });
  const wsl = wslVersion();
  if (wsl) rows.push(wslRow(wsl));
  if (process.platform === "linux") {
    // The same self-test the daemon runs at start: can the kernel name who holds a socket?
    const dir = mkdtempSync(join(tmpdir(), "agentlink-probe-"));
    const probe = await probePeerLookup(dir).finally(() =>
      rmSync(dir, { recursive: true, force: true }),
    );
    rows.push({
      ok: probe.state === "ok" ? true : probe.state === "inconclusive" ? null : false,
      label: "caller check",
      detail:
        probe.state === "ok"
          ? "verifies which agent is calling (kernel socket table via ss)"
          : probe.state === "missing"
            ? "'ss' is missing (install iproute2): agents' identities are not verified"
            : probe.state === "broken"
              ? `${probe.reason}: agents' identities are not verified. Fix: ${probe.remedy}`
              : `self-test inconclusive (${probe.reason})`,
    });
  }
  const windows = wsl ? windowsOnly() : [];
  if (windows.length)
    rows.push({
      ok: false,
      label: "windows CLIs",
      detail: `${windows.join(", ")}: ${WINDOWS_AGENTS}`,
    });
  if (process.platform === "linux" && health) {
    const unregistered = await unregisteredSessions(ctx);
    if (unregistered.length) {
      rows.push({
        ok: false,
        label: "sessions",
        detail: `not connected (started before setup?): ${unregistered.join(", ")}; restart them`,
      });
    }
  }
  const onPathAt = onPath(["agentlink"]);
  const pinned = onPathAt ? launcherHome(onPathAt) : undefined;
  const otherHome = !!pinned && resolve(pinned) !== resolve(ctx.paths.home);
  rows.push({
    ok: !!onPathAt && !otherHome,
    label: "PATH",
    detail: !onPathAt
      ? "agents cannot run `agentlink` (add ~/.agentlink/bin to PATH)"
      : otherHome
        ? `agentlink → ${onPathAt}, which uses ${pinned}, not ${ctx.paths.home}: agents would reach a different daemon`
        : `agentlink → ${onPathAt}`,
  });
  for (const tool of INSTALL_TOOLS) {
    const bin = onPath(TOOL_BINARIES[tool]);
    let pending = 0;
    let present = 0;
    try {
      const fs = new VirtualFs();
      planTool(tool, { ...ictx, mcp: false }, fs, true);
      pending = fs.changes().length;
      // Instruction files (AGENTS.md, …) are shared between CLIs; only tool-specific wiring counts.
      const rm = new VirtualFs();
      planTool(tool, { ...ictx, mcp: false }, rm, false);
      present = rm.changes().filter((ch) => !ch.path.endsWith(".md")).length;
    } catch (error) {
      rows.push({ ok: false, label: tool, detail: String((error as Error).message) });
      continue;
    }
    const where = project ? ` --project ${project}` : "";
    if (!bin)
      rows.push({
        ok: null,
        label: tool,
        detail: present ? "wired up, but the CLI is not on PATH" : "not installed",
      });
    else if (pending === 0) rows.push({ ok: true, label: tool, detail: `wired up (${bin})` });
    else if (present)
      rows.push({
        ok: false,
        label: tool,
        detail: `outdated wiring (agentlink install ${tool}${where})`,
      });
    else
      rows.push({
        ok: null,
        label: tool,
        detail: `not set up (agentlink install ${tool}${where})`,
      });
  }
  if (health?.paused)
    rows.push({ ok: false, label: "paused", detail: "delivery is paused (agentlink resume)" });
  if (health) {
    const t = await ctx.client
      .request<{
        team: { name: string; handle: string; relay: string; connected: boolean } | null;
      }>("GET", "/v1/team")
      .catch(() => ({ team: null }));
    rows.push(
      t.team
        ? {
            ok: t.team.connected,
            label: "team",
            detail: `${t.team.name} as @${t.team.handle} · relay ${t.team.relay} · ${t.team.connected ? "connected" : "not connected"}`,
          }
        : { ok: null, label: "team", detail: "not in a team (agentlink team --help)" },
    );
  }
  const errLog = join(ctx.paths.home, "hook-errors.log");
  if (existsSync(errLog) && Date.now() - statSync(errLog).mtimeMs < 24 * 3600_000) {
    const tail = readFileSync(errLog, "utf8").trimEnd().split("\n").slice(-3);
    rows.push({ ok: false, label: "hook errors", detail: tail.join(" | ") });
  }
  out(ctx, { rows }, () =>
    rows
      .map(
        (r) =>
          `${r.ok === null ? c.dim("-") : r.ok ? c.green("✓") : c.yellow("!")} ${r.label.padEnd(12)} ${r.ok === null ? c.dim(r.detail) : r.detail}`,
      )
      .join("\n"),
  );
  return rows.some((r) => r.ok === false) ? 1 : 0;
};

export const guide: Command = async (ctx) => {
  parse(ctx.argv, {});
  const { GUIDE } = await import("../../adapters/install/skill.ts");
  process.stdout.write(GUIDE);
  return 0;
};

/**
 * One step: start agentlink, wire up every agent CLI found on PATH, optionally join a team.
 * Non-interactive, so an agent can run it for its user (see /llms.txt).
 */
export const setup: Command = async (ctx) => {
  const { values } = parse(ctx.argv, {
    join: { type: "string" },
    handle: { type: "string" },
    project: { type: "string", short: "p" },
    "dry-run": { type: "boolean", short: "n" },
  });
  const quiet = { ...ctx, json: false };
  const { init } = await import("./admin.ts");
  const found = INSTALL_TOOLS.filter((t) => onPath(TOOL_BINARIES[t]));
  if (values["dry-run"]) {
    return run(
      {
        ...ctx,
        argv: ["all", "--dry-run", ...(values.project ? ["--project", values.project] : [])],
      },
      true,
    );
  }
  const lines: string[] = [];
  const report = { changed: false };
  const capture = async (fn: () => Promise<number>) => {
    const write = process.stdout.write.bind(process.stdout);
    let text = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      text += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      return { code: await fn(), text };
    } finally {
      process.stdout.write = write;
    }
  };
  const started = await capture(() =>
    init({ ...quiet, argv: values.handle ? ["--handle", values.handle] : [] }),
  );
  if (started.code !== 0) {
    process.stdout.write(started.text);
    return started.code;
  }
  lines.push(`${c.green("✓")} agentlink is running (${ctx.paths.home})`);
  if (process.platform === "linux" && !ssBinary()) {
    lines.push(
      c.yellow(
        "! 'ss' (package iproute2) is missing: agentlink cannot verify which agent is calling. Install it.",
      ),
    );
  }
  const wsl = wslVersion();
  if (wsl === 1) lines.push(c.yellow(`! ${wslRow(1).detail}`));
  const windows = wsl ? windowsOnly() : [];
  if (windows.length) lines.push(c.yellow(`! ${windows.join(", ")}: ${WINDOWS_AGENTS}`));
  if (found.length === 0) {
    lines.push(
      c.yellow(
        "No agent CLIs found on PATH (claude, codex, opencode, cursor-agent, agy, devin, copilot, gemini).",
      ),
    );
  } else {
    const installed = await capture(() =>
      run(
        { ...quiet, argv: ["all", ...(values.project ? ["--project", values.project] : [])] },
        true,
        report,
      ),
    );
    if (installed.code !== 0) {
      process.stdout.write(installed.text);
      return installed.code;
    }
    lines.push(
      `${c.green("✓")} set up for ${found.join(", ")} (hooks, skill, one line in their instruction files)`,
    );
    lines.push(c.dim("  backups: ~/.agentlink/backups · undo: agentlink uninstall all"));
  }
  // Shown before joining, so a failed join doesn't hide what was installed.
  if (values.join && !ctx.json) process.stdout.write(`${lines.splice(0).join("\n")}\n`);
  if (values.join) {
    await ctx.client.ensureDaemon();
    const joined = await ctx.client.request<{
      team: { name: string; handle: string };
      invitedBy?: { handle: string; fingerprint: string };
    }>(
      "POST",
      "/v1/team/join",
      { invite: values.join, ...(values.handle ? { handle: values.handle } : {}) },
      { timeoutMs: 30_000 },
    );
    lines.push(
      `${c.green("✓")} joined team ${joined.team.name} as @${joined.team.handle}${
        joined.invitedBy
          ? c.dim(
              ` (invited by @${joined.invitedBy.handle}, fingerprint ${joined.invitedBy.fingerprint})`,
            )
          : ""
      }`,
    );
  }
  lines.push(
    "",
    "Next:",
    ...(report.changed
      ? [
          "  restart running agent sessions once so they load agentlink (team changes need no restart)",
        ]
      : []),
    "  agentlink peers                  who is online",
    "  agentlink team invite            connect a friend or another machine (share the code)",
  );
  out(ctx, { tools: found, joined: !!values.join }, () => lines.join("\n"));
  return 0;
};

/** Agent CLI processes of this user that are running but not registered with agentlink. */
async function unregisteredSessions(ctx: CliContext): Promise<string[]> {
  const { readdirSync, statSync } = await import("node:fs");
  const uid = process.getuid?.();
  const { matchesTool, procInfo } = await import("../../core/proc.ts");
  const res = await ctx.client
    .request<{ agents: { pid?: number | null; local?: boolean }[] }>("GET", "/v1/agents?all=1")
    .catch(() => ({ agents: [] }));
  const known = new Set<number>();
  // A registered session and every process above it (wrappers/launchers) count as connected.
  const { ancestry } = await import("../../core/proc.ts");
  for (const a of res.agents) {
    if (a.local === false || !a.pid) continue;
    for (const p of ancestry(a.pid)) known.add(p.pid);
  }
  const tools = ["claude", "codex", "opencode", "cursor", "gemini", "copilot", "agy", "devin"];
  const found: string[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid || known.has(pid)) continue;
    try {
      if (statSync(`/proc/${pid}`).uid !== uid) continue;
    } catch {
      continue;
    }
    const info = procInfo(pid);
    if (!info) continue;
    const tool = tools.find((t) => matchesTool(t, info));
    if (!tool) continue;
    // Cursor's CLI binary is called "agent", a name other programs use too.
    if (tool === "cursor" && !/cursor/i.test(info.cmd.join(" "))) continue;
    // Only the session process itself, not its helpers (children of the same tool).
    const parent = procInfo(info.ppid);
    if (parent && matchesTool(tool, parent)) continue;
    found.push(`${tool} (pid ${pid})`);
    if (found.length >= 8) break;
  }
  return found;
}
