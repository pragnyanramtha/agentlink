import type { Capabilities } from "../daemon/types.ts";

export const CANONICAL_EVENTS = [
  "session-start",
  "prompt-submit",
  "pre-tool",
  "post-tool",
  "stop",
  "notification",
  "session-end",
  "turn-complete",
] as const;
export type CanonicalEvent = (typeof CANONICAL_EVENTS)[number];

export interface HookInfo {
  sessionId?: string;
  cwd?: string;
  stopHookActive?: boolean;
  toolName?: string;
  toolInput?: unknown;
  transcriptPath?: string;
  source?: string;
}

/** How agentlink talks to one CLI's hook system at runtime (what installers wire up). */
export interface AdapterRuntime {
  tool: string;
  capabilities: Capabilities;
  /** Native hook event names, used in outputs like hookSpecificOutput.hookEventName. */
  nativeEvents: Partial<Record<CanonicalEvent, string>>;
  parse(event: CanonicalEvent, payload: Record<string, unknown>): HookInfo;
  /** stdout that injects `text` into the model's context at this event, if the CLI supports it. */
  contextOutput(event: CanonicalEvent, text: string): string | undefined;
  /** stdout that keeps the agent going after a Stop with `reason` as new input, if supported. */
  continueOutput?(reason: string): string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function firstString(p: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = str(p[key]);
    if (v) return v;
  }
  return undefined;
}

function genericParse(p: Record<string, unknown>): HookInfo {
  const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots : undefined;
  const sessionId = firstString(p, [
    "session_id",
    "sessionId",
    "thread_id",
    "thread-id",
    "threadId",
    "conversation_id",
    "conversationId",
    "chat_id",
  ]);
  const cwd = firstString(p, ["cwd", "workspaceRoot", "workspace_root"]) ?? str(roots?.[0]);
  const transcriptPath = str(p.transcript_path);
  const toolName = firstString(p, ["tool_name", "toolName"]);
  const source = str(p.source);
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(p.stop_hook_active === true ? { stopHookActive: true } : {}),
    ...(toolName ? { toolName } : {}),
    ...(p.tool_input !== undefined ? { toolInput: p.tool_input } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(source ? { source } : {}),
  };
}

const CLAUDE_EVENTS: Partial<Record<CanonicalEvent, string>> = {
  "session-start": "SessionStart",
  "prompt-submit": "UserPromptSubmit",
  "pre-tool": "PreToolUse",
  "post-tool": "PostToolUse",
  stop: "Stop",
  notification: "Notification",
  "session-end": "SessionEnd",
};

const INJECTABLE: CanonicalEvent[] = ["session-start", "prompt-submit", "pre-tool", "post-tool"];

/** Claude Code's hook contract, also followed by Codex and Devin CLI. */
function claudeStyle(
  tool: string,
  capabilities: Capabilities,
  injectable: CanonicalEvent[] = INJECTABLE,
): AdapterRuntime {
  return {
    tool,
    capabilities,
    nativeEvents: CLAUDE_EVENTS,
    parse: (_event, p) => genericParse(p),
    contextOutput(event, text) {
      const name = CLAUDE_EVENTS[event];
      if (!name || !injectable.includes(event)) return undefined;
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: name, additionalContext: text },
      });
    },
    continueOutput: (reason) => JSON.stringify({ decision: "block", reason }),
  };
}

const GEMINI_EVENTS: Partial<Record<CanonicalEvent, string>> = {
  "session-start": "SessionStart",
  "prompt-submit": "BeforeAgent",
  "pre-tool": "BeforeTool",
  "post-tool": "AfterTool",
  stop: "AfterAgent",
  notification: "Notification",
  "session-end": "SessionEnd",
};

const COPILOT_EVENTS: Partial<Record<CanonicalEvent, string>> = {
  "session-start": "sessionStart",
  "prompt-submit": "userPromptSubmitted",
  "pre-tool": "preToolUse",
  "post-tool": "postToolUse",
  stop: "agentStop",
  "session-end": "sessionEnd",
};

const CURSOR_EVENTS: Partial<Record<CanonicalEvent, string>> = {
  "session-start": "sessionStart",
  "prompt-submit": "beforeSubmitPrompt",
  "pre-tool": "preToolUse",
  "post-tool": "postToolUse",
  stop: "stop",
  "session-end": "sessionEnd",
};

const RUNTIMES: Record<string, AdapterRuntime> = {
  claude: claudeStyle("claude", { midTurn: true, nextTurn: true }),
  codex: {
    ...claudeStyle("codex", { midTurn: true, nextTurn: true, wake: true }),
    // `notify` passes {"type":"agent-turn-complete","thread-id":…,"cwd":…} as argv JSON.
    parse: (_event, p) => genericParse(p),
  },
  devin: claudeStyle("devin", { midTurn: true, nextTurn: true }),
  gemini: {
    tool: "gemini",
    capabilities: { midTurn: true, nextTurn: true },
    nativeEvents: GEMINI_EVENTS,
    parse: (_event, p) => genericParse(p),
    contextOutput(event, text) {
      const name = GEMINI_EVENTS[event];
      if (!name || !["session-start", "prompt-submit", "post-tool"].includes(event))
        return undefined;
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: name, additionalContext: text },
      });
    },
  },
  copilot: {
    tool: "copilot",
    capabilities: { nextTurn: true },
    nativeEvents: COPILOT_EVENTS,
    parse: (_event, p) => genericParse(p),
    contextOutput(event, text) {
      if (!["session-start", "prompt-submit"].includes(event)) return undefined;
      return JSON.stringify({ additionalContext: text });
    },
    continueOutput: (reason) => JSON.stringify({ decision: "block", reason }),
  },
  cursor: {
    tool: "cursor",
    capabilities: { nextTurn: true },
    nativeEvents: CURSOR_EVENTS,
    parse: (_event, p) => genericParse(p),
    contextOutput(event, text) {
      if (event !== "session-start") return undefined;
      return JSON.stringify({ additional_context: text });
    },
  },
  kiro: {
    tool: "kiro",
    capabilities: { nextTurn: true },
    nativeEvents: CLAUDE_EVENTS,
    parse: (_event, p) => genericParse(p),
    contextOutput: () => undefined,
  },
  opencode: {
    tool: "opencode",
    capabilities: { nextTurn: true, wake: true, push: true },
    nativeEvents: {},
    parse: (_event, p) => genericParse(p),
    contextOutput: () => undefined,
  },
  generic: {
    tool: "generic",
    capabilities: {},
    nativeEvents: {},
    parse: (_event, p) => genericParse(p),
    contextOutput: () => undefined,
  },
};

export const TOOLS = Object.keys(RUNTIMES);

export function getRuntime(tool: string): AdapterRuntime | undefined {
  return RUNTIMES[tool];
}
