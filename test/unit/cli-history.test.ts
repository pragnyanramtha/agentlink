import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { filterQuery, timeParam } from "../../src/cli/args.ts";
import {
  type Overview,
  overviewText,
  searchText,
  threadsText,
} from "../../src/cli/commands/history.ts";
import { mark } from "../../src/cli/format.ts";
import { commandHelp, OVERVIEW } from "../../src/cli/help.ts";

process.env.NO_COLOR = "1";

const ID = "01M4JEY9QC7EABCDEFGHJKMNPQ";
const now = Date.parse("2026-09-01T12:00:00Z");
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

const ov = (over: Partial<Overview> = {}): Overview => ({
  version: "1.2.3",
  pid: 42,
  handle: "pik",
  host: "orin",
  paused: false,
  team: null,
  agents: { local: { busy: 1, idle: 1, offline: 2 }, remote: { busy: 0, idle: 0, offline: 0 } },
  unread: 0,
  todo: 0,
  held: 0,
  outbox: 0,
  db: { messages: 12, bytes: 40_960 },
  ...over,
});
const thread = (over: Record<string, unknown> = {}) => ({
  thread: ID,
  subject: "which port does the dev server use?",
  participants: ["@pik", "codex"],
  messages: 2,
  lastAt: minutesAgo(3),
  lastFrom: "codex",
  lastPreview: "8080",
  open: true,
  unread: 1,
  ...over,
});

describe("overview", () => {
  const agents = [
    { name: "claude", state: "busy", status: "fixing the login redirect", local: true },
    { name: "codex", state: "idle", status: null, local: true },
    { name: "alice/claude", state: "busy", status: null, local: false, member: "alice" },
  ];

  it("shows who is here, by machine, with state dots", () => {
    const text = overviewText(
      ov({
        team: { name: "acme", relay: "wss://r", connected: true, members: 2, membersOnline: 2 },
        agents: {
          local: { busy: 1, idle: 1, offline: 2 },
          remote: { busy: 1, idle: 0, offline: 0 },
        },
      }),
      agents,
      [],
      now,
    );
    const lines = text.split("\n");
    expect(lines[0]).toContain("@pik");
    expect(lines[0]).toContain("1.2.3");
    expect(lines[0]).toContain("team acme");
    expect(lines[0]).toContain("connected");
    expect(text).toContain("● claude");
    expect(text).toContain("○ codex");
    expect(text).toContain("fixing the login redirect");
    expect(text).toMatch(/alice\s+● claude/);
    expect(text).toContain("2 offline");
    expect(text).not.toContain("paused");
  });

  it("puts a paused banner, counts, held approvals and open conversations up front", () => {
    const text = overviewText(
      ov({ paused: true, unread: 2, todo: 1, held: 3 }),
      agents,
      [thread()],
      now,
    );
    expect(text.split("\n")[1]).toContain("paused");
    expect(text).toContain("2 unread");
    expect(text).toContain("1 waiting for your answer");
    expect(text).toContain("3 held");
    expect(text).toContain("agentlink approvals");
    expect(text).toContain("01M4JEY9QC7E");
    expect(text).toContain("which port does the dev server use?");
    expect(text).toContain("3m ago");
    expect(text).toContain("agentlink ui");
  });

  it("tells a fresh install what to do next", () => {
    const empty = { busy: 0, idle: 0, offline: 0 };
    const text = overviewText(ov({ agents: { local: empty, remote: empty } }), [], [], now);
    expect(text).toContain("no agents yet");
    expect(text).toMatch(/restart your agent sessions/);
    expect(text).toContain("no team");
    expect(text.match(/^→ /gm)?.length).toBeLessThanOrEqual(3);
  });

  it("says when the relay is unreachable", () => {
    const text = overviewText(
      ov({
        team: { name: "acme", relay: "wss://r", connected: false, members: 3, membersOnline: 1 },
      }),
      agents.slice(0, 2),
      [],
      now,
    );
    expect(text.split("\n")[0]).toContain("offline");
  });
});

describe("search output", () => {
  const row = {
    id: ID,
    thread: ID,
    kind: "ask",
    from: "alpha",
    to: ["beta"],
    createdAt: minutesAgo(5),
    snippet: "is the «zebra» protocol\nready?",
    tokens: 9,
  };
  it("is a compact table with the match and the next steps", () => {
    const text = searchText({ results: [row], fts: true }, "zebra", 20, now);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^ID\s+WHEN\s+KIND\s+FROM → TO\s+TOKENS\s+MATCH$/);
    expect(lines[1]).toContain("01M4JEY9QC7E");
    expect(lines[1]).not.toContain(ID);
    expect(lines[1]).toContain("alpha → beta");
    expect(lines[1]).toContain("is the «zebra» protocol ready?");
    expect(text).toContain("agentlink thread <id>");
    expect(text).toContain("agentlink show <id>");
    expect(text).not.toContain("full-text index");
  });
  it("has an empty state and notes a plain-text fallback", () => {
    const text = searchText({ results: [], fts: false }, "zebra", 20, now);
    expect(text).toContain('No messages match "zebra"');
    expect(text).toContain("full-text index");
  });
  it("says how to see more when the page is full", () => {
    expect(searchText({ results: [row], fts: true }, "zebra", 1, now)).toContain("-n 2");
  });
  it("highlights matches on a terminal only", () => {
    expect(mark("a «b» c")).toBe("a «b» c");
    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;
    try {
      expect(mark("a «b» c")).toBe("a \u001b[1m\u001b[4mb\u001b[24m\u001b[22m c");
    } finally {
      delete process.env.FORCE_COLOR;
      process.env.NO_COLOR = "1";
    }
  });
});

describe("threads output", () => {
  it("lists conversations with badges and the latest message", () => {
    const text = threadsText([thread(), thread({ open: false, unread: 0, messages: 1 })], now);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^THREAD\s+LAST\s+WHO\s+MSGS\s+STATE\s+CONVERSATION$/);
    expect(lines[1]).toContain("01M4JEY9QC7E");
    expect(lines[1]).toContain("@pik, codex");
    expect(lines[1]).toContain("open");
    expect(lines[1]).toContain("1 unread");
    expect(lines[1]).toContain('codex: "8080"');
    expect(lines[2]).not.toContain("8080");
    expect(text).toContain("agentlink thread <id>");
  });
  it("has empty states", () => {
    expect(threadsText([], now)).toContain("No conversations yet");
    expect(threadsText([], now, true)).toContain("Nothing open");
  });
});

describe("history filters", () => {
  it("turns ages into times and passes dates through", () => {
    expect(timeParam("2d", now)).toBe(new Date(now - 2 * 86_400_000).toISOString());
    expect(timeParam("1h30m", now)).toBe(new Date(now - 5_400_000).toISOString());
    expect(timeParam("1w", now)).toBe(new Date(now - 7 * 86_400_000).toISOString());
    expect(timeParam("3", now)).toBe(new Date(now - 3 * 86_400_000).toISOString());
    expect(timeParam("2026-01-31")).toBe("2026-01-31");
    expect(() => timeParam("yesterday")).toThrow(/2026-01-31/);
  });
  it("builds the query and checks kinds", async () => {
    const q = await filterQuery({
      from: "codex",
      kind: "ask,handoff",
      thread: "01M4",
      repo: "api",
    });
    expect(Object.fromEntries(q)).toEqual({
      from: "codex",
      kind: "ask,handoff",
      thread: "01M4",
      repo: "api",
    });
    await expect(filterQuery({ kind: "question" })).rejects.toThrow(/--kind/);
  });
});

describe("help", () => {
  it("documents the new commands and lists them in the overview", () => {
    for (const name of ["overview", "dash", "search", "threads", "prune", "notify", "ui"])
      expect(commandHelp(name), name).toBeTruthy();
    for (const word of ["overview", "search", "threads", "prune", "notify", "ui"])
      expect(OVERVIEW).toMatch(new RegExp(`\\b${word}\\b`));
    for (const flag of ["--from", "--since", "--thread", "--repo"])
      expect(commandHelp("log")).toContain(flag);
  });
});

describe("cli process", () => {
  const home = mkdtempSync(join(tmpdir(), "agentlink-cli-history-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(import.meta.dirname, "../../src/cli/index.ts"), ...args], {
      env: { ...process.env, HOME: home, AGENTLINK_HOME: join(home, ".agentlink"), NO_COLOR: "1" },
      encoding: "utf8",
      input: "",
    });

  it("keeps bare agentlink unchanged when not on a terminal", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${OVERVIEW}\n`);
  });

  it("prune needs --yes away from a terminal, and a sane age", () => {
    const r = run("prune", "--older-than", "30d");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--yes");
    expect(run("prune").stderr).toContain("--older-than");
    expect(run("prune", "--older-than", "10m", "--yes").stderr).toContain("1h");
  });

  it("search and threads explain their usage", () => {
    expect(run("search").status).toBe(2);
    const t = run("threads", "01M4JEY9QC7E");
    expect(t.status).toBe(2);
    expect(t.stderr).toContain("agentlink thread 01M4JEY9QC7E");
    expect(run("search", "x", "--kind", "question").stderr).toContain("--kind");
  });

  it("notify on/off edits the config; status reads it", () => {
    expect(run("notify", "status").stdout).toContain("off");
    expect(run("notify", "on").status).toBe(0);
    const config = JSON.parse(readFileSync(join(home, ".agentlink", "config.json"), "utf8"));
    expect(config.notify.desktop).toBe(true);
    expect(run("notify").stdout).toContain("on");
    expect(JSON.parse(run("--json", "notify", "off").stdout)).toMatchObject({ desktop: false });
    expect(run("notify", "loud").status).toBe(2);
  });
});
