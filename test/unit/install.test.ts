import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hookCommand,
  INSTALL_TOOLS,
  type InstallContext,
  planCore,
  planTool,
  VirtualFs,
} from "../../src/adapters/install/targets.ts";
import { applyChanges, removeBlock, upsertBlock } from "../../src/adapters/install/util.ts";

let home: string;
let ctx: InstallContext;

const ORCA = "if [ -f '/x/claude-hook.sh' ]; then /bin/sh '/x/claude-hook.sh'; fi";

function seed(path: string, content: unknown) {
  const full = join(home, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}
const read = (path: string) => readFileSync(join(home, path), "utf8");
const json = (path: string) => JSON.parse(read(path));

function applyAll(install: boolean) {
  const fs = new VirtualFs();
  planCore(ctx, fs, install, { node: "/usr/bin/node", entry: "/opt/agentlink/dist/cli/index.js" });
  for (const tool of INSTALL_TOOLS) planTool(tool, ctx, fs, install);
  const changes = fs.changes();
  applyChanges(changes, join(home, ".agentlink", "backups", "t"), home);
  return changes;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentlink-install-"));
  ctx = {
    home,
    agentlinkHome: join(home, ".agentlink"),
    socket: join(home, ".agentlink", "run", "agentlink.sock"),
    pendingDir: join(home, ".agentlink", "run", "pending"),
    shim: join(home, ".agentlink", "bin", "agentlink"),
    scope: "user",
    mcp: true,
    env: { PATH: `${join(home, ".local", "bin")}:/usr/bin:/bin` },
  };
  seed(".claude/settings.json", {
    theme: "dark",
    hooks: { Stop: [{ hooks: [{ type: "command", command: ORCA }] }] },
  });
  seed(".codex/hooks.json", {
    hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: ORCA }] }] },
  });
  seed(".codex/config.toml", 'model = "gpt-5"\n\n[projects."/home/x"]\ntrust_level = "trusted"\n');
  seed(".cursor/hooks.json", { version: 1, hooks: { stop: [{ command: ORCA }] } });
  seed(".gemini/config/hooks.json", {
    "orca-status": { Stop: [{ type: "command", command: ORCA }] },
  });
  seed(".config/opencode/opencode.json", {
    $schema: "https://opencode.ai/config.json",
    mcp: { other: { type: "local", command: ["x"] } },
  });
  seed(".config/devin/config.json", {
    version: 1,
    hooks: { Stop: [{ hooks: [{ type: "command", command: ORCA }] }] },
  });
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("install planning", () => {
  it("adds agentlink next to existing hooks, is idempotent, and uninstall restores the originals", () => {
    const originals = {
      claude: json(".claude/settings.json"),
      codexHooks: json(".codex/hooks.json"),
      codexToml: read(".codex/config.toml"),
      cursor: json(".cursor/hooks.json"),
      agy: json(".gemini/config/hooks.json"),
      opencode: json(".config/opencode/opencode.json"),
      devin: json(".config/devin/config.json"),
    };
    applyAll(true);

    const claude = json(".claude/settings.json");
    expect(claude.theme).toBe("dark");
    expect(claude.hooks.Stop).toHaveLength(2);
    expect(claude.hooks.Stop[0].hooks[0].command).toBe(ORCA);
    expect(claude.hooks.Stop[1].hooks[0].command).toContain("hook claude stop");
    expect(claude.hooks.PostToolUse[0].hooks[0].command).toContain("pid-$PPID");
    expect(read(".claude/CLAUDE.md")).toContain("<!-- agentlink:start -->");

    const toml = read(".codex/config.toml");
    const notifyAt = toml.indexOf("notify = [");
    expect(notifyAt).toBeGreaterThan(0);
    expect(notifyAt).toBeLessThan(toml.indexOf("[projects"));
    expect(json(".codex/hooks.json").hooks.PostToolUse).toHaveLength(2);

    const agy = json(".gemini/config/hooks.json");
    expect(Object.keys(agy)).toEqual(["orca-status", "agentlink"]);
    expect(agy.agentlink.PreInvocation[0].command).toContain("echo '{}'");

    expect(json(".cursor/hooks.json").hooks.stop).toHaveLength(2);
    expect(json(".config/opencode/opencode.json").mcp).toHaveProperty("other");
    expect(json(".config/opencode/opencode.json").mcp.agentlink.command).toEqual([ctx.shim, "mcp"]);
    expect(read(".config/opencode/plugin/agentlink.ts")).toContain(ctx.socket);
    expect(json(".copilot/hooks/agentlink.json").hooks.postToolUse[0].bash).toContain(
      "hook copilot post-tool",
    );
    expect(read(".agentlink/bin/agentlink")).toContain("/opt/agentlink/dist/cli/index.js");

    // second run changes nothing
    const again = new VirtualFs();
    planCore(ctx, again, true, {
      node: "/usr/bin/node",
      entry: "/opt/agentlink/dist/cli/index.js",
    });
    for (const tool of INSTALL_TOOLS) planTool(tool, ctx, again, true);
    expect(again.changes().filter((c) => !c.symlink)).toEqual([]);

    applyAll(false);
    expect(json(".claude/settings.json")).toEqual(originals.claude);
    expect(json(".codex/hooks.json")).toEqual(originals.codexHooks);
    expect(read(".codex/config.toml")).toBe(originals.codexToml);
    expect(json(".cursor/hooks.json")).toEqual(originals.cursor);
    expect(json(".gemini/config/hooks.json")).toEqual(originals.agy);
    expect(json(".config/opencode/opencode.json")).toEqual(originals.opencode);
    expect(json(".config/devin/config.json")).toEqual(originals.devin);
    expect(() => read(".copilot/hooks/agentlink.json")).toThrow();
    expect(() => read(".claude/CLAUDE.md")).toThrow();
  });

  it("refuses to rewrite a config it cannot parse", () => {
    seed(".cursor/hooks.json", "{ // comment\n }");
    expect(() => planTool("cursor", ctx, new VirtualFs(), true)).toThrow(/cannot safely edit/);
  });

  it("project scope writes into the project only", () => {
    const project = join(home, "proj");
    mkdirSync(project);
    const pctx: InstallContext = { ...ctx, scope: "project", projectDir: project };
    const fs = new VirtualFs();
    for (const tool of INSTALL_TOOLS) planTool(tool, pctx, fs, true);
    const paths = fs.changes().map((c) => c.path.replace(`${project}/`, ""));
    expect(paths.every((p) => !p.startsWith("/"))).toBe(true);
    expect(paths).toEqual(
      expect.arrayContaining([
        ".claude/settings.json",
        ".codex/hooks.json",
        ".opencode/plugin/agentlink.ts",
        ".cursor/hooks.json",
        ".devin/hooks.v1.json",
        ".agents/hooks.json",
        ".github/hooks/agentlink.json",
        "AGENTS.md",
        "CLAUDE.md",
      ]),
    );
  });
});

describe("markdown blocks", () => {
  it("upserts and removes the block without touching other text", () => {
    const once = upsertBlock("# Notes\n\nkeep me\n", "hello");
    expect(once).toContain("keep me");
    expect(upsertBlock(once, "hello")).toBe(once);
    expect(upsertBlock(once, "changed")).toContain("changed");
    expect(removeBlock(once)).toBe("# Notes\n\nkeep me\n");
    expect(removeBlock(upsertBlock(null, "x"))).toBe("");
  });
});

describe("hook fast path", () => {
  it("skips Node unless mail is pending or the process is new", () => {
    const pending = ctx.pendingDir;
    mkdirSync(pending, { recursive: true });
    const shim = join(home, "fake-shim");
    writeFileSync(shim, '#!/bin/sh\necho RAN "$@"\n', { mode: 0o755 });
    const cmd = hookCommand({ ...ctx, shim }, { tool: "claude", event: "post-tool", fast: true });
    const runSh = () => execFileSync("sh", ["-c", `${cmd}`], { encoding: "utf8" }).trim();
    // unknown process (no known-<ppid>): runs so it can register
    expect(runSh()).toBe("RAN hook claude post-tool");
    // `sh -c` run by execFileSync: $PPID is this test process
    writeFileSync(join(pending, `known-${process.pid}`), "agent-1");
    expect(runSh()).toBe("");
    writeFileSync(join(pending, `pid-${process.pid}`), "agent-1");
    expect(runSh()).toBe("RAN hook claude post-tool");
    // an idle agent must reach the daemon once so it is marked busy
    rmSync(join(pending, `pid-${process.pid}`));
    writeFileSync(join(pending, `idle-${process.pid}`), "agent-1");
    expect(runSh()).toBe("RAN hook claude post-tool");
    rmSync(join(pending, `idle-${process.pid}`));
    writeFileSync(join(pending, `pid-${process.pid}`), "agent-1");
    // JSON-contract tools print {} when skipping
    rmSync(join(pending, `pid-${process.pid}`));
    const jsonCmd = hookCommand(
      { ...ctx, shim },
      { tool: "agy", event: "pre-model", fast: true, json: true },
    );
    expect(execFileSync("sh", ["-c", jsonCmd], { encoding: "utf8" }).trim()).toBe("{}");
    // missing launcher fails open
    const gone = hookCommand(
      { ...ctx, shim: join(home, "missing") },
      { tool: "claude", event: "stop" },
    );
    expect(execFileSync("sh", ["-c", gone], { encoding: "utf8" }).trim()).toBe("");
  });
});
