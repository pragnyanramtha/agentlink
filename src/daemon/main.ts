import "../core/quiet-warnings.ts";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { loadConfig } from "../core/config.ts";
import { createLogger, type Logger } from "../core/log.ts";
import { type Paths, resolvePaths } from "../core/paths.ts";
import { applyPeerLookupStatus, probePeerLookup } from "../core/peer.ts";
import { isAlive, procInfo } from "../core/proc.ts";
import { socketlessFs } from "../core/wsl.ts";
import { Claims } from "./claims.ts";
import type { DaemonContext } from "./context.ts";
import {
  claudeInboxDeliverer,
  codexQueueDeliverer,
  OpenCodeBridge,
  tmuxDeliverer,
} from "./deliverers.ts";
import { DeliveryEngine } from "./delivery.ts";
import { EventBus } from "./events.ts";
import { HookHandler } from "./hooks.ts";
import { Mailbox } from "./mailbox.ts";
import { DesktopNotifier } from "./notify.ts";
import { isLive, Registry } from "./registry.ts";
import { createDaemonServer, type Services } from "./server.ts";
import { Store } from "./store/db.ts";
import { TeamManager } from "./team-manager.ts";
import { type UiOptions, UiServer } from "./ui-server.ts";

export interface RunningDaemon {
  services: Services;
  close(): Promise<void>;
}

/** True if something answers on the socket. */
export function socketAlive(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path);
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

/**
 * Exclusive startup lock (O_EXCL lock file holding pid:start). Several hooks may try to start
 * the daemon at the same moment; exactly one wins, the rest exit as "already running".
 */
function acquireLock(runDir: string): () => void {
  const lockPath = join(runDir, "daemon.lock");
  const me = `${process.pid}:${procInfo(process.pid)?.start ?? ""}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, me);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(lockPath, "utf8") === me) rmSync(lockPath, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder = "";
      try {
        holder = readFileSync(lockPath, "utf8");
      } catch {
        continue; // removed between our open and read: retry
      }
      const [pidText, start] = holder.split(":");
      const pid = Number(pidText);
      if (pid && pid !== process.pid && isAlive(pid, start || undefined)) {
        throw new Error(`agentlink daemon already running (pid ${pid})`);
      }
      rmSync(lockPath, { force: true }); // stale lock from a crashed daemon
    }
  }
  throw new Error("agentlink daemon already running (lost the startup race)");
}

export async function startDaemon(
  opts: {
    paths?: Paths;
    logger?: Logger;
    now?: () => Date;
    sweepMs?: number;
    /** Tests only: accept the caller identity the client claims. */
    trustClientCaller?: boolean;
    /**
     * Stop after this long with no running agent session and no open client connection. The
     * daemon starts again by itself on the next hook or command. Off when unset.
     */
    idleExitMs?: number;
    onIdleExit?: () => void;
    /** Tests only: what the web UI knows about the system. */
    ui?: UiOptions;
  } = {},
): Promise<RunningDaemon> {
  const paths = opts.paths ?? resolvePaths();
  const socketDir = dirname(paths.socket);
  for (const dir of new Set([paths.home, socketDir])) {
    const fs = socketlessFs(dir);
    if (fs) {
      throw new Error(
        `${dir} is on a ${fs} filesystem (a Windows drive under WSL?), where Unix sockets and database locks don't work; set AGENTLINK_HOME to a Linux path, e.g. export AGENTLINK_HOME=~/.agentlink`,
      );
    }
  }
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  if (socketDir !== paths.runDir) {
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    const st = lstatSync(socketDir);
    if (!st.isDirectory() || st.uid !== process.getuid?.()) {
      throw new Error(
        `socket directory ${socketDir} is not a directory owned by you; refusing to use it`,
      );
    }
  }
  chmodSync(paths.home, 0o700);
  chmodSync(paths.runDir, 0o700);
  const releaseLock = acquireLock(paths.runDir);
  try {
    if (await socketAlive(paths.socket)) {
      throw new Error(`agentlink daemon already running (${paths.socket})`);
    }
    if (existsSync(paths.socket)) rmSync(paths.socket, { force: true }); // stale socket file
  } catch (error) {
    releaseLock();
    throw error;
  }

  const log = opts.logger ?? createLogger({ file: paths.log });
  const store = new Store(paths.db);
  // The database holds message bodies: owner-only, including SQLite's side files.
  for (const f of [paths.db, `${paths.db}-wal`, `${paths.db}-shm`]) {
    try {
      chmodSync(f, 0o600);
    } catch {
      // created later, under the daemon's umask
    }
  }
  const ctx: DaemonContext = {
    paths,
    config: loadConfig(paths),
    store,
    log,
    events: new EventBus(),
    now: opts.now ?? (() => new Date()),
  };
  const registry = new Registry(ctx);
  const mailbox = new Mailbox(ctx, registry);
  const engine = new DeliveryEngine(ctx, registry, mailbox);
  const opencode = new OpenCodeBridge();
  engine.use(opencode);
  engine.use(codexQueueDeliverer());
  engine.use(claudeInboxDeliverer());
  engine.use(tmuxDeliverer(ctx));
  const hooks = new HookHandler(ctx, registry, mailbox, engine);
  const claims = new Claims(ctx);
  const team = new TeamManager(ctx, registry, mailbox, engine);
  const notifier = new DesktopNotifier(ctx, mailbox);
  const stopNotifier = notifier.start();
  const services: Services = {
    ctx,
    registry,
    mailbox,
    engine,
    hooks,
    claims,
    opencode,
    team,
    notifier,
    ...(opts.trustClientCaller ? { trustClientCaller: true } : {}),
  };

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      clearInterval(sweep);
      clearInterval(expiry);
      stopNotifier();
      team.stop();
      void ui.close();
      server.close(() => {
        rmSync(paths.socket, { force: true });
        rmSync(paths.pidFile, { force: true });
        // Let aborted requests (waits ending) finish their last reads before the database closes.
        setTimeout(() => {
          store.close();
          releaseLock();
          log.info("daemon stopped");
          resolve();
        }, 50);
      });
      server.closeAllConnections();
    });
    return closing;
  };

  const server = createDaemonServer(services, () => void close());
  const ui = new UiServer(server.dispatch, ctx, registry, opts.ui);
  services.ui = ui;
  if (!opts.trustClientCaller && process.platform === "linux") {
    // Where the kernel can never name callers (WSL 1, no unix_diag), fall back to claims loudly
    // instead of refusing every request; elsewhere an unnamed caller stays refused.
    const peer = await probePeerLookup(socketDir);
    applyPeerLookupStatus(peer);
    if (peer.state === "missing" || peer.state === "broken")
      log.warn(`cannot verify which agent is calling: ${peer.reason}; trusting client claims`, {
        remedy: peer.remedy,
      });
    else if (peer.state === "inconclusive")
      log.warn("caller check self-test inconclusive", { reason: peer.reason });
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, () => resolve());
    });
  } catch (error) {
    store.close();
    releaseLock();
    throw error;
  }
  chmodSync(paths.socket, 0o600);
  writeFileSync(paths.pidFile, String(process.pid), { mode: 0o600 });

  registry.sweep();
  engine.refreshAll();
  team.resume();
  let lastActivity = Date.now();
  server.on("request", () => {
    lastActivity = Date.now();
  });
  let lastPrune = 0;
  const sweep = setInterval(() => {
    try {
      registry.sweep();
    } catch (error) {
      log.warn("sweep failed", { error: String(error) });
    }
    // Config retention: prune finished messages at most hourly (follows config reloads).
    const days = ctx.config.retention?.days;
    if (days && Date.now() - lastPrune >= 3_600_000) {
      lastPrune = Date.now();
      try {
        const pruned = mailbox.prune(Math.max(days * 86_400_000, 3_600_000));
        if (pruned.messages) log.info("retention pruned messages", pruned);
      } catch (error) {
        log.warn("retention prune failed", { error: String(error) });
      }
    }
    if (!opts.idleExitMs) return;
    if (registry.list().some(isLive) || ui.connections > 0) {
      lastActivity = Date.now();
      return;
    }
    server.getConnections((error, open) => {
      if (error || open > 0 || Date.now() - lastActivity < (opts.idleExitMs as number)) return;
      log.info(
        `no agent sessions for ${Math.round((opts.idleExitMs as number) / 60_000)} min; stopping (starts again when needed)`,
      );
      void close().then(() => opts.onIdleExit?.());
    });
  }, opts.sweepMs ?? 5_000);
  const expiry = setInterval(() => {
    try {
      mailbox.expireSweep();
    } catch (error) {
      log.warn("expiry sweep failed", { error: String(error) });
    }
  }, 60_000);
  sweep.unref();
  expiry.unref();

  log.info("daemon started", { pid: process.pid, socket: paths.socket });
  return { services, close };
}
