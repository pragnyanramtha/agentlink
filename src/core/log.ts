import { appendFileSync } from "node:fs";

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export function createLogger(opts: { file?: string; level?: Level; stderr?: boolean }): Logger {
  const min = ORDER[opts.level ?? (process.env.AGENTLINK_DEBUG ? "debug" : "info")];
  const write = (level: Level, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${
      data ? ` ${JSON.stringify(data)}` : ""
    }\n`;
    if (opts.file) {
      try {
        appendFileSync(opts.file, line, { mode: 0o600 });
      } catch {
        // logging must never crash the daemon
      }
    }
    if (opts.stderr) process.stderr.write(line);
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
