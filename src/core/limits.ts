import { createHash } from "node:crypto";

export const LIMITS = {
  threadMaxMessages: 30,
  replyMaxDepth: 12,
  pairRateWindowMs: 10 * 60_000,
  pairRateMax: 20,
  maxHops: 3,
  maxTextBytes: 64 * 1024,
  injectMaxChars: 8_000,
  echoWindow: 6,
  defaultTtlMs: 7 * 24 * 3600_000,
  wakePerSessionPerHour: 10,
  wakePerRemoteSenderPerHour: 5,
  cliAskDefaultWaitMs: 110_000,
  mcpAskDefaultWaitMs: 45_000,
  maxInboxBatch: 10,
  /** Unread messages an agent (or your inbox) may pile up before senders are told to wait. */
  maxUnreadPerRecipient: 500,
} as const;

/** Normalized content key for echo detection (case/whitespace/punctuation-insensitive). */
export function echoKey(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}
