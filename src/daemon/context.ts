import type { Config } from "../core/config.ts";
import type { Logger } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { EventBus } from "./events.ts";
import type { Store } from "./store/db.ts";

export interface DaemonContext {
  paths: Paths;
  config: Config;
  store: Store;
  log: Logger;
  events: EventBus;
  now(): Date;
}

export const iso = (d: Date) => d.toISOString();
