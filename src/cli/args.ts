import { type ParseArgsConfig, parseArgs } from "node:util";
import type { Paths } from "../core/paths.ts";
import { closest } from "../core/suggest.ts";
import type { Client } from "./client.ts";

export interface CliContext {
  paths: Paths;
  client: Client;
  json: boolean;
  /** --verbose: ids, delivery notes and other details. */
  verbose?: boolean;
  as?: string;
  argv: string[];
}

export type Command = (ctx: CliContext) => Promise<number>;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/** Like util.parseArgs, but with messages a person can act on ("did you mean --timeout?"). */
export function parse<O extends Options>(argv: string[], options: O) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    const message = (error as Error).message;
    const unknown = /Unknown option '([^']+)'/.exec(message);
    if (unknown) {
      const flag = unknown[1] as string;
      const guess = closest(flag.replace(/^-+/, ""), Object.keys(options));
      const looksLikeText = flag.length > 12 || /^-{3,}/.test(flag);
      throw new UsageError(
        `unknown option ${flag.slice(0, 40)}${guess ? ` (did you mean --${guess}?)` : ""}${
          looksLikeText ? '; to send text that starts with "-", put -- before it' : ""
        }`,
      );
    }
    const missing = /Option '([^']+)' argument missing/.exec(message);
    const flagName = (s: string | undefined) =>
      (s ?? "").replace(/^-\w, /, "").replace(/ <value>$/, "");
    if (missing) throw new UsageError(`${flagName(missing[1])} needs a value`);
    const noValue = /Option '([^']+)' does not take an argument/.exec(message);
    if (noValue) throw new UsageError(`${flagName(noValue[1])} does not take a value`);
    throw new UsageError(message.replace(/\. To specify a positional argument[\s\S]*$/, ""));
  }
}

export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Message text from positionals, or stdin with --stdin / when piped. */
export async function readText(positionals: string[], useStdin = false): Promise<string> {
  if (useStdin || (positionals.length === 0 && !process.stdin.isTTY)) {
    const piped = (await readAllStdin()).trim();
    return [positionals.join(" "), piped].filter(Boolean).join("\n\n");
  }
  return positionals.join(" ");
}

export function splitRecipients(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** "90", "90s", "7d" or compound "1h30m", "2m30s". */
const DURATION = /^(?:\d+(?:\.\d+)?|(?:\d+(?:\.\d+)?\s*(?:ms|s|m|h|d)\s*)+)$/;

/**
 * Lets a string option be given without a value (`--wait` alone means "the default"):
 * when the next word is not a duration, it is left as a positional.
 */
export function optionalValue(argv: string[], long: string, short?: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      out.push(...argv.slice(i));
      break;
    }
    if (arg === `--${long}` || (short && arg === `-${short}`)) {
      const next = argv[i + 1];
      if (next === undefined || !DURATION.test(next)) {
        out.push(`--${long}=`);
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}

/** Parses "90", "90s", "10m", "2h", "7d", "1h30m" into milliseconds (a bare number is in `unit`). */
export function parseDuration(
  value: string | undefined,
  fallbackMs: number,
  unit: "s" | "m" | "h" | "d" = "s",
): number {
  if (value === undefined || value === "") return fallbackMs;
  const v = value.trim();
  if (!DURATION.test(v))
    throw new UsageError(`invalid duration "${value}" (examples: 90s, 10m, 2h, 7d, 1h30m)`);
  if (/^[\d.]+$/.test(v)) return Math.round(Number(v) * (UNIT_MS[unit] as number));
  let ms = 0;
  for (const [, n, u] of v.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g))
    ms += Number(n) * (UNIT_MS[u as string] as number);
  return Math.round(ms);
}

/** An ISO date (passed through) or an age ("2d", "1h30m", "1w"; a bare number is days) as an ISO time. */
export function timeParam(value: string, now = Date.now()): string {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v;
  const weeks = /^(\d{1,4})w$/.exec(v);
  try {
    const ms = weeks ? Number(weeks[1]) * 604_800_000 : parseDuration(v, 0, "d");
    return new Date(now - ms).toISOString();
  } catch {
    throw new UsageError(
      `invalid time "${value}" (an age like 2h, 7d, 1w, or a date like 2026-01-31)`,
    );
  }
}

/** History filters shared by log and search. */
export const FILTER_OPTIONS = {
  from: { type: "string" },
  to: { type: "string" },
  kind: { type: "string", short: "k" },
  since: { type: "string" },
  until: { type: "string" },
  thread: { type: "string", short: "t" },
  repo: { type: "string" },
} as const;

export async function filterQuery(
  v: Partial<Record<keyof typeof FILTER_OPTIONS, string>>,
  q = new URLSearchParams(),
): Promise<URLSearchParams> {
  for (const key of ["from", "to", "thread", "repo"] as const) if (v[key]) q.set(key, v[key]);
  if (v.kind) {
    // Loaded only when needed: it pulls in zod, which every other command can skip.
    const { KINDS } = await import("../core/envelope.ts");
    const known = KINDS as readonly string[];
    const bad = v.kind.split(",").find((k) => k.trim() && !known.includes(k.trim()));
    if (bad !== undefined)
      throw new UsageError(`unknown --kind "${bad}" (kinds: ${KINDS.join(", ")})`);
    q.set("kind", v.kind);
  }
  if (v.since) q.set("since", timeParam(v.since));
  if (v.until) q.set("until", timeParam(v.until));
  return q;
}

export function out(ctx: CliContext, data: unknown, human: () => string): void {
  process.stdout.write(`${ctx.json ? JSON.stringify(data, null, 2) : human()}\n`);
}
