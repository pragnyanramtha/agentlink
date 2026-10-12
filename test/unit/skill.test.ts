import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GUIDE, ONE_LINE, SKILL_MD } from "../../src/adapters/install/skill.ts";
import { commandHelp } from "../../src/cli/help.ts";

/** `agentlink <cmd> …` inside one code span: the command and the rest of the span. */
const commandSpans = [...GUIDE.matchAll(/`agentlink ([a-z]+)([^`]*)`/g)].map((m) => ({
  cmd: m[1] as string,
  rest: m[2] as string,
}));

describe("agentlink guide (skill)", () => {
  it("documents only commands that exist", () => {
    expect(commandSpans.length).toBeGreaterThan(20);
    for (const { cmd } of commandSpans) expect(commandHelp(cmd), cmd).toBeDefined();
  });

  it("documents only flags the command accepts", () => {
    for (const { cmd, rest } of commandSpans) {
      const help = commandHelp(cmd) ?? "";
      for (const flag of rest.match(/(?<![\w-])--[a-z][a-z-]*/g) ?? [])
        expect(help, `agentlink ${cmd} ${flag}`).toContain(flag);
    }
  });

  it("maps every MCP tool", () => {
    const source = readFileSync(new URL("../../src/mcp/server.ts", import.meta.url), "utf8");
    const tools = [...source.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) expect(GUIDE, tool).toMatch(new RegExp(`\\b${tool}\\b`));
    const listed = /\(tools: ([^)]*)\)/.exec(commandHelp("mcp") ?? "")?.[1]?.split(/[\s,]+/);
    expect(listed?.sort()).toEqual([...tools].sort());
  });

  it("keeps the trust rules and stays lean", () => {
    expect(GUIDE).toContain('only `trust="user"` is your user');
    expect(GUIDE).toContain("agentlink whoami");
    expect(GUIDE).toMatch(/never put a code in a message/);
    expect(GUIDE.length).toBeLessThan(6_000);
    expect(ONE_LINE).toContain('trust="user"');
  });

  it("has the frontmatter skill loaders expect", () => {
    const [, front, body] = SKILL_MD.split(/^---$/m);
    expect(front).toMatch(/^\nname: agentlink\ndescription: [^\n]+\n$/);
    expect((front?.match(/description: (.*)/)?.[1] ?? "").length).toBeLessThan(1_024);
    expect(body?.trim().startsWith("# agentlink")).toBe(true);
  });
});
