import { basename } from "node:path";
import { NAME_RE, slugify } from "../core/addr.ts";
import { AgentLinkError, invalid, notFound } from "../core/errors.ts";
import { repoInfo } from "../core/git.ts";
import { ulid } from "../core/ids.ts";
import { isAlive } from "../core/proc.ts";
import { didYouMean } from "../core/suggest.ts";
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
    if (!agent) {
      const names = this.list({ includeOffline: true }).map((a) => a.name);
      throw new AgentLinkError(
        "not_found",
        `no agent named "${nameOrId}"${didYouMean(nameOrId, names)}; see: agentlink peers --all`,
        404,
      );
    }
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
        : this.#autoName(
            input.tool,
            repo?.name || basename(input.cwd ?? "") || "agent",
            repo?.branch ?? undefined,
          );
      if (chosen.takeover) {
        if (!input.pid) {
          // Never keep the previous session's process: it is gone, and a stale pid would make the
          // new session's own calls look like someone else's.
          this.#ctx.store.run(
            "UPDATE agents SET pid = NULL, pid_start = NULL WHERE id = ?",
            chosen.takeover.id,
          );
        }
        if (
          input.sessionId &&
          chosen.takeover.session_id &&
          input.sessionId !== chosen.takeover.session_id
        ) {
          // A different session taking over an offline agent's name starts with a clean status.
          this.#ctx.store.run(
            "UPDATE agents SET status_text = NULL WHERE id = ?",
            chosen.takeover.id,
          );
        }
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

  /**
   * `<tool>-<repo>`; a second live session in the same repo is told apart by its branch
   * (`claude-web-feat-login`) when it has one, and by a number otherwise.
   */
  /**
   * Names stay short: the first session of a tool is just `codex`. Another live session of the
   * same tool gets its repo (`codex-api`), then its branch (`codex-api-feat-login`), then a number.
   * A new session takes over an offline agent's name of the same tool, with the mail waiting for
   * it: "ask codex" goes to whichever Codex session runs next.
   */
  #autoName(
    tool: string,
    repoName: string,
    branch?: string,
  ): { name: string; takeover?: AgentRow } {
    const short = slugify(tool, 16);
    const withRepo = `${short}-${slugify(repoName, 40)}`;
    const byBranch =
      branch && !["main", "master", "HEAD", "trunk", "develop"].includes(branch)
        ? `${withRepo}-${slugify(branch, 24)}`
        : undefined;
    for (const name of [short, withRepo, ...(byBranch ? [byBranch] : [])]) {
      const row = this.byName(name);
      if (!row) return { name };
      if (!isLive(row) && row.tool === tool && row.name_source === "auto")
        return { name, takeover: row };
    }
    for (let i = 2; i < 100; i++) {
      const name = `${byBranch ?? withRepo}-${i}`;
      const row = this.byName(name);
      if (!row) return { name };
      if (!isLive(row) && row.tool === tool && row.name_source === "auto") {
        return { name, takeover: row };
      }
    }
    return { name: `${withRepo}-${ulid().slice(-6).toLowerCase()}` };
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
      const before = this.byId(agentId);
      store.run("UPDATE agents SET name = ?, name_source = 'user' WHERE id = ?", name, agentId);
      store.run("DELETE FROM agent_aliases WHERE name = ?", name);
      if (before && before.name !== name) {
        store.run(
          "INSERT OR REPLACE INTO agent_aliases (name, agent_id, created_at) VALUES (?, ?, ?)",
          before.name,
          agentId,
          new Date().toISOString(),
        );
      }
    });
    const agent = this.byId(agentId);
    if (!agent) throw notFound(`agent ${agentId}`);
    this.#emit(agent);
    return agent;
  }

  /** An agent by its current name, or by a name it had before a rename. */
  resolveName(name: string): { agent: AgentRow; renamedFrom?: string } | undefined {
    const current = this.byName(name);
    if (current) return { agent: current };
    const alias = this.#ctx.store.get<{ agent_id: string }>(
      "SELECT agent_id FROM agent_aliases WHERE name = ?",
      name.trim().toLowerCase(),
    );
    const agent = alias ? this.byId(alias.agent_id) : undefined;
    return agent ? { agent, renamedFrom: name } : undefined;
  }

  /** Names an agent had before renames (newest first). */
  aliasesOf(agentId: string): string[] {
    return this.#ctx.store
      .all<{ name: string }>(
        "SELECT name FROM agent_aliases WHERE agent_id = ? ORDER BY created_at DESC LIMIT 5",
        agentId,
      )
      .map((r) => r.name);
  }

  /** Re-checks a live agent's process right away (instead of waiting for the next sweep). */
  refreshLiveness(agent: AgentRow): AgentRow {
    if (isLive(agent) && agent.pid && !isAlive(agent.pid, agent.pid_start ?? undefined)) {
      return this.setState(agent.id, "offline") ?? agent;
    }
    return agent;
  }

  /** Forgets an agent; its undelivered mail expires. */
  remove(agentId: string): void {
    const agent = this.byId(agentId);
    if (!agent) return;
    this.#ctx.store.tx(() => {
      this.#ctx.store.run(
        "UPDATE deliveries SET state = 'expired', note = 'agent unregistered' WHERE to_agent_id = ? AND state IN ('queued','delivered','held')",
        agentId,
      );
      this.#ctx.store.run("DELETE FROM agents WHERE id = ?", agentId);
    });
    this.#ctx.events.publish({
      type: "agent",
      agent: { ...agentView(agent), state: "offline", removed: true },
    });
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
  /**
   * Which agent is calling. With a verified caller, identity comes only from the process tree:
   * `--as` is for humans acting for a hook-less agent, and AGENTLINK_AGENT must match the tree.
   */
  resolveCaller(caller: CallerInfo): AgentRow | undefined {
    const fromTree = this.#fromChain(caller.chain);
    if (caller.verified) {
      if (caller.as) {
        const target = this.resolveName(caller.as)?.agent ?? this.require(caller.as);
        // --as is for a person acting for a hook-less agent: a terminal, not some background process.
        if (!fromTree && !caller.tty) {
          throw new AgentLinkError(
            "forbidden",
            "--as works only from a terminal (a person acting for a hook-less agent)",
            403,
          );
        }
        if (fromTree && fromTree.id !== target.id) {
          throw new AgentLinkError(
            "forbidden",
            `an agent cannot act as another agent (you are ${fromTree.name})`,
            403,
          );
        }
        return target;
      }
      return fromTree;
    }
    if (caller.as) return this.require(caller.as);
    if (caller.envAgent) {
      const agent = this.byId(caller.envAgent) ?? this.byName(caller.envAgent);
      if (agent) return agent;
    }
    return fromTree;
  }

  #fromChain(chain: CallerInfo["chain"]): AgentRow | undefined {
    const caller = { chain };
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
