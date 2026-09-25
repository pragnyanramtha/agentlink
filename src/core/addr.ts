import type { Addr } from "./envelope.ts";
import { invalid } from "./errors.ts";
import { normalizeRemote } from "./git.ts";

export type AddressSpec =
  /** A bare name: a local agent, or a teammate's front desk (resolved by the daemon). */
  | { kind: "name"; name: string }
  | { kind: "member-agent"; member: string; agent: string; team?: string }
  | { kind: "member"; member: string; team?: string }
  | { kind: "repo"; repo: string }
  | { kind: "a2a"; name: string };

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

function checkName(value: string, what: string): string {
  const v = value.trim().toLowerCase();
  if (!NAME_RE.test(v)) {
    throw invalid(
      `invalid ${what} "${value}": use lowercase letters, digits, '.', '_' or '-' (max 63 chars)`,
    );
  }
  return v;
}

function splitTeam(value: string): [string, string | undefined] {
  const at = value.lastIndexOf("@");
  if (at <= 0) return [value, undefined];
  return [value.slice(0, at), checkName(value.slice(at + 1), "team")];
}

/**
 * Parses a user-facing address:
 *   name · member/agent · member/agent@team · @member · @member@team · repo:<remote> · a2a:<name>
 */
export function parseAddress(input: string): AddressSpec {
  const raw = input.trim();
  if (!raw) throw invalid("empty address");
  if (raw.startsWith("repo:")) return { kind: "repo", repo: normalizeRemote(raw.slice(5)) };
  if (raw.startsWith("a2a:"))
    return { kind: "a2a", name: checkName(raw.slice(4), "a2a agent name") };
  if (raw.startsWith("@")) {
    const [member, team] = splitTeam(raw.slice(1));
    return { kind: "member", member: checkName(member, "member"), ...(team ? { team } : {}) };
  }
  if (raw.includes("/")) {
    const [left, right = ""] = raw.split("/", 2) as [string, string?];
    const [agent, team] = splitTeam(right);
    return {
      kind: "member-agent",
      member: checkName(left, "member"),
      agent: checkName(agent, "agent name"),
      ...(team ? { team } : {}),
    };
  }
  return { kind: "name", name: checkName(raw, "agent name") };
}

export function specToString(spec: AddressSpec): string {
  switch (spec.kind) {
    case "name":
      return spec.name;
    case "member-agent":
      return `${spec.member}/${spec.agent}${spec.team ? `@${spec.team}` : ""}`;
    case "member":
      return `@${spec.member}${spec.team ? `@${spec.team}` : ""}`;
    case "repo":
      return `repo:${spec.repo}`;
    case "a2a":
      return `a2a:${spec.name}`;
  }
}

/** Canonical string for an envelope address, relative to the local member handle. */
export function formatAddr(addr: Addr, localMember?: string): string {
  if (addr.role === "system") return "agentlink";
  if (addr.role === "human" || !addr.agent) {
    return `@${addr.member}${addr.team ? `@${addr.team}` : ""}`;
  }
  if (addr.team) return `${addr.member}/${addr.agent}@${addr.team}`;
  if (localMember && addr.member !== localMember) return `${addr.member}/${addr.agent}`;
  return addr.agent;
}

/** Turns arbitrary text (repo dir names, git user names) into a valid name fragment. */
export function slugify(value: string, max = 40): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+/g, "-")
    .replace(/[-._]+$/, "")
    .slice(0, max)
    .replace(/[-._]+$/, "");
  return slug || "x";
}
