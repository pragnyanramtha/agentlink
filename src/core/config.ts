import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import { slugify } from "./addr.ts";
import { invalid } from "./errors.ts";
import type { Paths } from "./paths.ts";

export const ConfigSchema = z.object({
  /** This machine's owner handle, e.g. "pragnyan". Used in team addresses (handle/agent). */
  handle: z.string().min(1),
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

export function defaultHandle(): string {
  let name: string | undefined;
  try {
    name = execFileSync("git", ["config", "--global", "user.name"], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\s+/)[0];
  } catch {
    // git missing or unset
  }
  return slugify(name || userInfo().username || "me", 24);
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
