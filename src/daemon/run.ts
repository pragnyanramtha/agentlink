import "../core/quiet-warnings.ts";
import { startDaemon } from "./main.ts";

// Daemon process entry: spawned detached by the CLI (`agentlink daemon start`).
process.umask(0o077); // everything the daemon creates (database, logs, sockets) is owner-only
startDaemon()
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
