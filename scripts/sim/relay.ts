// The simulation's team relay in its own process (so it can be killed and restarted).
//   node scripts/sim/relay.ts '{"dataDir":"/tmp/…/relay","host":"0.0.0.0","port":47910,"createToken":"…"}'
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { startStats } from "./lib.ts";

const cfg = JSON.parse(process.argv[2] ?? "{}") as {
  dataDir: string;
  host: string;
  port: number;
  createToken?: string;
};
const crashLog = join(cfg.dataDir, "sim-crash.log");
process.on("uncaughtExceptionMonitor", (error, origin) => {
  appendFileSync(
    crashLog,
    `${new Date().toISOString()} ${origin} ${String((error as Error)?.stack ?? error)}\n`,
  );
});
const { createLogger } = await import("../../src/core/log.ts");
const { startRelay } = await import("../../src/relay/server.ts");
const relay = await startRelay({
  dataDir: cfg.dataDir,
  host: cfg.host,
  port: cfg.port,
  logger: createLogger({ file: join(cfg.dataDir, "relay.log"), level: "info" }),
  ...(cfg.createToken ? { createToken: cfg.createToken } : {}),
});
startStats(join(cfg.dataDir, "sim-stats.jsonl"), 2_000);
process.send?.({ ready: true, pid: process.pid, url: relay.url });
const stop = () => void relay.close().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("disconnect", stop);
