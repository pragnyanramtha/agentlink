import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Harness, Profile } from "../../core/config.ts";
import { invalid } from "../../core/errors.ts";

/** What a run's JSONL output said. */
export interface Out {
  started?: boolean;
  sessionId?: string;
  text?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  denials?: number;
  error?: string;
}

export interface ArgvInput {
  resume: boolean;
  sessionId?: string;
  cwd: string;
  profile: Profile;
  model?: string;
  maxBudgetUsd?: number;
}

export interface Runner {
  /** Session ids this CLI uses (checked before they go on a command line). */
  sessionRe: RegExp;
  /** The id of a new session can be chosen up front. */
  preassign: boolean;
  experimental?: boolean;
  label(resume: boolean): string;
  argv(o: ArgvInput): { argv: string[]; env?: Record<string, string> };
  parse(event: Record<string, unknown>, out: Out): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const obj = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const add = (a: number | undefined, b: number | undefined) => (b === undefined ? a : (a ?? 0) + b);

/**
 * Command lines per CLI and permission profile. The prompt always goes on stdin. Never used:
 * bypassPermissions / --dangerously-*, --yolo, --auto, -y.
 */
export const RUNNERS: Record<Harness, Runner> = {
  claude: {
    sessionRe: UUID,
    preassign: true,
    label: (resume) => (resume ? "claude -p --resume" : "claude -p"),
    argv: (o) => ({
      argv: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        ...(o.resume
          ? ["--resume", o.sessionId as string]
          : ["--session-id", o.sessionId as string]),
        // Explicit, so the user's defaultMode never applies to an unattended run.
        "--permission-mode",
        o.profile === "read-only" ? "dontAsk" : "acceptEdits",
        "--permission-prompts",
        "none",
        "--allowedTools",
        ["mcp__agentlink__*", "Bash(agentlink:*)", ...(o.profile === "full" ? ["Bash"] : [])].join(
          ",",
        ),
        ...(o.model ? ["--model", o.model] : []),
        ...(o.maxBudgetUsd ? ["--max-budget-usd", String(o.maxBudgetUsd)] : []),
      ],
    }),
    parse(e, out) {
      out.sessionId ??= str(e.session_id);
      if (e.type === "assistant") {
        const content = obj(e.message).content;
        const text = Array.isArray(content)
          ? content
              .map((c) => (obj(c).type === "text" ? str(obj(c).text) : undefined))
              .filter(Boolean)
              .join("\n")
          : "";
        if (text) out.text = text;
      }
      if (e.type === "result") {
        out.text = str(e.result) ?? out.text;
        out.costUsd = num(e.total_cost_usd);
        const usage = obj(e.usage);
        out.tokensIn = num(usage.input_tokens);
        out.tokensOut = num(usage.output_tokens);
        if (Array.isArray(e.permission_denials)) out.denials = e.permission_denials.length;
        if (e.is_error === true) out.error = str(e.result) || str(e.subtype) || "error";
      }
    },
  },
  codex: {
    sessionRe: UUID,
    preassign: false,
    label: (resume) => (resume ? "codex exec resume" : "codex exec"),
    argv: (o) => {
      const sandbox = o.profile === "read-only" ? "read-only" : "workspace-write";
      const common = [
        "--json",
        "-c",
        'approval_policy="never"',
        ...(o.profile === "full" ? ["-c", "sandbox_workspace_write.network_access=true"] : []),
        ...(o.model ? ["-m", o.model] : []),
      ];
      return {
        argv: o.resume
          ? [
              "exec",
              "resume",
              ...common,
              "-c",
              `sandbox_mode="${sandbox}"`,
              o.sessionId as string,
              "-",
            ]
          : ["exec", ...common, "-C", o.cwd, "-s", sandbox, "-"],
      };
    },
    parse(e, out) {
      if (e.type === "thread.started") out.sessionId ??= str(e.thread_id);
      const item = obj(e.item);
      if (e.type === "item.completed" && item.type === "agent_message")
        out.text = str(item.text) ?? out.text;
      if (e.type === "turn.completed") {
        const usage = obj(e.usage);
        out.tokensIn = add(out.tokensIn, num(usage.input_tokens));
        out.tokensOut = add(out.tokensOut, num(usage.output_tokens));
      }
      if (e.type === "turn.failed") out.error = str(obj(e.error).message) ?? "turn failed";
      if (e.type === "error") out.error = str(e.message) ?? "error";
    },
  },
  opencode: {
    sessionRe: /^ses_[A-Za-z0-9]{8,64}$/,
    preassign: false,
    label: (resume) => (resume ? "opencode run --session" : "opencode run"),
    argv: (o) => ({
      argv: [
        "run",
        "--format",
        "json",
        "--dir",
        o.cwd,
        ...(o.resume ? ["--session", o.sessionId as string] : []),
        ...(o.profile === "read-only" ? ["--agent", "plan"] : []),
        ...(o.model ? ["-m", o.model] : []),
      ],
      // OpenCode allows most tools by default; "ask" is rejected in `run` (no --auto).
      ...(o.profile === "full"
        ? {}
        : {
            env: {
              OPENCODE_PERMISSION: JSON.stringify(
                o.profile === "read-only"
                  ? { edit: "deny", bash: "deny", webfetch: "deny" }
                  : { edit: "allow", bash: "ask", webfetch: "ask" },
              ),
            },
          }),
    }),
    parse(e, out) {
      out.sessionId ??= str(e.sessionID);
      const part = obj(e.part);
      if (e.type === "text" && str(part.text)) out.text = str(part.text);
      if (e.type === "step_finish") {
        const tokens = obj(part.tokens);
        out.tokensIn = add(out.tokensIn, num(tokens.input));
        out.tokensOut = add(out.tokensOut, num(tokens.output));
        out.costUsd = add(out.costUsd, num(part.cost));
      }
      if (e.type === "error") {
        const error = obj(e.error);
        out.error = str(obj(error.data).message) ?? str(error.name) ?? "error";
      }
    },
  },
  gemini: {
    sessionRe: UUID,
    preassign: true,
    experimental: true,
    label: (resume) => (resume ? "gemini -p --resume" : "gemini -p"),
    argv: (o) => ({
      argv: [
        "-p",
        "", // the prompt comes from stdin (gemini appends -p to it)
        "--output-format",
        "stream-json",
        ...(o.resume
          ? ["--resume", o.sessionId as string]
          : ["--session-id", o.sessionId as string]),
        "--approval-mode",
        o.profile === "read-only" ? "plan" : "auto_edit",
        ...(o.model ? ["-m", o.model] : []),
      ],
    }),
    parse(e, out) {
      if (e.type === "init") out.sessionId ??= str(e.session_id);
      if (e.type === "message" && e.role === "assistant" && str(e.content))
        out.text = e.delta === true ? `${out.text ?? ""}${e.content}` : str(e.content);
      if (e.type === "result") {
        const stats = obj(e.stats);
        out.tokensIn = num(stats.input_tokens);
        out.tokensOut = num(stats.output_tokens);
        if (e.status === "error") out.error = str(obj(e.error).message) ?? "error";
      }
    },
  },
};

export function executable(path: string): boolean {
  try {
    if (!isAbsolute(path) || !statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** An absolute executable path for `name` on `pathVar` (never a relative PATH entry). */
export function findBin(name: string, pathVar = process.env.PATH ?? ""): string | undefined {
  for (const dir of pathVar.split(":")) {
    if (dir && isAbsolute(dir) && executable(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

export const BIN_NAMES: Record<Harness, string> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
};

/** Validates a binary a person chose for a runner. */
export function checkBin(path: string): string {
  if (!executable(path)) throw invalid(`${path} is not an executable file (use an absolute path)`);
  return path;
}
