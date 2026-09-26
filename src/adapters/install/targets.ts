import { existsSync, readlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { CanonicalEvent } from "../runtime.ts";
import { openCodePluginSource } from "./opencode-plugin.ts";
import { ONE_LINE, SKILL_MD } from "./skill.ts";
import {
  type FileChange,
  isAgentlinkCommand,
  isSymlinkTo,
  type JsonObject,
  type Plan,
  parseJsonConfig,
  readText,
  removeBlock,
  shq,
  toJson,
  upsertBlock,
} from "./util.ts";

export const INSTALL_TOOLS = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "devin",
  "agy",
  "copilot",
  "gemini",
] as const;
export type InstallTool = (typeof INSTALL_TOOLS)[number];

export interface InstallContext {
  /** OS home directory (tool configs live under it). */
  home: string;
  /** agentlink home (daemon socket, pending flags, shim). */
  agentlinkHome: string;
  socket: string;
  pendingDir: string;
  shim: string;
  scope: "user" | "project";
  projectDir?: string;
  /** Register the MCP server too (tools like peers/ask/reply as native tools). */
  mcp: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Plans against pending edits, so several tools touching one file compose. */
export class VirtualFs {
  readonly #files = new Map<
    string,
    { before: string | null; after: string | null; mode?: number; symlink?: boolean }
  >();

  read(path: string): string | null {
    const f = this.#files.get(path);
    return f ? f.after : readText(path);
  }

  write(path: string, after: string | null, mode?: number): void {
    const existing = this.#files.get(path);
    const before = existing ? existing.before : readText(path);
    this.#files.set(path, { before, after, ...(mode !== undefined ? { mode } : {}) });
  }

  symlink(path: string, target: string | null, current: string | null): void {
    this.#files.set(path, { before: current, after: target, symlink: true });
  }

  /** Drops a planned change (the file stays as it is). */
  revert(path: string): void {
    this.#files.delete(path);
  }

  changes(): FileChange[] {
    return [...this.#files.entries()]
      .filter(([, f]) => f.symlink || f.before !== f.after)
      .map(([path, f]) => ({
        path,
        before: f.before,
        after: f.after,
        ...(f.mode !== undefined ? { mode: f.mode } : {}),
        ...(f.symlink ? { symlink: true } : {}),
      }));
  }
}

/** The block agentlink adds to instruction files: one line; the details are in the skill. */
export const INSTRUCTIONS = ONE_LINE;

// ------------------------------------------------------------------ hook commands

interface HookCmd {
  tool: string;
  event: CanonicalEvent;
  /** Skip Node entirely unless mail is pending or the process is new (per-tool-call hooks). */
  fast?: boolean;
  /** The CLI expects a JSON object on stdout. */
  json?: boolean;
}

export function hookCommand(ctx: InstallContext, h: HookCmd): string {
  const shim = shq(ctx.shim);
  const bail = h.json ? "{ echo '{}'; exit 0; }" : "exit 0";
  // Run Node only if mail is pending, the agent is idle (so it gets marked busy), or unknown.
  const fast = h.fast
    ? `D=${shq(ctx.pendingDir)}; [ -e "$D/pid-$PPID" ] || [ -e "$D/idle-$PPID" ] || [ ! -e "$D/known-$PPID" ] || ${bail}; `
    : "";
  return `${fast}[ -x ${shim} ] || ${bail}; exec ${shim} hook ${h.tool} ${h.event}`;
}

type Obj = JsonObject;
// Missing values start empty; a value of another shape is left for the user to fix, never replaced.
const asObj = (v: unknown, what = "hooks"): Obj => {
  if (v === undefined || v === null) return {};
  if (typeof v === "object" && !Array.isArray(v)) return v as Obj;
  throw new Error(
    `"${what}" in this config is not an object; fix it by hand, then run install again`,
  );
};
const asArr = (v: unknown, what = "hooks"): unknown[] => {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  throw new Error(`"${what}" in this config is not a list; fix it by hand, then run install again`);
};

/** Claude-style `{ Event: [{ matcher?, hooks: [{ type, command, timeout }] }] }`: drop ours, add ours. */
function mergeGroupedHooks(
  hooks: Obj,
  wanted: Record<string, { command: string; matcher?: string }> | null,
): Obj {
  const out: Obj = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = asArr(groups)
      .map((g) => {
        const group = asObj(g);
        const inner = asArr(group.hooks).filter((h) => !isAgentlinkCommand(asObj(h).command));
        return { ...group, hooks: inner };
      })
      .filter((g) => asArr(g.hooks).length > 0);
    if (kept.length) out[event] = kept;
  }
  for (const [event, spec] of Object.entries(wanted ?? {})) {
    const group: Obj = {
      ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}),
      hooks: [{ type: "command", command: spec.command, timeout: 10 }],
    };
    out[event] = [...asArr(out[event]), group];
  }
  return out;
}

/** Cursor/Copilot flat `{ event: [{ command|bash, … }] }`. */
function mergeFlatHooks(
  hooks: Obj,
  wanted: Record<string, string> | null,
  entry: (command: string) => Obj,
): Obj {
  const out: Obj = {};
  for (const [event, list] of Object.entries(hooks)) {
    const kept = asArr(list).filter((h) => {
      const o = asObj(h);
      return !isAgentlinkCommand(o.command) && !isAgentlinkCommand(o.bash);
    });
    if (kept.length) out[event] = kept;
  }
  for (const [event, command] of Object.entries(wanted ?? {}))
    out[event] = [...asArr(out[event]), entry(command)];
  return out;
}

function editJson(fs: VirtualFs, path: string, edit: (json: Obj) => Obj | null): void {
  const before = fs.read(path);
  const json = parseJsonConfig(path, before);
  const after = edit(json);
  // A config that ends up empty ({}) after removing agentlink is removed as well.
  if (after === null || Object.keys(after).length === 0) {
    if (before !== null) fs.write(path, null);
    return;
  }
  const text = toJson(after);
  if (before !== null && JSON.stringify(parseJsonConfig(path, before)) === JSON.stringify(after))
    return;
  fs.write(path, text);
}

function setMcp(json: Obj, key: string, server: Obj | null): Obj {
  const servers = { ...asObj(json[key]) };
  if (server) servers.agentlink = server;
  else delete servers.agentlink;
  const next = { ...json, [key]: servers };
  if (Object.keys(servers).length === 0) delete next[key];
  return next;
}

function editBlock(fs: VirtualFs, path: string, install: boolean): void {
  const before = fs.read(path);
  if (install) {
    fs.write(path, upsertBlock(before, INSTRUCTIONS));
    return;
  }
  if (before === null) return;
  const after = removeBlock(before);
  fs.write(path, after === "" ? null : after);
}

// ------------------------------------------------------------------ per-tool plans

type Planner = (
  ctx: InstallContext,
  fs: VirtualFs,
  install: boolean,
) => Omit<Plan, "tool" | "changes">;

const dirOf = (ctx: InstallContext) =>
  ctx.scope === "project" ? (ctx.projectDir as string) : ctx.home;
const mcpServer = (ctx: InstallContext): Obj => ({ command: ctx.shim, args: ["mcp"] });

const claude: Planner = (ctx, fs, install) => {
  const base = ctx.scope === "project" ? join(dirOf(ctx), ".claude") : join(ctx.home, ".claude");
  const h = (event: CanonicalEvent, fast = false) =>
    hookCommand(ctx, { tool: "claude", event, fast });
  editJson(fs, join(base, "settings.json"), (json) => {
    const hooks = mergeGroupedHooks(
      asObj(json.hooks),
      install
        ? {
            SessionStart: { command: h("session-start") },
            UserPromptSubmit: { command: h("prompt-submit") },
            PostToolUse: { matcher: "*", command: h("post-tool", true) },
            Stop: { command: h("stop") },
            Notification: { command: h("notification") },
            SessionEnd: { command: h("session-end") },
          }
        : null,
    );
    const next: Obj = { ...json, hooks };
    if (Object.keys(hooks).length === 0) delete next.hooks;
    return next;
  });
  editBlock(
    fs,
    ctx.scope === "project" ? join(dirOf(ctx), "CLAUDE.md") : join(base, "CLAUDE.md"),
    install,
  );
  const steps: Plan["steps"] = [];
  const notes: string[] = [];
  if (ctx.mcp) {
    if (ctx.scope === "project") {
      editJson(fs, join(dirOf(ctx), ".mcp.json"), (json) =>
        setMcp(json, "mcpServers", install ? mcpServer(ctx) : null),
      );
      if (install)
        notes.push("Claude Code asks once to approve the project MCP server (.mcp.json).");
    } else {
      const registered = asObj(
        asObj(parseJsonConfig("~/.claude.json", readText(join(ctx.home, ".claude.json"))))
          .mcpServers,
      ).agentlink;
      if (install && !registered) {
        steps.push({
          cmd: ["claude", "mcp", "add", "-s", "user", "agentlink", "--", ctx.shim, "mcp"],
          why: "register the agentlink MCP server",
        });
      } else if (!install && registered) {
        steps.push({
          cmd: ["claude", "mcp", "remove", "-s", "user", "agentlink"],
          why: "remove the agentlink MCP server",
        });
      }
    }
  }
  return { steps, notes };
};

const codex: Planner = (ctx, fs, install) => {
  const base = ctx.scope === "project" ? join(dirOf(ctx), ".codex") : join(ctx.home, ".codex");
  const h = (event: CanonicalEvent, fast = false) =>
    hookCommand(ctx, { tool: "codex", event, fast });
  editJson(fs, join(base, "hooks.json"), (json) => {
    const hooks = mergeGroupedHooks(
      asObj(json.hooks),
      install
        ? {
            SessionStart: { command: h("session-start") },
            UserPromptSubmit: { command: h("prompt-submit") },
            PostToolUse: { command: h("post-tool", true) },
            Stop: { command: h("stop") },
          }
        : null,
    );
    const next: Obj = { ...json, hooks };
    if (Object.keys(hooks).length === 0 && Object.keys(json).length <= 1) return null;
    return next;
  });
  editBlock(
    fs,
    ctx.scope === "project" ? join(dirOf(ctx), "AGENTS.md") : join(base, "AGENTS.md"),
    install,
  );
  const notes: string[] = [];
  const steps: Plan["steps"] = [];
  if (ctx.scope === "user") {
    // `notify` is user-level only; agentlink uses it to learn that a turn finished.
    const tomlPath = join(base, "config.toml");
    const toml = fs.read(tomlPath);
    const marker = "# agentlink: turn-complete notifications";
    const ours = `notify = [${[ctx.shim, "hook", "codex", "turn-complete"].map((s) => JSON.stringify(s)).join(", ")}] ${marker}`;
    const lines = (toml ?? "").split("\n");
    const idx = lines.findIndex((l) => l.includes(marker));
    if (install) {
      const foreign = lines.findIndex((l) => /^\s*notify\s*=/.test(l) && !l.includes(marker));
      if (foreign >= 0) {
        notes.push(
          "Codex already has a `notify` program; agentlink relies on its Stop hook instead.",
        );
      } else if (idx < 0) {
        const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
        const at = firstTable < 0 ? lines.length : firstTable;
        lines.splice(at, 0, ours, ...(firstTable < 0 ? [] : [""]));
        fs.write(tomlPath, lines.join("\n"));
      } else if (lines[idx] !== ours) {
        lines[idx] = ours;
        fs.write(tomlPath, lines.join("\n"));
      }
    } else if (idx >= 0) {
      lines.splice(idx, lines[idx + 1] === "" ? 2 : 1);
      fs.write(tomlPath, lines.join("\n"));
    }
    if (ctx.mcp) {
      const has = /^\s*\[mcp_servers\.agentlink\]/m.test(toml ?? "");
      if (install && !has)
        steps.push({
          cmd: ["codex", "mcp", "add", "agentlink", "--", ctx.shim, "mcp"],
          why: "register the agentlink MCP server",
        });
      if (!install && has)
        steps.push({
          cmd: ["codex", "mcp", "remove", "agentlink"],
          why: "remove the agentlink MCP server",
        });
    }
  }
  if (install)
    notes.push("Codex runs new hooks only after you trust them: open Codex and run /hooks once.");
  return { steps, notes };
};

const opencode: Planner = (ctx, fs, install) => {
  const base =
    ctx.scope === "project" ? join(dirOf(ctx), ".opencode") : join(ctx.home, ".config", "opencode");
  fs.write(join(base, "plugin", "agentlink.ts"), install ? openCodePluginSource(ctx.socket) : null);
  if (ctx.mcp) {
    const cfg =
      ctx.scope === "project" ? join(dirOf(ctx), "opencode.json") : join(base, "opencode.json");
    editJson(fs, cfg, (json) =>
      setMcp(
        json,
        "mcp",
        install ? { type: "local", command: [ctx.shim, "mcp"], enabled: true } : null,
      ),
    );
  }
  editBlock(
    fs,
    ctx.scope === "project" ? join(dirOf(ctx), "AGENTS.md") : join(base, "AGENTS.md"),
    install,
  );
  return { steps: [], notes: [] };
};

const cursor: Planner = (ctx, fs, install) => {
  const base = join(dirOf(ctx), ".cursor");
  const h = (event: CanonicalEvent, fast = false) =>
    hookCommand(ctx, { tool: "cursor", event, fast, json: true });
  editJson(fs, join(base, "hooks.json"), (json) => {
    const hooks = mergeFlatHooks(
      asObj(json.hooks),
      install
        ? {
            sessionStart: h("session-start"),
            postToolUse: h("post-tool", true),
            stop: h("stop"),
            sessionEnd: h("session-end"),
          }
        : null,
      (command) => ({ command, timeout: 10 }),
    );
    const onlyOurs = Object.keys(json).every((k) => k === "version" || k === "hooks");
    if (!install && Object.keys(hooks).length === 0 && onlyOurs) return null;
    return { version: json.version ?? 1, ...json, hooks };
  });
  if (ctx.mcp)
    editJson(fs, join(base, "mcp.json"), (json) =>
      setMcp(json, "mcpServers", install ? mcpServer(ctx) : null),
    );
  if (ctx.scope === "project") editBlock(fs, join(dirOf(ctx), "AGENTS.md"), install);
  return { steps: [], notes: [] };
};

const devin: Planner = (ctx, fs, install) => {
  const h = (event: CanonicalEvent, fast = false) =>
    hookCommand(ctx, { tool: "devin", event, fast });
  const wanted = install
    ? {
        SessionStart: { command: h("session-start") },
        UserPromptSubmit: { command: h("prompt-submit") },
        PostToolUse: { matcher: "", command: h("post-tool", true) },
        Stop: { command: h("stop") },
        SessionEnd: { command: h("session-end") },
      }
    : null;
  const notes: string[] = [];
  if (ctx.scope === "project") {
    editJson(fs, join(dirOf(ctx), ".devin", "hooks.v1.json"), (json) => {
      const merged = mergeGroupedHooks(json, wanted);
      return Object.keys(merged).length ? merged : null;
    });
    if (ctx.mcp)
      editJson(fs, join(dirOf(ctx), ".devin", "mcp_config.json"), (json) =>
        setMcp(json, "mcpServers", install ? mcpServer(ctx) : null),
      );
    editBlock(fs, join(dirOf(ctx), "AGENTS.md"), install);
  } else {
    const base = join(ctx.home, ".config", "devin");
    editJson(fs, join(base, "config.json"), (json) => {
      const hooks = mergeGroupedHooks(asObj(json.hooks), wanted);
      const next: Obj = { ...json, hooks };
      if (Object.keys(hooks).length === 0) delete next.hooks;
      return next;
    });
    if (ctx.mcp)
      editJson(fs, join(base, "mcp_config.json"), (json) =>
        setMcp(json, "mcpServers", install ? mcpServer(ctx) : null),
      );
    if (install)
      notes.push(
        "Devin CLI also runs Claude Code hooks; agentlink detects Devin and ignores the duplicate.",
      );
  }
  return { steps: [], notes };
};

const agy: Planner = (ctx, fs, install) => {
  const base =
    ctx.scope === "project" ? join(dirOf(ctx), ".agents") : join(ctx.home, ".gemini", "config");
  const h = (event: CanonicalEvent, fast = false) =>
    hookCommand(ctx, { tool: "agy", event, fast, json: true });
  editJson(fs, join(base, "hooks.json"), (json) => {
    const next = { ...json };
    if (install) {
      next.agentlink = {
        enabled: true,
        PreInvocation: [{ type: "command", command: h("pre-model", true), timeout: 10 }],
        Stop: [{ type: "command", command: h("stop"), timeout: 10 }],
      };
    } else delete next.agentlink;
    return next;
  });
  if (ctx.mcp)
    editJson(fs, join(base, "mcp_config.json"), (json) =>
      setMcp(json, "mcpServers", install ? mcpServer(ctx) : null),
    );
  editBlock(
    fs,
    ctx.scope === "project"
      ? join(dirOf(ctx), "AGENTS.md")
      : join(ctx.home, ".gemini", "GEMINI.md"),
    install,
  );
  const notes =
    install && ctx.scope === "project"
      ? ["agy loads workspace hooks only in trusted folders."]
      : [];
  return { steps: [], notes };
};

const copilot: Planner = (ctx, fs, install) => {
  const h = (event: CanonicalEvent, fast = false) =>
    hookCommand(ctx, { tool: "copilot", event, fast, json: true });
  const file =
    ctx.scope === "project"
      ? join(dirOf(ctx), ".github", "hooks", "agentlink.json")
      : join(ctx.home, ".copilot", "hooks", "agentlink.json");
  const entry = (bash: string) => ({ type: "command", bash, timeoutSec: 10 });
  fs.write(
    file,
    install
      ? toJson({
          version: 1,
          hooks: {
            sessionStart: [entry(h("session-start"))],
            userPromptSubmitted: [entry(h("prompt-submit"))],
            postToolUse: [entry(h("post-tool", true))],
            agentStop: [entry(h("stop"))],
            notification: [entry(h("notification"))],
            sessionEnd: [entry(h("session-end"))],
          },
        })
      : null,
  );
  if (ctx.mcp && ctx.scope === "user") {
    editJson(fs, join(ctx.home, ".copilot", "mcp-config.json"), (json) =>
      setMcp(
        json,
        "mcpServers",
        install ? { type: "local", command: ctx.shim, args: ["mcp"], tools: ["*"] } : null,
      ),
    );
  }
  editBlock(
    fs,
    ctx.scope === "project"
      ? join(dirOf(ctx), "AGENTS.md")
      : join(ctx.home, ".copilot", "copilot-instructions.md"),
    install,
  );
  return { steps: [], notes: [] };
};

const gemini: Planner = (ctx, fs, install) => {
  const base = join(dirOf(ctx), ".gemini");
  const h = (event: CanonicalEvent, fast = false) =>
    hookCommand(ctx, { tool: "gemini", event, fast });
  editJson(fs, join(base, "settings.json"), (json) => {
    const hooks = mergeGroupedHooks(
      asObj(json.hooks),
      install
        ? {
            SessionStart: { command: h("session-start") },
            BeforeAgent: { command: h("prompt-submit") },
            AfterTool: { matcher: "*", command: h("post-tool", true) },
            AfterAgent: { command: h("stop") },
            SessionEnd: { command: h("session-end") },
          }
        : null,
    );
    let next: Obj = { ...json, hooks };
    if (Object.keys(hooks).length === 0) delete next.hooks;
    if (ctx.mcp) next = setMcp(next, "mcpServers", install ? mcpServer(ctx) : null);
    return next;
  });
  editBlock(fs, join(base, "GEMINI.md"), install);
  return { steps: [], notes: [] };
};

/** Where each tool's instruction block lives (several tools can share one file). */
export function instructionPath(tool: InstallTool, ctx: InstallContext): string | undefined {
  const project = ctx.scope === "project";
  const dir = dirOf(ctx);
  switch (tool) {
    case "claude":
      return project ? join(dir, "CLAUDE.md") : join(ctx.home, ".claude", "CLAUDE.md");
    case "codex":
      return project ? join(dir, "AGENTS.md") : join(ctx.home, ".codex", "AGENTS.md");
    case "opencode":
      return project ? join(dir, "AGENTS.md") : join(ctx.home, ".config", "opencode", "AGENTS.md");
    case "cursor":
    case "devin":
      return project ? join(dir, "AGENTS.md") : undefined;
    case "agy":
      return project ? join(dir, "AGENTS.md") : join(ctx.home, ".gemini", "GEMINI.md");
    case "copilot":
      return project
        ? join(dir, "AGENTS.md")
        : join(ctx.home, ".copilot", "copilot-instructions.md");
    case "gemini":
      return join(dir, ".gemini", "GEMINI.md");
  }
}

/** Where each tool loads skills from (the same SKILL.md format everywhere); gemini has none. */
export function skillPath(tool: InstallTool, ctx: InstallContext): string | undefined {
  const project = ctx.scope === "project";
  const dir = dirOf(ctx);
  const at = (base: string) => join(base, "agentlink", "SKILL.md");
  switch (tool) {
    case "claude":
      return at(project ? join(dir, ".claude", "skills") : join(ctx.home, ".claude", "skills"));
    case "codex":
      return at(project ? join(dir, ".agents", "skills") : join(ctx.home, ".codex", "skills"));
    case "opencode":
      return at(
        project
          ? join(dir, ".opencode", "skills")
          : join(ctx.home, ".config", "opencode", "skills"),
      );
    case "devin":
      return at(
        project ? join(dir, ".devin", "skills") : join(ctx.home, ".config", "devin", "skills"),
      );
    case "agy":
      return at(project ? join(dir, ".agents", "skills") : join(ctx.home, ".agents", "skills"));
    case "cursor":
      return at(project ? join(dir, ".cursor", "skills") : join(ctx.home, ".cursor", "skills"));
    case "copilot":
      return at(project ? join(dir, ".github", "skills") : join(ctx.home, ".copilot", "skills"));
    case "gemini":
      return undefined;
  }
}

/** True if the tool has agentlink wiring (hooks, plugin, MCP) beyond instruction files. */
export function isWired(tool: InstallTool, ctx: InstallContext): boolean {
  const fs = new VirtualFs();
  planTool(tool, { ...ctx, mcp: false }, fs, false);
  return fs.changes().some((ch) => !ch.path.endsWith(".md"));
}

const PLANNERS: Record<InstallTool, Planner> = {
  claude,
  codex,
  opencode,
  cursor,
  devin,
  agy,
  copilot,
  gemini,
};

export const TOOL_BINARIES: Record<InstallTool, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  opencode: ["opencode"],
  cursor: ["cursor-agent", "agent"],
  devin: ["devin"],
  agy: ["agy"],
  copilot: ["copilot"],
  gemini: ["gemini"],
};

function linkTarget(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

export function onPath(names: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return undefined;
}

/** The launcher every hook and MCP config points at, plus a PATH link so agents can run `agentlink`. */
export function planCore(
  ctx: InstallContext,
  fs: VirtualFs,
  install: boolean,
  launcher: { node: string; entry: string },
): string[] {
  const notes: string[] = [];
  // Hooks run with the agent's environment; pin the home this launcher was installed for.
  const body = `#!/bin/sh\n# agentlink launcher (written by \`agentlink install\`)\n: "\${AGENTLINK_HOME:=${ctx.agentlinkHome.replace(/(["\\$`])/g, "\\$1")}}"\nexport AGENTLINK_HOME\nexec ${shq(launcher.node)} ${shq(launcher.entry)} "$@"\n`;
  fs.write(ctx.shim, install ? body : null, 0o755);
  const localBin = join(ctx.home, ".local", "bin");
  const link = join(localBin, "agentlink");
  const path = ctx.env?.PATH ?? process.env.PATH ?? "";
  const onPathDir = path.split(delimiter).includes(localBin);
  if (install) {
    if (!onPathDir) {
      notes.push(`Add ${join(ctx.agentlinkHome, "bin")} to PATH so agents can run \`agentlink\`.`);
    } else if (existsSync(link) && !isSymlinkTo(link, ctx.shim)) {
      const target = linkTarget(link);
      notes.push(
        target?.endsWith("/bin/agentlink")
          ? `agentlink is already on PATH (${link} → ${target}); leaving it.`
          : `${link} exists and is not agentlink's; leaving it alone.`,
      );
    } else if (!isSymlinkTo(link, ctx.shim)) {
      fs.symlink(link, ctx.shim, null);
    }
  } else if (isSymlinkTo(link, ctx.shim)) {
    fs.symlink(link, null, ctx.shim);
  }
  return notes;
}

export function planTool(
  tool: InstallTool,
  ctx: InstallContext,
  fs: VirtualFs,
  install: boolean,
): Omit<Plan, "changes"> {
  const result = PLANNERS[tool](ctx, fs, install);
  const skill = skillPath(tool, ctx);
  if (skill) {
    const before = fs.read(skill);
    if (install) fs.write(skill, SKILL_MD);
    else if (before !== null) fs.write(skill, null);
  }
  return { tool, ...result };
}
