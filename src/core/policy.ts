import { KINDS, type Kind, WAKE_KINDS } from "./envelope.ts";

/**
 * Who a message comes from, from the recipient's point of view.
 * - user: the human owner of this machine, via the CLI
 * - local: another agent on this machine
 * - teammate: an agent of a paired team member (via relay)
 * - external: an A2A agent or other non-team sender
 */
export const TRUSTS = ["user", "local", "teammate", "external"] as const;
export type Trust = (typeof TRUSTS)[number];

export const POLICY_ACTIONS = ["deliver", "hold", "refuse"] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];
export type PolicyOverrides = Partial<Record<Kind, PolicyAction>>;

const all = (action: PolicyAction): Record<Kind, PolicyAction> =>
  Object.fromEntries(KINDS.map((k) => [k, action])) as Record<Kind, PolicyAction>;

export const DEFAULT_POLICY: Record<Trust, Record<Kind, PolicyAction>> = {
  user: all("deliver"),
  local: all("deliver"),
  // Teammates: everything is delivered with a provenance banner; the receiving agent decides.
  teammate: all("deliver"),
  external: { ...all("deliver"), handoff: "hold", request: "hold" },
};

export function decidePolicy(trust: Trust, kind: Kind, overrides?: PolicyOverrides): PolicyAction {
  return overrides?.[kind] ?? DEFAULT_POLICY[trust][kind];
}

/**
 * Whether a message of this kind may wake an idle recipient. Replies wake only when the
 * original message expected an answer (the asker is waiting for it).
 */
export function wakeEligible(kind: Kind, trust: Trust, answersExpectingMessage: boolean): boolean {
  if (trust === "external") return false;
  if (WAKE_KINDS.has(kind)) return true;
  return (kind === "reply" || kind === "review_result") && answersExpectingMessage;
}
