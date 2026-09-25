import { type ParseArgsConfig, parseArgs } from "node:util";
import type { Paths } from "../core/paths.ts";
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

export function parse<O extends Options>(argv: string[], options: O) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
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

/** Parses "90", "90s", "10m", "2h" into milliseconds. */
export function parseDuration(
  value: string | undefined,
  fallbackMs: number,
  unit: "s" | "m" = "s",
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
