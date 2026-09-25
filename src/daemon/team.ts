import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DeviceKeys, generateDeviceKeys } from "../core/crypto.ts";
import type { Paths } from "../core/paths.ts";

export interface TeamState {
  relay: string;
  teamId: string;
  teamName: string;
  teamKey: string;
  handle: string;
  admin: boolean;
  joinedAt: string;
}

function writeSecret(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** This machine's device identity, created on first use (~/.agentlink/keys/device.json, 0600). */
export function deviceKeys(paths: Paths): DeviceKeys {
  const path = join(paths.keysDir, "device.json");
  const existing = readJson<DeviceKeys>(path);
  if (existing) return existing;
  const keys = generateDeviceKeys();
  writeSecret(path, keys);
  return keys;
}

const teamPath = (paths: Paths) => join(paths.home, "team.json");

export function loadTeam(paths: Paths): TeamState | undefined {
  return readJson<TeamState>(teamPath(paths));
}

export function saveTeam(paths: Paths, team: TeamState): void {
  writeSecret(teamPath(paths), team);
}

export function clearTeam(paths: Paths): void {
  rmSync(teamPath(paths), { force: true });
}
