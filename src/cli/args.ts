import { type ParseArgsConfig, parseArgs } from "node:util";
import type { Paths } from "../core/paths.ts";
import { closest } from "../core/suggest.ts";
import type { Client } from "./client.ts";

export interface CliContext {
  paths: Paths;
  client: Client;
  json: boolean;
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

const DURATION = /^\d+(?:\.\d+)?\s*(ms|s|m|h)?$/;

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

/** Parses "90", "90s", "10m", "2h" into milliseconds. */
export function parseDuration(
  value: string | undefined,
  fallbackMs: number,
  unit: "s" | "m" | "h" = "s",
): number {
  if (value === undefined || value === "") return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(value.trim());
  if (!m) throw new UsageError(`invalid duration "${value}" (examples: 90s, 10m, 2h)`);
  const n = Number(m[1]);
  const u = m[2] ?? unit;
  const factor = u === "ms" ? 1 : u === "s" ? 1_000 : u === "m" ? 60_000 : 3_600_000;
  return Math.round(n * factor);
}

export function out(ctx: CliContext, data: unknown, human: () => string): void {
  process.stdout.write(`${ctx.json ? JSON.stringify(data, null, 2) : human()}\n`);
}
