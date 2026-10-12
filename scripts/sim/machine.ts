// One simulated machine: a real agentlink daemon in its own process, on a sandbox
// AGENTLINK_HOME given by the worker (never ~/.agentlink). Writes sim-stats.jsonl (memory, fds,
// event-loop delay) and sim-crash.log (uncaught errors, which still crash it like the real one).
//   node scripts/sim/machine.ts '{"home":"/tmp/…/m0","verify":true,"sweepMs":1000}'
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { startStats } from "./lib.ts";

const cfg = JSON.parse(process.argv[2] ?? "{}") as {
  home: string;
  verify?: boolean;
  sweepMs?: number;
  statsMs?: number;
};
if (!cfg.home || !process.env.AGENTLINK_HOME || process.env.AGENTLINK_HOME !== cfg.home) {
  process.stderr.write("sim machine: AGENTLINK_HOME must be set to the sandbox home\n");
  process.exit(2);
}
process.umask(0o077);
const crashLog = join(cfg.home, "sim-crash.log");
process.on("uncaughtExceptionMonitor", (error, origin) => {
  appendFileSync(
    crashLog,
    `${new Date().toISOString()} ${origin} ${String((error as Error)?.stack ?? error)}\n`,
  );
});
process.on("warning", (w) =>
  appendFileSync(crashLog, `${new Date().toISOString()} warning ${w.name}: ${w.message}\n`),
);

const { createLogger } = await import("../../src/core/log.ts");
const { resolvePaths } = await import("../../src/core/paths.ts");
const { startDaemon } = await import("../../src/daemon/main.ts");
const paths = resolvePaths({ AGENTLINK_HOME: cfg.home, HOME: process.env.HOME } as never);
const daemon = await startDaemon({
  paths,
  logger: createLogger({ file: paths.log, level: "info" }),
  sweepMs: cfg.sweepMs ?? 1_000,
  ...(cfg.verify ? {} : { trustClientCaller: true }),
});
startStats(join(cfg.home, "sim-stats.jsonl"), cfg.statsMs ?? 2_000);
appendFileSync(join(cfg.home, "sim-ready"), `${process.pid}\n`);
process.send?.({ ready: true, pid: process.pid });
const stop = () => void daemon.close().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("disconnect", () => {
  // the worker went away: don't linger
  stop();
});
