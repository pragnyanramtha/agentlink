import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wakeEligible } from "../core/policy.ts";
import { renderWakeNotice } from "../core/render.ts";
import { type DaemonContext, iso } from "./context.ts";
import type { Mailbox } from "./mailbox.ts";
import { isLive, type Registry } from "./registry.ts";
import { type AgentRow, type Capabilities, type InboxItem, parseJson } from "./types.ts";

export interface WakePayload {
  rendered: string;
  notice: string;
  items: InboxItem[];
  /** At least one item justifies a response (ask/request/handoff/…); else it's FYI only. */
  wakeWorthy: boolean;
}

export interface Deliverer {
  id: string;
  /** True if this deliverer can reach the agent right now. */
  canWake(agent: AgentRow): boolean;
  /**
   * Delivers to the agent. `consumed: true` means the full messages reached the session;
   * false means only a notice was shown and hooks will inject the messages.
   */
  wake(agent: AgentRow, payload: WakePayload): Promise<{ consumed: boolean }>;
  /** Push-capable deliverers reach the session in any state (busy: queued; idle: FYI added silently). */
  pushAlways?: boolean;
}

function ago(isoTime: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(isoTime)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export class DeliveryEngine {
  readonly #ctx: DaemonContext;
  readonly #registry: Registry;
  readonly #mailbox: Mailbox;
  readonly #deliverers: Deliverer[] = [];
  readonly #inFlight = new Set<string>();

  constructor(ctx: DaemonContext, registry: Registry, mailbox: Mailbox) {
    this.#ctx = ctx;
    this.#registry = registry;
    this.#mailbox = mailbox;
    mkdirSync(ctx.paths.pendingDir, { recursive: true, mode: 0o700 });
    registry.onStateChange((agent) => {
      if (agent.state === "idle") this.maybeWake(agent);
    });
    ctx.events.subscribe((event) => {
      if (event.type === "agent" || event.type === "delivery") {
        const id =
          event.type === "agent"
            ? String(event.agent.id)
            : this.#agentIdForDelivery(Number(event.delivery.id));
        if (id) this.refreshPending(id);
      }
    });
  }

  use(deliverer: Deliverer): void {
    this.#deliverers.push(deliverer);
  }

  delivererFor(agent: AgentRow): Deliverer | undefined {
    return this.#deliverers.find((d) => {
      try {
        return d.canWake(agent);
      } catch {
        return false;
      }
    });
  }

  capabilities(agent: AgentRow): Capabilities {
    return parseJson<Capabilities>(agent.capabilities, {});
  }

  budget(agent: AgentRow): { used: number; limit: number } {
    const since = iso(new Date(this.#ctx.now().getTime() - 3600_000));
    const used =
      this.#ctx.store.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM wake_log WHERE agent_id = ? AND at > ?",
        agent.id,
        since,
      )?.n ?? 0;
    return { used, limit: this.#ctx.config.wake.perSessionPerHour };
  }

  /** Whether a queued item justifies waking (or continuing) its recipient. */
  wakeWorthy(item: InboxItem): boolean {
    const policy = this.#ctx.config.wake.policy;
    if (policy === "never") return false;
    if (policy === "always") return item.message.trust !== "external";
    return wakeEligible(
      item.message.kind,
      item.message.trust,
      this.#mailbox.answersExpecting(item),
    );
  }

  logWake(agent: AgentRow, sender: string, method: string): void {
    this.#ctx.store.run(
      "INSERT INTO wake_log (agent_id, sender, method, at) VALUES (?, ?, ?, ?)",
      agent.id,
      sender,
      method,
      iso(this.#ctx.now()),
    );
  }

  /** Plans delivery for freshly queued items; returns a sender-facing note per delivery id. */
  onQueued(items: InboxItem[]): Map<number, string> {
    const notes = new Map<number, string>();
    const now = this.#ctx.now();
    const byAgent = new Map<string, InboxItem[]>();
    for (const item of items) {
      const id = item.delivery.to_agent_id;
      if (!id) continue;
      byAgent.set(id, [...(byAgent.get(id) ?? []), item]);
    }
    for (const [agentId, agentItems] of byAgent) {
      const agent = this.#registry.byId(agentId);
      if (!agent) continue;
      this.refreshPending(agent.id);
      const note = this.#plan(agent, agentItems, now);
      for (const item of agentItems) notes.set(item.delivery.id, note);
    }
    return notes;
  }

  #plan(agent: AgentRow, items: InboxItem[], now: Date): string {
    if (this.#mailbox.paused) return "queued (agentlink is paused)";
    if (agent.muted) return `queued (${agent.name} is muted)`;
    if (!isLive(agent)) {
      return `queued: ${agent.name} is offline (last seen ${ago(agent.last_seen_at, now)}); it gets the message when it is back`;
    }
    const caps = this.capabilities(agent);
    const deliverer = this.delivererFor(agent);
    const worthy = items.some((i) => this.wakeWorthy(i));
    if (deliverer?.pushAlways && (agent.state === "busy" || !worthy)) {
      this.#push(agent, deliverer);
      return agent.state === "busy"
        ? `busy: queued into its session (${deliverer.id})`
        : `idle: added to its session without waking it (${deliverer.id})`;
    }
    const hookless = !caps.midTurn && !caps.nextTurn && !caps.push && !caps.wake;
    if (hookless && !deliverer) return `queued: ${agent.name} reads it with agentlink inbox`;
    if (agent.state === "busy") {
      if (caps.midTurn) return "busy: injected at its next tool call";
      return "busy: delivered when its next turn starts";
    }
    // idle
    if (!worthy) return "idle: delivered when it next starts a turn";
    const { used, limit } = this.budget(agent);
    if (used >= limit) {
      return `idle: wake budget used up (${used}/${limit} this hour); delivered at its next turn`;
    }
    if (!deliverer) {
      return "idle: no way to wake it (run it inside tmux or use a push-capable CLI); delivered at its next turn";
    }
    this.maybeWake(agent);
    return `idle: waking it (${deliverer.id})`;
  }

  #push(agent: AgentRow, deliverer: Deliverer): void {
    void this.#deliver(agent, deliverer, false);
  }

  /** Wakes an idle agent if it has wake-worthy queued mail and budget left. */
  maybeWake(agent: AgentRow): void {
    if (agent.state !== "idle" || agent.muted || this.#mailbox.paused) return;
    const deliverer = this.delivererFor(agent);
    if (!deliverer) return;
    const pending = this.#mailbox.pending(agent.id);
    if (!pending.some((i) => this.wakeWorthy(i))) return;
    const { used, limit } = this.budget(agent);
    if (used >= limit) return;
    void this.#deliver(agent, deliverer, true);
  }

  async #deliver(agent: AgentRow, deliverer: Deliverer, isWake: boolean): Promise<void> {
    if (this.#inFlight.has(agent.id)) return;
    this.#inFlight.add(agent.id);
    try {
      const items = this.#mailbox.pending(agent.id).slice(0, 10);
      if (items.length === 0) return;
      const rendered = this.#mailbox.render(items, agent.name);
      const notice = renderWakeNotice(items.map((i) => this.#mailbox.renderItem(i)));
      const wakeWorthy = items.some((i) => this.wakeWorthy(i));
      const result = await withTimeout(
        deliverer.wake(agent, { rendered, notice, items, wakeWorthy }),
        25_000,
        `${deliverer.id} timed out`,
      );
      if (isWake) this.logWake(agent, items[0]?.message.from_addr ?? "?", deliverer.id);
      if (result.consumed) {
        this.#mailbox.markSeen(
          items.map((i) => i.delivery.id),
          isWake ? `wake:${deliverer.id}` : `push:${deliverer.id}`,
        );
      }
      this.#ctx.log.info("delivered via adapter", {
        agent: agent.name,
        deliverer: deliverer.id,
        consumed: result.consumed,
        count: items.length,
      });
    } catch (error) {
      this.#ctx.log.warn("adapter delivery failed; messages stay queued", {
        agent: agent.name,
        deliverer: deliverer.id,
        error: String(error),
      });
    } finally {
      this.#inFlight.delete(agent.id);
    }
  }

  #agentIdForDelivery(deliveryId: number): string | undefined {
    return (
      this.#ctx.store.get<{ to_agent_id: string | null }>(
        "SELECT to_agent_id FROM deliveries WHERE id = ?",
        deliveryId,
      )?.to_agent_id ?? undefined
    );
  }

  /**
   * Maintains flag files in `run/pending/`: `known-<pid>` for every live agent process and
   * `pid-<pid>` while it has queued mail. High-frequency hooks (PostToolUse, PreInvocation)
   * test these in plain sh and only start Node when there is mail or the process is new.
   */
  refreshPending(agentId: string): void {
    const agent = this.#registry.byId(agentId);
    const dir = this.#ctx.paths.pendingDir;
    const count = agent
      ? (this.#ctx.store.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM deliveries WHERE to_agent_id = ? AND state = 'queued'",
          agentId,
        )?.n ?? 0)
      : 0;
    const live = !!agent && isLive(agent);
    const active = count > 0 && live && !agent?.muted && !this.#mailbox.paused;
    try {
      // Drop flags that belonged to this agent under another pid (e.g. after a restart).
      const idle = live && agent?.state === "idle";
      for (const file of readdirSync(dir)) {
        if (!/^(pid|known|idle)-/.test(file)) continue;
        if (safeRead(join(dir, file)) !== agentId) continue;
        const keep =
          (live && file === `known-${agent?.pid}`) ||
          (active && file === `pid-${agent?.pid}`) ||
          (idle && file === `idle-${agent?.pid}`);
        if (!keep) rmSync(join(dir, file), { force: true });
      }
      if (live && agent?.pid) {
        writeFileSync(join(dir, `known-${agent.pid}`), agentId, { mode: 0o600 });
        // An idle agent's next hook must reach the daemon so it can be marked busy.
        if (idle) writeFileSync(join(dir, `idle-${agent.pid}`), agentId, { mode: 0o600 });
      }
      if (active && agent) {
        writeFileSync(join(dir, agentId), String(count), { mode: 0o600 });
        if (agent.pid) writeFileSync(join(dir, `pid-${agent.pid}`), agentId, { mode: 0o600 });
      } else {
        rmSync(join(dir, agentId), { force: true });
      }
    } catch (error) {
      this.#ctx.log.warn("pending flag update failed", { error: String(error) });
    }
  }

  refreshAll(): void {
    for (const agent of this.#registry.list({ includeOffline: true }))
      this.refreshPending(agent.id);
  }
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
