import type { Envelope, Kind } from "../core/envelope.ts";
import type { Trust } from "../core/policy.ts";

export type AgentState = "busy" | "idle" | "offline" | "stale";

export interface Capabilities {
  /** Messages can be injected between tool calls (PostToolUse-style hook). */
  midTurn?: boolean;
  /** Messages are injected when the next prompt/turn starts. */
  nextTurn?: boolean;
  /** An idle agent can be woken (starts a new turn). */
  wake?: boolean;
  /** Messages can be pushed into a busy session's queue without hooks. */
  push?: boolean;
}

export interface AgentRow {
  id: string;
  name: string;
  name_source: "auto" | "user";
  tool: string;
  session_id: string | null;
  pid: number | null;
  pid_start: string | null;
  cwd: string | null;
  repo_root: string | null;
  repo_remote: string | null;
  branch: string | null;
  state: AgentState;
  state_at: string;
  capabilities: string;
  adapter: string;
  status_text: string | null;
  muted: number;
  stop_blocks: number;
  created_at: string;
  last_seen_at: string;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  reply_to: string | null;
  task_id: string | null;
  kind: Kind;
  from_addr: string;
  from_agent_id: string | null;
  trust: Trust;
  envelope: string;
  preview: string;
  echo_key: string;
  wait: number;
  created_at: string;
  expires_at: string;
}

export type DeliveryState =
  | "queued"
  | "delivered"
  | "seen"
  | "acked"
  | "replied"
  | "held"
  | "refused"
  | "expired"
  | "failed"
  | "sent";

export interface DeliveryRow {
  id: number;
  message_id: string;
  to_addr: string;
  to_agent_id: string | null;
  state: DeliveryState;
  method: string | null;
  note: string | null;
  created_at: string;
  delivered_at: string | null;
  seen_at: string | null;
  acked_at: string | null;
  replied_at: string | null;
  reply_id: string | null;
  decided_by: string | null;
}

export interface CallerInfo {
  pid: number;
  chain: { pid: number; ppid: number; start?: string; cmd: string[] }[];
  tty: boolean;
  as?: string;
  envAgent?: string;
  /** chain and tty come from the kernel (peer credentials), not from the client. */
  verified?: boolean;
}

export type Sender = { kind: "agent"; agent: AgentRow } | { kind: "human" };

export interface InboxItem {
  delivery: DeliveryRow;
  message: MessageRow;
  envelope: Envelope;
}

export const TOOL_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  copilot: "Copilot CLI",
  cursor: "Cursor",
  kiro: "Kiro",
  devin: "Devin",
  generic: "agent",
  worker: "headless worker",
};

export const toolLabel = (tool: string) => TOOL_LABELS[tool] ?? tool;

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
