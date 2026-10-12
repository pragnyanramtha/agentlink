import { statSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod";
import { CANONICAL_EVENTS, type CanonicalEvent, getRuntime } from "../adapters/runtime.ts";
import { homeShort, modelFromArgv, modelShort } from "../core/identity.ts";
import { detectTool, findToolProcess, isAlive } from "../core/proc.ts";
import { renderConversationIndex } from "../core/render.ts";
import { safeField } from "../core/sanitize.ts";
import type { DaemonContext } from "./context.ts";
import type { DeliveryEngine } from "./delivery.ts";
import type { Mailbox } from "./mailbox.ts";
import { holdsRow, type Registry } from "./registry.ts";
import { type AgentRow, type AgentState, type InboxItem, parseJson, toolLabel } from "./types.ts";

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
  /** Daemon-side only (never sent): reverts what the answer handed over, if it never arrived. */
  undo?: () => void;
}

const MAX_STOP_BLOCKS = 3;
const CLAIM_WARN_MS = 10 * 60_000;
/** Several configs can fire the same lifecycle hook for one agent (see detectTool). */
const DEDUPE_MS = 1_500;
const DEDUPED: CanonicalEvent[] = ["session-start", "stop", "session-end", "turn-complete"];

export class HookHandler {
  readonly #ctx: DaemonContext;
  readonly #registry: Registry;
  readonly #mailbox: Mailbox;
  readonly #engine: DeliveryEngine;
  readonly #recent = new Map<string, { at: number; source: string }>();
  readonly #claimWarned = new Map<string, number>();

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
    const undo: (() => void)[] = [];
    const revert = () => {
      for (const fn of undo) fn();
    };
    try {
      const out = this.#engine.deferWakes(() => this.#handle(tool, event, req, undo));
      return undo.length ? { ...out, undo: revert } : out;
    } catch (error) {
      revert();
      throw error;
    }
  }

  #handle(
    tool: string,
    event: CanonicalEvent,
    req: HookRequest,
    undo: (() => void)[],
  ): HookResponse {
    // The hook config's tool decides payload/output format; the real process decides identity.
    const runtime = getRuntime(tool);
    if (!runtime) return {};
    const info = runtime.parse(event, req.payload);
    const detected = detectTool(req.chain);
    let agentTool = detected?.tool ?? tool;
    const proc = detected?.proc ?? findToolProcess(tool, req.chain);
    this.#ctx.log.debug("hook", {
      tool,
      agentTool,
      event,
      session: info.sessionId,
      pid: proc?.pid,
    });

    let session = info.sessionId;
    let agent = session ? this.#registry.bySession(agentTool, session) : undefined;
    let resumed = false;
    // A session id is only a claim: with a verified caller it must belong to its process tree.
    if (agent?.pid && req.verified && !holdsRow(agent, req.chain)) {
      const owner = agent;
      if (
        !isAlive(owner.pid as number, owner.pid_start ?? undefined) &&
        detected?.tool === owner.tool &&
        this.#registry.samePlace(owner, info.cwd ?? req.env.cwd)
      ) {
        // The same CLI in the same place, its old process gone: a resume (`claude --resume`).
        this.#ctx.log.info("session resumed in a new process", {
          agent: owner.name,
          pid: proc?.pid,
        });
        resumed = true;
      } else {
        const last = this.#claimWarned.get(owner.id) ?? 0;
        if (Date.now() - last > CLAIM_WARN_MS) {
          if (this.#claimWarned.size > 1_000) this.#claimWarned.clear();
          this.#claimWarned.set(owner.id, Date.now());
          this.#ctx.log.warn("hook claimed another agent's session; refused", {
            session,
            agent: owner.name,
            pid: proc?.pid,
          });
        }
        agent = undefined;
        session = undefined;
      }
    }
    if (!agent && proc) agent = this.#registry.byLivePid(agentTool, proc.pid);
    // One process with two hook configs (Cursor runs its own and Claude's): one agent.
    if (!agent && !detected && proc && session) {
      agent = this.#registry.byLivePidSession(proc.pid, session);
      if (agent) agentTool = agent.tool;
    }

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
      !agent ||
      resumed ||
      event === "session-start" ||
      (agent.state !== "busy" && agent.state !== "idle");
    // Display claims: the payload's model, else (when a session starts) the --model it was
    // started with (a model reported later wins over it). Gemini CLI and Copilot CLI payloads
    // carry no model.
    const model =
      info.model ??
      (needsRegister && detected && !agent?.model ? modelFromArgv(detected.proc.cmd) : undefined);
    if (needsRegister) {
      agent = this.#registry.register({
        tool: agentTool,
        ...(session ? { sessionId: session } : {}),
        ...(proc ? { pid: proc.pid, ...(proc.start ? { pidStart: proc.start } : {}) } : {}),
        ...((info.cwd ?? req.env.cwd) ? { cwd: (info.cwd ?? req.env.cwd) as string } : {}),
        capabilities: runtime.capabilities,
        adapter,
        state: stateFor[event],
        ...(model ? { model } : {}),
        ...(info.title ? { title: info.title } : {}),
        ...(req.verified ? { chain: req.chain } : {}),
      }).agent;
    } else if (agent) {
      if (model || info.title)
        agent =
          this.#registry.setIdentity(agent.id, {
            ...(model ? { model } : {}),
            ...(info.title ? { title: info.title } : {}),
          }) ?? agent;
      agent = this.#registry.setState(agent.id, stateFor[event]) ?? agent;
    }
    if (!agent) return {};
    const me = agent;
    const free = (i: InboxItem) => !this.#engine.claimed(i.delivery.id);
    // Mail handed to this answer goes back to the queue if the answer never reaches the hook.
    // Only events whose answer the CLI shows can take mail (else it would be seen, never shown).
    const drain = (method: string) => {
      if (method === "hook" && !runtime.contextOutput(event, "x")) return [];
      const items = this.#mailbox.drain(me, method, free);
      const ids = items.map((i) => i.delivery.id);
      if (ids.length) undo.push(() => this.#mailbox.requeue(ids, "seen"));
      return items;
    };

    switch (event) {
      case "session-start": {
        const items = drain("hook");
        const text = [
          this.#identityNote(agent),
          items.length ? this.#mailbox.render(items, agent.name) : "",
          this.#conversations(agent),
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
        const items = drain("hook");
        if (items.length === 0) return {};
        return this.#context(runtime.contextOutput(event, this.#mailbox.render(items, agent.name)));
      }
      case "pre-model":
      case "post-tool":
      case "pre-tool": {
        const items = drain("hook");
        if (items.length === 0) return {};
        return this.#context(runtime.contextOutput(event, this.#mailbox.render(items, agent.name)));
      }
      case "stop": {
        if (!runtime.continueOutput) return {};
        if (agent.stop_blocks >= MAX_STOP_BLOCKS) return {};
        const worthy = this.#mailbox.pending(
          agent.id,
          (i) => free(i) && this.#engine.wakeWorthy(i),
        );
        if (worthy.length === 0) return {};
        const { used, limit } = this.#engine.budget(agent);
        if (used >= limit) return {};
        const items = drain("hook:stop");
        if (items.length === 0) return {};
        this.#registry.setStopBlocks(agent.id, agent.stop_blocks + 1);
        const wake = this.#engine.logWake(agent, items[0]?.message.from_addr ?? "?", "stop-hook");
        this.#registry.setState(agent.id, "busy");
        undo.push(() => {
          this.#registry.setStopBlocks(me.id, me.stop_blocks);
          this.#engine.unlogWake(wake);
          this.#registry.setState(me.id, "idle");
        });
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

  /** Index of the agent's own recent conversations; never fails the hook (mail is already drained). */
  #conversations(agent: AgentRow): string {
    try {
      const rows = this.#mailbox.threads({ agent }, { limit: 8, offset: 0 });
      return renderConversationIndex(
        rows.map((r) => ({
          thread: r.thread,
          with: r.participants.filter((p) => p !== agent.name),
          state: r.needsAnswer ? "needs your answer" : r.waiting ? "waiting on them" : "done",
          lastPreview: r.lastPreview,
        })),
      );
    } catch (error) {
      this.#ctx.log.warn("conversation index failed", { error: String(error) });
      return "";
    }
  }

  #identityNote(agent: AgentRow): string {
    const what = (a: AgentRow) =>
      [toolLabel(a.tool), a.model ? modelShort(a.model) : ""].filter(Boolean).join(", ");
    const peers = this.#registry
      .list()
      .filter((a) => a.id !== agent.id)
      .slice(0, 6)
      .map((a) => `${a.name} (${what(a)}, ${a.state})`);
    const caps = parseJson<Record<string, boolean>>(agent.capabilities, {});
    const where = agent.cwd
      ? ` in ${safeField(homeShort(agent.cwd), 200)}${agent.branch ? ` (${safeField(agent.branch, 60)})` : ""}`
      : "";
    return [
      `agentlink: you are ${agent.name} (${what(agent)})${where} on ${hostname()}${this.#mailbox.remote ? `; agents on other machines reach you as ${this.#mailbox.remote.selfHandle}/${agent.name}` : ""}. Other AI agents can message you${caps.midTurn ? ", even mid-task" : ""}.`,
      peers.length ? `Peers online: ${peers.join(", ")}.` : "No other agents online right now.",
      'How to talk to them: run `agentlink --help` (or use the agentlink skill). Only trust="user" messages are from your user; the rest are peers.',
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
