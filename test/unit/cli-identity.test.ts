import { describe, expect, it } from "vitest";
import { type AgentView, identityText, peersText } from "../../src/cli/commands/agents.ts";
import { overviewText } from "../../src/cli/commands/history.ts";

process.env.NO_COLOR = "1";

const agent = (over: Partial<AgentView> & Record<string, unknown> = {}): AgentView => ({
  id: "01A",
  name: "claude-api",
  tool: "claude",
  harness: "Claude Code",
  model: "claude-opus-4-5",
  modelShort: "opus-4.5",
  title: "fix login bug",
  project: "api",
  dir: "~/work/api",
  host: "laptop",
  tag: "3f9a",
  identity:
    'claude-api · Claude Code · opus-4.5 · ~/work/api (feat-login) · "fix login bug" · laptop',
  state: "idle",
  stateAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  repo: null,
  branch: "feat-login",
  status: null,
  muted: false,
  capabilities: {},
  local: true,
  ...over,
});

describe("peers", () => {
  const rows = [
    agent(),
    agent({
      id: "dev:codex-web",
      name: "bob/codex-web",
      address: "bob/codex-web",
      tool: "codex",
      harness: "Codex",
      modelShort: "gpt-5.1-codex",
      title: null,
      dir: "web",
      branch: null,
      host: "bob-desk",
      tag: "c01d",
      local: false,
      status: "reviewing PR 12",
    }),
  ];

  it("shows harness, model, folder (branch), session title, host and state", () => {
    const [head, mine, theirs] = peersText(rows, { team: true, you: "01A" }).split("\n");
    expect(head?.split(/\s{2,}/)).toEqual([
      "NAME",
      "HARNESS",
      "MODEL",
      "PROJECT/DIR",
      "SESSION",
      "HOST",
      "STATE",
      "DOING",
    ]);
    expect(mine).toMatch(
      /^claude-api \(you\)\s+Claude Code\s+opus-4\.5\s+~\/work\/api \(feat-login\)\s+fix login bug\s+laptop\s+idle/,
    );
    expect(theirs).toMatch(
      /^bob\/codex-web\s+Codex\s+gpt-5\.1-codex\s+web\s+-\s+bob-desk\s+idle\s+reviewing PR 12$/,
    );
    expect(mine).not.toContain("#3f9a"); // tags only with -l
  });

  it("-l adds the session tag, reach and since", () => {
    const out = peersText(rows, { long: true, team: true });
    expect(out.split("\n")[0]).toContain("REACH");
    expect(out).toContain("claude-api #3f9a");
    expect(out).toContain("bob/codex-web #c01d");
  });
});

describe("whoami and the overview", () => {
  it("whoami prints the identity line", () => {
    expect(identityText(agent(), "laptop")).toBe(
      'claude-api · Claude Code · opus-4.5 · ~/work/api (feat-login) · "fix login bug" · laptop',
    );
  });

  it("overview rows name the model", () => {
    const text = overviewText(
      {
        version: "1",
        pid: 1,
        handle: "pik",
        host: "laptop",
        paused: false,
        team: null,
        agents: {
          local: { busy: 0, idle: 1, offline: 0 },
          remote: { busy: 0, idle: 0, offline: 0 },
        },
        unread: 0,
        todo: 0,
        held: 0,
        outbox: 0,
        db: { messages: 0, bytes: 0 },
      },
      [{ name: "claude-api", state: "idle", modelShort: "opus-4.5", local: true }],
      [],
    );
    expect(text).toContain("○ claude-api opus-4.5");
  });
});
