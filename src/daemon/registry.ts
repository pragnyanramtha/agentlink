import { basename } from "node:path";
import { NAME_RE, slugify } from "../core/addr.ts";
import { AgentLinkError, invalid, notFound } from "../core/errors.ts";
import { repoInfo } from "../core/git.ts";
import { ulid } from "../core/ids.ts";
import { isAlive } from "../core/proc.ts";
import { type DaemonContext, iso } from "./context.ts";
import {
  type AgentRow,
  type AgentState,
  type CallerInfo,
  type Capabilities,
  parseJson,
} from "./types.ts";

export interface RegisterInput {
  tool: string;
  sessionId?: string;
  pid?: number;
  pidStart?: string;
  cwd?: string;
  name?: string;
  capabilities?: Capabilities;
  adapter?: Record<string, unknown>;
  state?: AgentState;
}

export const isLive = (a: Pick<AgentRow, "state">) => a.state === "busy" || a.state === "idle";

const OFFLINE_RETENTION_MS = 14 * 24 * 3600_000;
const PIDLESS_STALE_MS = 30 * 60_000;

export type StateListener = (agent: AgentRow, previous: AgentState) => void;

export class Registry {
  readonly #ctx: DaemonContext;
  readonly #listeners = new Set<StateListener>();

  constructor(ctx: DaemonContext) {
    this.#ctx = ctx;
  }

  onStateChange(fn: StateListener): void {
    this.#listeners.add(fn);
  }

  byId(id: string): AgentRow | undefined {
    return this.#ctx.store.get<AgentRow>("SELECT * FROM agents WHERE id = ?", id);
  }

  byName(name: string): AgentRow | undefined {
    return this.#ctx.store.get<AgentRow>("SELECT * FROM agents WHERE name = ?", name.toLowerCase());
  }

  bySession(tool: string, sessionId: string): AgentRow | undefined {
    return this.#ctx.store.get<AgentRow>(
      "SELECT * FROM agents WHERE tool = ? AND session_id = ? ORDER BY last_seen_at DESC LIMIT 1",
      tool,
      sessionId,
    );
  }

  byLivePid(tool: string, pid: number): AgentRow | undefined {
    return this.#ctx.store.get<AgentRow>(
      "SELECT * FROM agents WHERE tool = ? AND pid = ? AND state IN ('busy','idle') ORDER BY last_seen_at DESC LIMIT 1",
      tool,
      pid,
    );
  }

  require(nameOrId: string): AgentRow {
    const agent = this.byName(nameOrId) ?? this.byId(nameOrId);
    if (!agent) throw notFound(`agent "${nameOrId}"`);
    return agent;
  }

  list(opts: { includeOffline?: boolean } = {}): AgentRow[] {
    const where = opts.includeOffline ? "" : "WHERE state IN ('busy','idle')";
    return this.#ctx.store.all<AgentRow>(
      `SELECT * FROM agents ${where} ORDER BY CASE state WHEN 'busy' THEN 0 WHEN 'idle' THEN 1 WHEN 'stale' THEN 2 ELSE 3 END, last_seen_at DESC`,
    );
  }

  register(input: RegisterInput): { agent: AgentRow; created: boolean; resumed: boolean } {
    const { store } = this.#ctx;
    const now = iso(this.#ctx.now());
    const result = store.tx(() => {
      let existing = input.sessionId ? this.bySession(input.tool, input.sessionId) : undefined;
      if (!existing && input.pid) existing = this.byLivePid(input.tool, input.pid);
      const repo = input.cwd ? repoInfo(input.cwd) : undefined;

      if (existing) {
        const resumed = !isLive(existing);
        this.#update(existing, input, repo, now);
        if (input.name && input.name !== existing.name) this.rename(existing.id, input.name);
        return { id: existing.id, created: false, resumed };
      }

      const chosen = input.name
        ? this.#claimUserName(input.name)
        : this.#autoName(input.tool, repo?.name || basename(input.cwd ?? "") || "agent");
      if (chosen.takeover) {
        this.#update(chosen.takeover, { ...input, name: undefined }, repo, now, true);
        return { id: chosen.takeover.id, created: false, resumed: true };
      }
      const id = ulid();
      store.run(
        `INSERT INTO agents (id, name, name_source, tool, session_id, pid, pid_start, cwd, repo_root, repo_remote,
           branch, state, state_at, capabilities, adapter, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        chosen.name,
        input.name ? "user" : "auto",
        input.tool,
        input.sessionId ?? null,
        input.pid ?? null,
        input.pidStart ?? null,
        input.cwd ?? null,
        repo?.root ?? null,
        repo?.remote ?? null,
        repo?.branch ?? null,
        input.state ?? "idle",
        now,
        JSON.stringify(input.capabilities ?? {}),
        JSON.stringify(input.adapter ?? {}),
        now,
        now,
      );
      return { id, created: true, resumed: false };
    });
    const agent = this.byId(result.id) as AgentRow;
    this.#emit(agent);
    return { agent, created: result.created, resumed: result.resumed };
  }

  #update(
    row: AgentRow,
    input: RegisterInput,
    repo: ReturnType<typeof repoInfo> | undefined,
    now: string,
    takeover = false,
  ): void {
    const adapter = takeover
      ? (input.adapter ?? {})
      : { ...parseJson(row.adapter, {}), ...(input.adapter ?? {}) };
    const capabilities = { ...parseJson(row.capabilities, {}), ...(input.capabilities ?? {}) };
    const state = input.state ?? (isLive(row) ? row.state : "idle");
    this.#ctx.store.run(
      `UPDATE agents SET session_id = COALESCE(?, session_id), pid = COALESCE(?, pid),
         pid_start = CASE WHEN ? IS NULL THEN pid_start ELSE ? END,
         cwd = COALESCE(?, cwd), repo_root = COALESCE(?, repo_root), repo_remote = COALESCE(?, repo_remote),
         branch = COALESCE(?, branch), state = ?, state_at = CASE WHEN state = ? THEN state_at ELSE ? END,
         capabilities = ?, adapter = ?, last_seen_at = ?, stop_blocks = 0
       WHERE id = ?`,
      input.sessionId ?? null,
      input.pid ?? null,
      input.pid ?? null,
      input.pidStart ?? null,
      input.cwd ?? null,
      repo?.root ?? null,
      repo?.remote ?? null,
      repo?.branch ?? null,
      state,
      state,
      now,
      JSON.stringify(capabilities),
      JSON.stringify(adapter),
      now,
      row.id,
    );
  }

  #autoName(tool: string, repoName: string): { name: string; takeover?: AgentRow } {
    const base = `${slugify(tool, 16)}-${slugify(repoName, 40)}`;
    for (let i = 1; i < 100; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      const row = this.byName(name);
      if (!row) return { name };
      if (!isLive(row) && row.tool === tool && row.name_source === "auto") {
        return { name, takeover: row };
      }
    }
    return { name: `${base}-${ulid().slice(-6).toLowerCase()}` };
  }

  #claimUserName(raw: string): { name: string; takeover?: AgentRow } {
    const name = raw.trim().toLowerCase();
    if (!NAME_RE.test(name)) throw invalid(`invalid agent name "${raw}"`);
    const row = this.byName(name);
    if (!row) return { name };
    if (isLive(row)) {
      throw new AgentLinkError("name_taken", `name "${name}" is used by a running agent`, 409);
    }
    return { name, takeover: row };
  }

  /** Renames an agent. Taking a name held by an offline agent inherits its queued mail. */
  rename(agentId: string, raw: string): AgentRow {
    const name = raw.trim().toLowerCase();
    if (!NAME_RE.test(name)) throw invalid(`invalid agent name "${raw}"`);
    const { store } = this.#ctx;
    store.tx(() => {
      const holder = this.byName(name);
      if (holder && holder.id !== agentId) {
        if (isLive(holder)) {
          throw new AgentLinkError("name_taken", `name "${name}" is used by a running agent`, 409);
        }
        store.run(
          "UPDATE deliveries SET to_agent_id = ?, to_addr = ? WHERE to_agent_id = ? AND state IN ('queued','delivered','held')",
          agentId,
          name,
          holder.id,
        );
        store.run(
          "UPDATE agents SET name = ? WHERE id = ?",
          `${name}-prev-${holder.id.slice(-4).toLowerCase()}`,
          holder.id,
        );
      }
      store.run("UPDATE agents SET name = ?, name_source = 'user' WHERE id = ?", name, agentId);
    });
    const agent = this.byId(agentId);
    if (!agent) throw notFound(`agent ${agentId}`);
    this.#emit(agent);
    return agent;
  }

  setStatus(agentId: string, text: string | null): AgentRow {
    this.#ctx.store.run(
      "UPDATE agents SET status_text = ?, last_seen_at = ? WHERE id = ?",
      text,
      iso(this.#ctx.now()),
      agentId,
    );
    const agent = this.byId(agentId) as AgentRow;
    this.#emit(agent);
    return agent;
  }

  setMuted(agentId: string, muted: boolean): void {
    this.#ctx.store.run("UPDATE agents SET muted = ? WHERE id = ?", muted ? 1 : 0, agentId);
    const agent = this.byId(agentId);
    if (agent) this.#emit(agent);
  }

  setState(agentId: string, state: AgentState): AgentRow | undefined {
    const before = this.byId(agentId);
    if (!before) return undefined;
    const now = iso(this.#ctx.now());
    if (before.state === state) {
      this.#ctx.store.run("UPDATE agents SET last_seen_at = ? WHERE id = ?", now, agentId);
      return { ...before, last_seen_at: now };
    }
    this.#ctx.store.run(
      "UPDATE agents SET state = ?, state_at = ?, last_seen_at = ? WHERE id = ?",
      state,
      now,
      now,
      agentId,
    );
    const agent = this.byId(agentId) as AgentRow;
    this.#emit(agent);
    for (const fn of this.#listeners) {
      try {
        fn(agent, before.state);
      } catch (error) {
        this.#ctx.log.warn("state listener failed", { error: String(error) });
      }
    }
    return agent;
  }

  setStopBlocks(agentId: string, value: number): void {
    this.#ctx.store.run("UPDATE agents SET stop_blocks = ? WHERE id = ?", value, agentId);
  }

  /** Maps a CLI/MCP caller to the agent it runs inside (nearest registered ancestor). */
  resolveCaller(caller: CallerInfo): AgentRow | undefined {
    if (caller.as) return this.require(caller.as);
    if (caller.envAgent) {
      const agent = this.byId(caller.envAgent) ?? this.byName(caller.envAgent);
      if (agent) return agent;
    }
    const pids = caller.chain.map((p) => p.pid).filter((p) => Number.isInteger(p) && p > 1);
    if (pids.length === 0) return undefined;
    const rows = this.#ctx.store.all<AgentRow>(
      `SELECT * FROM agents WHERE pid IN (${pids.map(() => "?").join(",")}) ORDER BY last_seen_at DESC`,
      ...pids,
    );
    for (const proc of caller.chain) {
      const match = rows.find(
        (r) => r.pid === proc.pid && (!r.pid_start || !proc.start || r.pid_start === proc.start),
      );
      if (match) return match;
    }
    return undefined;
  }

  /** Marks agents whose process died as offline; prunes long-gone auto-named agents. */
  sweep(): void {
    const now = this.#ctx.now();
    for (const agent of this.#ctx.store.all<AgentRow>(
      "SELECT * FROM agents WHERE state IN ('busy','idle')",
    )) {
      if (agent.pid) {
        if (!isAlive(agent.pid, agent.pid_start ?? undefined)) this.setState(agent.id, "offline");
      } else if (now.getTime() - Date.parse(agent.last_seen_at) > PIDLESS_STALE_MS) {
        this.setState(agent.id, "stale");
      }
    }
    const cutoff = iso(new Date(now.getTime() - OFFLINE_RETENTION_MS));
    this.#ctx.store.run(
      `DELETE FROM agents WHERE state IN ('offline','stale') AND name_source = 'auto' AND last_seen_at < ?
         AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.to_agent_id = agents.id AND d.state IN ('queued','delivered','held'))`,
      cutoff,
    );
  }

  #emit(agent: AgentRow): void {
    this.#ctx.events.publish({ type: "agent", agent: agentView(agent) });
  }
}

export function agentView(a: AgentRow): Record<string, unknown> {
  const adapter = parseJson<Record<string, unknown>>(a.adapter, {});
  return {
    id: a.id,
    name: a.name,
    tool: a.tool,
    state: a.state,
    stateAt: a.state_at,
    lastSeenAt: a.last_seen_at,
    sessionId: a.session_id,
    pid: a.pid,
    cwd: a.cwd,
    repo: a.repo_remote ?? a.repo_root,
    branch: a.branch,
    status: a.status_text,
    muted: a.muted === 1,
    capabilities: parseJson(a.capabilities, {}),
    tmux: typeof adapter.tmuxPane === "string" ? adapter.tmuxPane : undefined,
    local: true,
  };
}
