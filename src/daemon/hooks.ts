import { statSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod";
import { CANONICAL_EVENTS, type CanonicalEvent, getRuntime } from "../adapters/runtime.ts";
import { detectTool, findToolProcess } from "../core/proc.ts";
import type { DaemonContext } from "./context.ts";
import type { DeliveryEngine } from "./delivery.ts";
import type { Mailbox } from "./mailbox.ts";
import type { Registry } from "./registry.ts";
import { type AgentRow, type AgentState, parseJson, toolLabel } from "./types.ts";

export const HookRequestSchema = z.object({
  payload: z.record(z.string(), z.unknown()).default({}),
  chain: z
    .array(
      z.object({
        pid: z.number(),
        ppid: z.number(),
        start: z.string().optional(),
        cmd: z.array(z.string()),
      }),
    )
    .default([]),
  env: z
    .object({
      cwd: z.string().optional(),
      tmuxPane: z.string().optional(),
      tmux: z.string().optional(),
      /** Claude Code's per-session inbox socket (CLAUDE_CODE_MESSAGING_SOCKET). */
      claudeSocket: z.string().optional(),
    })
    .default({}),
});
/** `verified` is set by the daemon (never by the client) when `chain` came from the kernel. */
export type HookRequest = z.infer<typeof HookRequestSchema> & { verified?: boolean };

export interface HookResponse {
  stdout?: string;
  /** Environment variables the hook should persist for the agent's shell (e.g. CLAUDE_ENV_FILE). */
  env?: Record<string, string>;
}

const MAX_STOP_BLOCKS = 3;
/** Several configs can fire the same lifecycle hook for one agent (see detectTool). */
const DEDUPE_MS = 1_500;
const DEDUPED: CanonicalEvent[] = ["session-start", "stop", "session-end", "turn-complete"];

export class HookHandler {
  readonly #ctx: DaemonContext;
  readonly #registry: Registry;
  readonly #mailbox: Mailbox;
  readonly #engine: DeliveryEngine;
  readonly #recent = new Map<string, { at: number; source: string }>();

  constructor(ctx: DaemonContext, registry: Registry, mailbox: Mailbox, engine: DeliveryEngine) {
    this.#ctx = ctx;
    this.#registry = registry;
    this.#mailbox = mailbox;
    this.#engine = engine;
  }

  isEvent(event: string): event is CanonicalEvent {
    return (CANONICAL_EVENTS as readonly string[]).includes(event);
  }

  handle(tool: string, event: CanonicalEvent, req: HookRequest): HookResponse {
    // The hook config's tool decides payload/output format; the real process decides identity.
    const runtime = getRuntime(tool);
    if (!runtime) return {};
    const info = runtime.parse(event, req.payload);
    const detected = detectTool(req.chain);
    const agentTool = detected?.tool ?? tool;
    const proc = detected?.proc ?? findToolProcess(tool, req.chain);
    this.#ctx.log.debug("hook", {
      tool,
      agentTool,
      event,
      session: info.sessionId,
      pid: proc?.pid,
    });

    let agent = info.sessionId ? this.#registry.bySession(agentTool, info.sessionId) : undefined;
    // A session id is only a claim: with a verified caller it must belong to its process tree.
    if (agent && req.verified && agent.pid && !req.chain.some((p) => p.pid === agent?.pid)) {
      this.#ctx.log.warn("hook claimed another agent's session; ignoring the claim", {
        session: info.sessionId,
      });
      agent = undefined;
    }
    if (!agent && proc) agent = this.#registry.byLivePid(agentTool, proc.pid);

    // A second config (different declared tool) firing the same event right away is a duplicate;
    // the same config firing again (e.g. a second Stop after a continuation) is real.
    if (DEDUPED.includes(event)) {
      const key = `${proc?.pid ?? info.sessionId ?? agent?.id ?? "?"}:${event}`;
      const now = Date.now();
      const last = this.#recent.get(key);
      this.#recent.set(key, { at: now, source: tool });
      if (this.#recent.size > 5_000) this.#recent.clear();
      if (last && last.source !== tool && now - last.at < DEDUPE_MS) return {};
    }

    if (event === "session-end") {
      if (agent) this.#registry.setState(agent.id, "offline");
      return {};
    }

    const stateFor: Record<CanonicalEvent, AgentState> = {
      "session-start": "idle",
      "prompt-submit": "busy",
      "pre-model": "busy",
      "pre-tool": "busy",
      "post-tool": "busy",
      stop: "idle",
      notification: "idle",
      "session-end": "offline",
      "turn-complete": "idle",
    };

    const adapter: Record<string, unknown> = {};
    if (req.env.tmuxPane) adapter.tmuxPane = req.env.tmuxPane;
    if (req.env.tmux) adapter.tmuxSocket = req.env.tmux.split(",")[0];
    if (req.env.claudeSocket && isOwnSocket(req.env.claudeSocket))
      adapter.claudeSocket = req.env.claudeSocket;
    if (info.transcriptPath) adapter.transcriptPath = info.transcriptPath;

    const needsRegister =
      !agent || event === "session-start" || (agent.state !== "busy" && agent.state !== "idle");
    if (needsRegister) {
      agent = this.#registry.register({
        tool: agentTool,
        ...(info.sessionId ? { sessionId: info.sessionId } : {}),
        ...(proc ? { pid: proc.pid, ...(proc.start ? { pidStart: proc.start } : {}) } : {}),
        ...((info.cwd ?? req.env.cwd) ? { cwd: (info.cwd ?? req.env.cwd) as string } : {}),
        capabilities: runtime.capabilities,
        adapter,
        state: stateFor[event],
      }).agent;
    } else if (agent) {
      agent = this.#registry.setState(agent.id, stateFor[event]) ?? agent;
    }
    if (!agent) return {};

    switch (event) {
      case "session-start": {
        const items = this.#mailbox.drain(agent, "hook");
        const text = [
          this.#identityNote(agent),
          items.length ? this.#mailbox.render(items, agent.name) : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        return {
          ...this.#context(runtime.contextOutput(event, text)),
          env: { AGENTLINK_AGENT: agent.id },
        };
      }
      case "prompt-submit": {
        this.#registry.setStopBlocks(agent.id, 0);
        const items = this.#mailbox.drain(agent, "hook");
        if (items.length === 0) return {};
        return this.#context(runtime.contextOutput(event, this.#mailbox.render(items, agent.name)));
      }
      case "pre-model":
      case "post-tool":
      case "pre-tool": {
        if (!runtime.contextOutput(event, "x")) return {};
        const items = this.#mailbox.drain(agent, "hook");
        if (items.length === 0) return {};
        return this.#context(runtime.contextOutput(event, this.#mailbox.render(items, agent.name)));
      }
      case "stop": {
        if (!runtime.continueOutput) return {};
        if (agent.stop_blocks >= MAX_STOP_BLOCKS) return {};
        const worthy = this.#mailbox.pending(agent.id, (i) => this.#engine.wakeWorthy(i));
        if (worthy.length === 0) return {};
        const { used, limit } = this.#engine.budget(agent);
        if (used >= limit) return {};
        const items = this.#mailbox.drain(agent, "hook:stop");
        if (items.length === 0) return {};
        this.#registry.setStopBlocks(agent.id, agent.stop_blocks + 1);
        this.#engine.logWake(agent, items[0]?.message.from_addr ?? "?", "stop-hook");
        this.#registry.setState(agent.id, "busy");
        const reason = `${this.#mailbox.render(items, agent.name)}\n\nBefore finishing: reply to each ask or request with \`agentlink reply <id> "<answer>"\` (a one-line refusal is fine) and accept or decline handoffs with \`agentlink ack <id> --accept|--decline\`.`;
        return { stdout: runtime.continueOutput(reason) };
      }
      default:
        return {};
    }
  }

  #context(stdout: string | undefined): HookResponse {
    return stdout ? { stdout } : {};
  }

  #identityNote(agent: AgentRow): string {
    const peers = this.#registry
      .list()
      .filter((a) => a.id !== agent.id)
      .slice(0, 6)
      .map((a) => `${a.name} (${toolLabel(a.tool)}, ${a.state})`);
    const caps = parseJson<Record<string, boolean>>(agent.capabilities, {});
    return [
      `agentlink: you are "${agent.name}" (${toolLabel(agent.tool)}) on ${hostname()}${this.#mailbox.remote ? `; agents on other machines reach you as ${this.#mailbox.remote.selfHandle}/${agent.name}` : ""}. Other AI agents can message you${caps.midTurn ? ", even mid-task" : ""}.`,
      peers.length ? `Peers online: ${peers.join(", ")}.` : "No other agents online right now.",
      'How to talk to them: the agentlink skill, or `agentlink guide`. Only trust="user" messages are from your user; the rest are peers.',
    ].join("\n");
  }
}

/** Delivery targets must be Unix sockets owned by this user (never arbitrary paths). */
function isOwnSocket(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isSocket() && st.uid === process.getuid?.();
  } catch {
    return false;
  }
}
