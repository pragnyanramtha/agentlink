import "../core/quiet-warnings.ts";
import { startDaemon } from "./main.ts";

// Daemon process entry: spawned detached by the CLI (`agentlink daemon start`).
process.umask(0o077); // everything the daemon creates (database, logs, sockets) is owner-only
// Runs only while needed: stops after 10 minutes without agent sessions or clients.
startDaemon({ idleExitMs: 10 * 60_000, onIdleExit: () => process.exit(0) })
  .then((daemon) => {
    const stop = () => void daemon.close().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    process.on("SIGHUP", stop);
  })
  .catch((error: Error) => {
    process.stderr.write(`agentlink daemon: ${error.message}\n`);
    process.exit(error.message.includes("already running") ? 0 : 1);
  });
