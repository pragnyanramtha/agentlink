import { invalid } from "../core/errors.ts";
import { ulid } from "../core/ids.ts";
import { type DaemonContext, iso } from "./context.ts";
import type { AgentRow } from "./types.ts";

export interface ClaimRow {
  id: string;
  agent_id: string;
  repo_key: string;
  pattern: string;
  reason: string | null;
  created_at: string;
  expires_at: string;
  released_at: string | null;
}

/** Minimal glob → RegExp: `**` (any depth), `*` (within a segment), `?`, braces not supported. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const staticPrefix = (glob: string) => glob.split(/[*?]/, 1)[0] ?? "";

/** Heuristic: two globs overlap if one matches the other's literal prefix, or prefixes nest. */
export function patternsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  if (globToRegExp(a).test(pb) || globToRegExp(b).test(pa)) return true;
  const aGlob = pa !== a;
  const bGlob = pb !== b;
  return (aGlob && pb.startsWith(pa)) || (bGlob && pa.startsWith(pb));
}

export function repoKey(agent: AgentRow): string {
  return agent.repo_remote ?? agent.repo_root ?? agent.cwd ?? `agent:${agent.id}`;
}

export class Claims {
  readonly #ctx: DaemonContext;

  constructor(ctx: DaemonContext) {
    this.#ctx = ctx;
  }

  active(repo?: string): ClaimRow[] {
    const now = iso(this.#ctx.now());
    return repo
      ? this.#ctx.store.all<ClaimRow>(
          "SELECT * FROM claims WHERE repo_key = ? AND released_at IS NULL AND expires_at > ? ORDER BY created_at",
          repo,
          now,
        )
      : this.#ctx.store.all<ClaimRow>(
          "SELECT * FROM claims WHERE released_at IS NULL AND expires_at > ? ORDER BY created_at",
          now,
        );
  }

  claim(
    agent: AgentRow,
    patterns: string[],
    ttlMinutes: number,
    reason?: string,
  ): { claims: ClaimRow[]; conflicts: ClaimRow[] } {
    if (patterns.length === 0) throw invalid("give at least one path or glob to claim");
    if (ttlMinutes <= 0 || ttlMinutes > 24 * 60)
      throw invalid("ttl must be between 1 minute and 24 hours");
    const key = repoKey(agent);
    const others = this.active(key).filter((c) => c.agent_id !== agent.id);
    const conflicts = others.filter((c) => patterns.some((p) => patternsOverlap(p, c.pattern)));
    const now = this.#ctx.now();
    const created: ClaimRow[] = [];
    this.#ctx.store.tx(() => {
      for (const pattern of patterns) {
        this.#ctx.store.run(
          "UPDATE claims SET released_at = ? WHERE agent_id = ? AND repo_key = ? AND pattern = ? AND released_at IS NULL",
          iso(now),
          agent.id,
          key,
          pattern,
        );
        const row: ClaimRow = {
          id: ulid(),
          agent_id: agent.id,
          repo_key: key,
          pattern,
          reason: reason ?? null,
          created_at: iso(now),
          expires_at: iso(new Date(now.getTime() + ttlMinutes * 60_000)),
          released_at: null,
        };
        this.#ctx.store.run(
          "INSERT INTO claims (id, agent_id, repo_key, pattern, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          row.id,
          row.agent_id,
          row.repo_key,
          row.pattern,
          row.reason,
          row.created_at,
          row.expires_at,
        );
        created.push(row);
      }
    });
    return { claims: created, conflicts };
  }

  release(agent: AgentRow, patterns: string[] | "all"): number {
    const now = iso(this.#ctx.now());
    if (patterns === "all") {
      return this.#ctx.store.run(
        "UPDATE claims SET released_at = ? WHERE agent_id = ? AND released_at IS NULL",
        now,
        agent.id,
      ).changes;
    }
    let n = 0;
    for (const p of patterns) {
      n += this.#ctx.store.run(
        "UPDATE claims SET released_at = ? WHERE agent_id = ? AND pattern = ? AND released_at IS NULL",
        now,
        agent.id,
        p,
      ).changes;
    }
    return n;
  }

  /** Active claims by other agents in the same repo that cover `relPath`. */
  conflictsFor(agent: AgentRow, relPath: string): ClaimRow[] {
    return this.active(repoKey(agent)).filter(
      (c) => c.agent_id !== agent.id && globToRegExp(c.pattern).test(relPath),
    );
  }
}
