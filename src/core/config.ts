import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import { slugify } from "./addr.ts";
import { invalid } from "./errors.ts";
import type { Paths } from "./paths.ts";

export const ConfigSchema = z.object({
  /** This machine's owner handle, e.g. "pragnyan". Used in team addresses (handle/agent). */
  handle: z.string().min(1),
  /** Relay used when a command needs one and none is given (team create, short invite codes). */
  relay: z.string().optional(),
  wake: z
    .object({
      policy: z.enum(["asks", "never", "always"]).default("asks"),
      perSessionPerHour: z.number().int().positive().default(10),
      perRemoteSenderPerHour: z.number().int().positive().default(5),
      /** Wake idle agents running inside tmux by typing a one-line notice into their pane. */
      tmux: z.boolean().default(true),
    })
    .prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Short host name, e.g. "orin" for "orin.local"; how this machine appears to teammates. */
export function machineName(): string {
  return slugify(hostname().split(".")[0] ?? "", 24);
}

/** Default handle for a new install: the machine's short host name (handles are per device). */
export function defaultHandle(): string {
  const host = machineName();
  return host !== "x" ? host : slugify(userInfo().username || "me", 24);
}

export function loadConfig(paths: Paths): Config {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(paths.config, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw invalid(`cannot read ${paths.config}: ${(error as Error).message}`);
    }
  }
  const withHandle = { handle: defaultHandle(), ...(raw as object) };
  return ConfigSchema.parse(withHandle);
}

export function saveConfig(paths: Paths, config: Config): void {
  mkdirSync(dirname(paths.config), { recursive: true, mode: 0o700 });
  const tmp = `${paths.config}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ConfigSchema.parse(config), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, paths.config);
}

/** The public community relay; override with config "relay" or AGENTLINK_RELAY. */
export const COMMUNITY_RELAY = "wss://agentlink.agent7.dev";

export function defaultRelay(config: Pick<Config, "relay">): string {
  return process.env.AGENTLINK_RELAY || config.relay || COMMUNITY_RELAY;
}
