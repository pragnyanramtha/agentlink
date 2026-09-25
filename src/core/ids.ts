import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  return Array.from(bytes, (b) => b % 32);
}

function incrementDigits(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    if ((next[i] ?? 0) < 31) {
      next[i] = (next[i] ?? 0) + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error("ulid random component overflow");
}

/** Monotonic ULID: lexicographically sortable by creation time. */
export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    lastRandom = incrementDigits(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomDigits();
  }
  let time = "";
  let t = lastTime;
  for (let i = 0; i < TIME_LEN; i++) {
    time = ENCODING.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  return time + lastRandom.map((d) => ENCODING.charAt(d)).join("");
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

/** Short random token for per-message boundary tags. */
export function boundaryToken(): string {
  return randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8).toLowerCase();
}
