import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { ulid } from "../core/ids.ts";
import type { DaemonContext } from "./context.ts";
import type { Deliverer, WakePayload } from "./delivery.ts";
import { type AgentRow, parseJson } from "./types.ts";

const execFileAsync = promisify(execFile);

export function findBinary(name: string, envOverride?: string): string | undefined {
  if (envOverride) return envOverride;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Codex: `codex queue --thread <id> --message <text>` via the shared app-server daemon. */
export function codexQueueDeliverer(
  bin = findBinary("codex", process.env.AGENTLINK_CODEX_BIN),
): Deliverer {
  return {
    id: "codex-queue",
    canWake: (agent) => agent.tool === "codex" && !!agent.session_id && !!bin,
    async wake(agent, payload) {
      await execFileAsync(
        bin as string,
        ["queue", "--thread", agent.session_id as string, "--message", payload.rendered],
        { timeout: 20_000, maxBuffer: 1024 * 1024 },
      );
      return { consumed: true };
    },
  };
}

/**
 * Claude Code (2.1.224+): every session listens on an inbox socket; a JSON `user` line posted
 * there starts a new turn in an idle session, framed by Claude as a peer message. We never
 * send the session's own token, so Claude's inbound controls (hold/refuse) still apply.
 */
export function claudeInboxDeliverer(): Deliverer {
  const socketOf = (agent: AgentRow): string | undefined => {
    const s = parseJson<Record<string, unknown>>(agent.adapter, {}).claudeSocket;
    return typeof s === "string" && s ? s : undefined;
  };
  return {
    id: "claude-inbox",
    canWake(agent) {
      const socket = socketOf(agent);
      return agent.tool === "claude" && !!socket && existsSync(socket);
    },
    wake(agent, payload) {
      const socket = socketOf(agent) as string;
      const line = `${JSON.stringify({ type: "user", message: { role: "user", content: payload.rendered } })}\n`;
      return new Promise((resolve, reject) => {
        const conn = connect(socket);
        conn.setTimeout(5_000, () => conn.destroy(new Error("claude inbox timed out")));
        conn.once("error", reject);
        conn.once("connect", () => conn.end(line, () => resolve({ consumed: true })));
      });
    },
  };
}

/** Any CLI running inside tmux: types a one-line notice into its pane; hooks inject the mail. */
export function tmuxDeliverer(
  ctx: DaemonContext,
  bin = findBinary("tmux", process.env.AGENTLINK_TMUX_BIN),
): Deliverer {
  return {
    id: "tmux",
    canWake(agent) {
      if (!ctx.config.wake.tmux || !bin || agent.tool === "opencode") return false;
      const adapter = parseJson<Record<string, unknown>>(agent.adapter, {});
      return typeof adapter.tmuxPane === "string" && adapter.tmuxPane.length > 0;
    },
    async wake(agent, payload) {
      const adapter = parseJson<Record<string, unknown>>(agent.adapter, {});
      const pane = String(adapter.tmuxPane);
      const socket = typeof adapter.tmuxSocket === "string" ? ["-S", adapter.tmuxSocket] : [];
      const text = payload.notice.replace(/[\r\n]+/g, " ");
      await execFileAsync(bin as string, [...socket, "send-keys", "-t", pane, "-l", text], {
        timeout: 5_000,
      });
      await execFileAsync(bin as string, [...socket, "send-keys", "-t", pane, "Enter"], {
        timeout: 5_000,
      });
      return { consumed: false };
    },
  };
}

interface PendingPush {
  token: string;
  text: string;
  deliveryIds: number[];
  /** false → the plugin adds the text with noReply (FYI, no model turn). */
  reply: boolean;
}

/** OpenCode: the agentlink plugin long-polls the daemon and calls `client.session.promptAsync`. */
export class OpenCodeBridge implements Deliverer {
  readonly id = "opencode-plugin";
  readonly pushAlways = true;
  readonly #polls = new Map<string, (push: PendingPush | null) => void>();
  readonly #acks = new Map<string, (ok: boolean) => void>();

  canWake(agent: AgentRow): boolean {
    return agent.tool === "opencode" && this.#polls.has(agent.id);
  }

  wake(agent: AgentRow, payload: WakePayload): Promise<{ consumed: boolean }> {
    const resolvePoll = this.#polls.get(agent.id);
    if (!resolvePoll) return Promise.resolve({ consumed: false });
    this.#polls.delete(agent.id);
    const token = ulid();
    const acked = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#acks.delete(token);
        resolve(false);
      }, 15_000);
      this.#acks.set(token, (ok) => {
        clearTimeout(timer);
        this.#acks.delete(token);
        resolve(ok);
      });
    });
    resolvePoll({
      token,
      text: payload.rendered,
      deliveryIds: payload.items.map((i) => i.delivery.id),
      reply: payload.wakeWorthy,
    });
    return acked.then((consumed) => ({ consumed }));
  }

  /** Called by the plugin; resolves with a push or null after `timeoutMs`. */
  poll(agentId: string, timeoutMs: number, signal: AbortSignal): Promise<PendingPush | null> {
    this.#polls.get(agentId)?.(null);
    return new Promise((resolve) => {
      const finish = (push: PendingPush | null) => {
        clearTimeout(timer);
        if (this.#polls.get(agentId) === finish) this.#polls.delete(agentId);
        resolve(push);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      signal.addEventListener("abort", () => finish(null), { once: true });
      this.#polls.set(agentId, finish);
    });
  }

  ack(token: string, ok: boolean): boolean {
    const fn = this.#acks.get(token);
    if (!fn) return false;
    fn(ok);
    return true;
  }
}
