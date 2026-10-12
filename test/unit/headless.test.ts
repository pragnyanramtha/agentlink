import { describe, expect, it } from "vitest";
import { HARNESSES, HeadlessSchema, MODEL_RE, PROFILES } from "../../src/core/config.ts";
import { headlessDecision } from "../../src/core/policy.ts";
import { parseRunRef } from "../../src/daemon/headless.ts";
import { RUNNERS } from "../../src/daemon/runners/index.ts";

const DANGEROUS =
  /dangerously|bypass|^--yolo$|^-y$|^--auto$|^--force$|^-f$|allow-all|danger-full-access|^yolo$/i;
const argvOf = (
  h: (typeof HARNESSES)[number],
  profile: (typeof PROFILES)[number],
  resume: boolean,
) =>
  RUNNERS[h].argv({
    resume,
    sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
    cwd: "/work/api",
    profile,
    model: "gpt-5",
  });

describe("headless runner command lines", () => {
  it("never carry a dangerous flag, in any profile", () => {
    for (const h of HARNESSES)
      for (const p of PROFILES)
        for (const resume of [false, true]) {
          const { argv, env } = argvOf(h, p, resume);
          expect(
            argv.filter((a) => DANGEROUS.test(a)),
            `${h} ${p}`,
          ).toEqual([]);
          if (p === "read-only") expect(JSON.stringify(env ?? {})).not.toContain("allow");
        }
  });

  it("use the safest settings for read-only", () => {
    expect(argvOf("claude", "read-only", true).argv).toEqual(
      expect.arrayContaining(["--permission-mode", "dontAsk", "--permission-prompts", "none"]),
    );
    expect(argvOf("claude", "read-only", false).argv).toContain("--session-id");
    expect(argvOf("codex", "read-only", false).argv).toEqual([
      "exec",
      "--json",
      "-c",
      'approval_policy="never"',
      "-m",
      "gpt-5",
      "-C",
      "/work/api",
      "-s",
      "read-only",
      "-",
    ]);
    expect(argvOf("codex", "edit", true).argv).toContain('sandbox_mode="workspace-write"');
    expect(argvOf("opencode", "read-only", true).argv).toEqual(
      expect.arrayContaining(["--agent", "plan", "--session"]),
    );
    expect(
      JSON.parse(argvOf("opencode", "read-only", false).env?.OPENCODE_PERMISSION ?? "{}"),
    ).toEqual({ edit: "deny", bash: "deny", webfetch: "deny" });
    expect(argvOf("gemini", "read-only", false).argv).toEqual(
      expect.arrayContaining(["--approval-mode", "plan"]),
    );
    expect(argvOf("claude", "edit", false).argv).toContain("acceptEdits");
  });

  it("parse the CLIs' JSONL", () => {
    const out: Record<string, unknown> = {};
    RUNNERS.codex.parse({ type: "thread.started", thread_id: "abc" }, out);
    RUNNERS.codex.parse(
      { type: "item.completed", item: { type: "agent_message", text: "hi" } },
      out,
    );
    RUNNERS.codex.parse(
      { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } },
      out,
    );
    expect(out).toMatchObject({ sessionId: "abc", text: "hi", tokensIn: 3, tokensOut: 2 });
    const c: Record<string, unknown> = {};
    RUNNERS.claude.parse(
      { type: "result", result: "done", session_id: "s", total_cost_usd: 0.5, is_error: true },
      c,
    );
    expect(c).toMatchObject({ text: "done", sessionId: "s", costUsd: 0.5, error: "done" });
  });
});

describe("headless settings", () => {
  it("are off by default with read-only runners and safe limits", () => {
    const h = HeadlessSchema.parse({ runners: { codex: {} } });
    expect(h).toMatchObject({
      enabled: false,
      roots: [],
      maxConcurrent: 2,
      perAgentPerHour: 4,
      globalPerHour: 20,
      spawnPerHour: 5,
      perThreadRuns: 3,
      timeoutSec: 600,
      maxSpawnDepth: 1,
    });
    expect(h.runners.codex).toEqual({ enabled: false, profile: "read-only" });
  });

  it("only accept model names that can't become flags or shell", () => {
    for (const ok of [
      "gpt-5",
      "anthropic/claude-sonnet-4-5",
      "claude-opus-4-8[context=1m,effort=high]",
    ])
      expect(MODEL_RE.test(ok), ok).toBe(true);
    for (const bad of ["-c", "--yolo", "a b", "$(id)", "x;rm", ""])
      expect(MODEL_RE.test(bad), bad).toBe(false);
  });

  it("decide by sender: you allow, local per config, teammates only wake, external never", () => {
    const from = HeadlessSchema.parse({}).from;
    expect(headlessDecision("user", "spawn", from)).toBe("allow");
    expect(headlessDecision("local", "wake", from)).toBe("allow");
    expect(headlessDecision("teammate", "wake", from)).toBe("hold");
    expect(headlessDecision("teammate", "spawn", from)).toBe("refuse");
    expect(headlessDecision("external", "wake", { ...from, teammate: { wake: "allow" } })).toBe(
      "refuse",
    );
  });

  it("parse run references", () => {
    expect(parseRunRef("R12")).toBe(12);
    expect(parseRunRef("r3")).toBe(3);
    expect(parseRunRef("7")).toBe(7);
    expect(parseRunRef("codex-api")).toBeUndefined();
  });
});
