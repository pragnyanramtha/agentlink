import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { optionalValue, parseDuration } from "../../src/cli/args.ts";
import {
  compactSend,
  logText,
  printItems,
  receipts,
  threadText,
  watchLine,
} from "../../src/cli/commands/messaging.ts";
import { printStatus } from "../../src/cli/commands/team.ts";
import { commandHelp, OVERVIEW } from "../../src/cli/help.ts";

process.env.NO_COLOR = "1";

const ID = "01M4JEY9QC7EABCDEFGHJKMNPQ";
const msg = (over: Record<string, unknown> = {}) => ({
  id: ID,
  thread: ID,
  kind: "info",
  from: "@tester",
  preview: "hello",
  createdAt: new Date().toISOString(),
  ...over,
});

describe("parseDuration", () => {
  it("accepts days and compound values", () => {
    expect(parseDuration("7d", 0)).toBe(7 * 86_400_000);
    expect(parseDuration("2m30s", 0)).toBe(150_000);
    expect(parseDuration("1h30m", 0)).toBe(5_400_000);
    expect(parseDuration("1d12h", 0)).toBe(36 * 3_600_000);
    expect(parseDuration("90", 0)).toBe(90_000);
    expect(parseDuration("2", 0, "h")).toBe(7_200_000);
    expect(parseDuration("500ms", 0)).toBe(500);
    expect(parseDuration(undefined, 42)).toBe(42);
    expect(() => parseDuration("bad", 0)).toThrow(/7d/);
    expect(() => parseDuration("1h30", 0)).toThrow();
  });
  it("lets --wait take a compound duration", () => {
    expect(optionalValue(["--wait", "1m30s", "x"], "wait")).toEqual(["--wait", "1m30s", "x"]);
    expect(optionalValue(["--wait", "codex"], "wait")).toEqual(["--wait=", "codex"]);
  });
});

describe("cli process", () => {
  const home = mkdtempSync(join(tmpdir(), "agentlink-cli-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(import.meta.dirname, "../../src/cli/index.ts"), ...args], {
      env: { ...process.env, HOME: home, AGENTLINK_HOME: join(home, ".agentlink"), NO_COLOR: "1" },
      encoding: "utf8",
      input: "",
    });

  it("points usage errors to the most specific help", () => {
    const r = run("team", "invite", "--ttl", "bad");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Run "agentlink team invite --help"');
    const s = run("send", "generic", "hi", "--ttl", "nope");
    expect(s.stderr).toContain('Run "agentlink send --help"');
  });

  it("prints --json errors as JSON on stderr, keeping exit codes", () => {
    const r = run("--json", "team", "invite", "--ttl", "bad");
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stderr)).toEqual({
      error: { code: "usage", message: expect.stringContaining("invalid duration") },
    });
    const u = run("--json", "sned");
    expect(u.status).toBe(2);
    expect(JSON.parse(u.stderr).error.code).toBe("unknown_command");
  });
});

describe("help", () => {
  it("lists --verbose and peers -l, and explains states and reach", () => {
    expect(OVERVIEW).toContain("--verbose");
    expect(OVERVIEW).toMatch(/peers \[--all\] \[-l\]/);
    for (const page of ["status", "peers"]) {
      const text = commandHelp(page) ?? "";
      for (const word of ["queued", "delivered", "held", "refused", "expired", "failed"])
        expect(text).toContain(word);
      for (const word of ["push", "wake", "mid-turn", "next-turn", "cli"])
        expect(text).toContain(word);
    }
    expect(commandHelp("team invite")).toContain("7d");
  });

  it("team empty state matches the README (community relay, invite starts a team)", () => {
    const text = printStatus({ team: null, members: [], agents: [] });
    expect(text).toContain("agentlink team invite");
    expect(text).toContain("agentlink team join <code>");
    expect(text).not.toContain("relay serve");
    expect(text).not.toContain("ws://<host>");
  });
});

describe("send output", () => {
  const res = (deliveries: Record<string, unknown>[]) => ({
    message: msg(),
    deliveries: deliveries as never,
    waited: false,
  });
  it("names the recipient and the short id", () => {
    expect(compactSend(res([{ id: 1, to: "generic", state: "queued", note: "queued" }]))).toBe(
      "✓ sent to generic · 01M4JEY9QC7E",
    );
  });
  it("shows notes without doubled parentheses", () => {
    const out = compactSend(
      res([{ id: 1, to: "generic", state: "queued", note: "queued (agentlink is paused)" }]),
    );
    expect(out).toBe("✓ sent to generic · 01M4JEY9QC7E · queued (agentlink is paused)");
  });
  it("says a local held message waits for approval here", () => {
    const out = compactSend(
      res([
        {
          id: 1,
          to: "generic",
          state: "held",
          note: "held until a person on that machine approves it (agentlink approvals)",
        },
      ]),
    );
    expect(out).not.toContain("that machine");
    expect(out).toContain("agentlink approvals");
  });
});

describe("message views", () => {
  const re = { id: "01M4JEY9QC7EXXXXXXXXXXXXXX", from: "codex", preview: "which port?" };
  it("inbox uses short ids, plain ack words and reply context", () => {
    const items = [
      {
        delivery: { id: 1, to: "generic", state: "delivered" },
        message: msg({ kind: "ask" }),
        text: "which port?",
        attachments: [],
      },
      {
        delivery: { id: 2, to: "generic", state: "delivered" },
        message: msg({ kind: "ack", id: "01M4JFBRP5HB3D73893BWHQ0P3", re }),
        text: "on it",
        attachments: [],
        ack: "accept",
      },
    ];
    const out = printItems(items as never);
    expect(out).not.toContain(ID);
    expect(out).toContain(`agentlink reply 01M4JEY9QC7E "<answer>"`);
    expect(out).toContain("[accepted] on it");
    expect(out).toContain('re: "which port?" (codex)');
    expect(printItems([], true)).not.toContain("new");
    expect(printItems([])).toContain("No new messages");
  });

  it("thread shows ack values and accepted/declined delivery states", () => {
    const handoff = msg({ kind: "handoff", preview: "take it" });
    const out = threadText({
      thread: ID,
      messages: [
        {
          message: handoff,
          text: "take it",
          deliveries: [
            {
              id: 1,
              to: "generic",
              state: "acked",
              note: "accepted: on it",
              replyId: "01M4JFBRP5HB3D73893BWHQ0P3",
            },
          ],
        },
        {
          message: msg({ kind: "ack", id: "01M4JFBRP5HB3D73893BWHQ0P3", from: "generic" }),
          text: "on it",
          deliveries: [{ id: 2, to: "@tester", state: "delivered" }],
        },
        {
          message: msg({ kind: "ack", id: "01M4JFBRP5HBZZZZZZZZZZZZZZ", from: "w2", re }),
          text: "processed",
          deliveries: [{ id: 3, to: "@tester", state: "delivered" }],
        },
      ],
    } as never);
    expect(out).toContain("generic (accepted)");
    expect(out).toContain("[accepted] on it");
    expect(out).toContain("[processed]");
    expect(out).not.toContain("processed processed");
    expect(out).toContain('re: "which port?" (codex)');
    expect(out).not.toContain("01M4JFBRP5HB3D73893BWHQ0P3");
  });

  it("log is a table with dates for old entries and reply context", () => {
    const old = new Date(Date.now() - 3 * 86_400_000);
    const out = logText([
      {
        message: msg({ createdAt: old.toISOString() }),
        deliveries: [{ id: 1, to: "generic", state: "seen" }],
      },
      {
        message: msg({ kind: "reply", from: "generic", preview: "7700", re }),
        deliveries: [{ id: 2, to: "@tester", state: "delivered" }],
      },
    ] as never);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^WHEN\s+ID\s+KIND\s+FROM\s+TO\s+MESSAGE$/);
    expect(lines[1]).toContain(old.toISOString().slice(0, 4));
    expect(lines[1]).not.toContain("ago");
    expect(lines[2]).toContain("ago");
    expect(lines[2]).toContain('re: "which port?" (codex)');
  });

  it("status shows receipt timings", () => {
    const t0 = Date.parse("2026-09-01T10:00:00Z");
    const at = (s: number) => new Date(t0 + s * 1000).toISOString();
    expect(
      receipts(
        {
          id: 1,
          to: "codex",
          state: "replied",
          deliveredAt: at(0),
          seenAt: at(12),
          repliedAt: at(132),
        },
        at(0),
      ),
    ).toBe("delivered immediately, seen 12s after delivery, replied 2m later");
    expect(receipts({ id: 1, to: "codex", state: "queued" }, at(0))).toBe("");
  });

  it("watch names the message and its kind, on a 24-hour clock", () => {
    const kinds = new Map([[ID, "ask"]]);
    const line = watchLine(
      { type: "delivery", delivery: { messageId: ID, to: "codex", state: "seen", method: "hook" } },
      kinds,
      new Date(2026, 8, 1, 15, 4, 5),
    );
    expect(line?.text).toBe("15:04:05 deliver 01M4JEY9QC7E ask → codex seen via hook");
    expect(line?.key).toBe(line?.text.slice(9));
  });
});
