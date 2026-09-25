import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
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
}

/** OpenCode: the agentlink plugin long-polls the daemon and calls `client.session.prompt`. */
export class OpenCodeBridge implements Deliverer {
  readonly id = "opencode-plugin";
  readonly pushWhenBusy = true;
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
