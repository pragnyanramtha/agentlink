import { realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  HARNESSES,
  type HeadlessConfig,
  HeadlessSchema,
  loadConfig,
  MODEL_RE,
  PROFILES,
  saveConfig,
} from "../core/config.ts";
import { AckSchema, KINDS, KindSchema, PartSchema, textOf } from "../core/envelope.ts";
import { AgentLinkError, forbidden, invalid } from "../core/errors.ts";
import { identityLine, modelShort } from "../core/identity.ts";
import { LIMITS } from "../core/limits.ts";
import { peerLookupAvailable, peerPid, stdinIsTty } from "../core/peer.ts";
import { DEFAULT_POLICY, POLICY_ACTIONS, TRUSTS } from "../core/policy.ts";
import { ancestry, isAlive, procCwd, procInfo } from "../core/proc.ts";
import { scanSecrets } from "../core/redact.ts";
import { didYouMean } from "../core/suggest.ts";
import { PROTOCOL_VERSION, VERSION } from "../version.ts";
import type { Claims } from "./claims.ts";
import type { DaemonContext } from "./context.ts";
import type { OpenCodeBridge } from "./deliverers.ts";
import type { DeliveryEngine } from "./delivery.ts";
import type { DaemonEvent } from "./events.ts";
import { type Headless, parseRunRef, type RunRow } from "./headless.ts";
import { type HookHandler, HookRequestSchema } from "./hooks.ts";
import type { InboxTarget, Mailbox, MessageFilter } from "./mailbox.ts";
import type { DesktopNotifier } from "./notify.ts";
import { agentView, isLive, type Registry } from "./registry.ts";
import { BIN_NAMES, checkBin, executable, findBin, RUNNERS } from "./runners/index.ts";
import type { TeamManager } from "./team-manager.ts";
import {
  type AgentRow,
  type CallerInfo,
  type InboxItem,
  type MessageRow,
  type Sender,
  toolLabel,
} from "./types.ts";
import type { UiServer } from "./ui-server.ts";

/**
 * Runs one request through the daemon's routes. With `as`, the caller is that in-process human
 * (the web UI) and the body is already parsed; it is never resolved to an agent.
 */
export type Dispatch = (
  raw: IncomingMessage,
  res: ServerResponse,
  url: URL,
  as?: { caller: CallerInfo; body: unknown },
) => Promise<void>;

export interface Services {
  ctx: DaemonContext;
  registry: Registry;
  mailbox: Mailbox;
  engine: DeliveryEngine;
  hooks: HookHandler;
  claims: Claims;
  opencode: OpenCodeBridge;
  team: TeamManager;
  notifier: DesktopNotifier;
  headless: Headless;
  ui?: UiServer;
  /** Tests only: take the caller's claimed process tree/TTY at face value. */
  trustClientCaller?: boolean;
}

interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  caller: CallerInfo;
  agent?: AgentRow;
  signal: AbortSignal;
  raw: IncomingMessage;
  res: ServerResponse;
}

type Handler = (req: Req) => unknown | Promise<unknown>;
const STREAM = Symbol("stream");

const CallerSchema = z.object({
  pid: z.number().default(0),
  chain: z
    .array(
      z.object({
        pid: z.number(),
        ppid: z.number(),
        start: z.string().optional(),
        cmd: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  tty: z.boolean().default(false),
  as: z.string().optional(),
  envAgent: z.string().optional(),
});

function parseCaller(header: string | string[] | undefined): CallerInfo {
  if (typeof header !== "string" || !header) return { pid: 0, chain: [], tty: false };
  try {
    const parsed = CallerSchema.safeParse(
      JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    );
    if (parsed.success) {
      const { as, envAgent, ...rest } = parsed.data;
      return { ...rest, ...(as ? { as } : {}), ...(envAgent ? { envAgent } : {}) };
    }
  } catch {
    // fall through
  }
  return { pid: 0, chain: [], tty: false };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4 * 1024 * 1024) throw invalid("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalid("request body is not valid JSON");
  }
}

function requireHuman(req: Req, needTty = true): void {
  if (req.agent) {
    throw forbidden(
      `only a person can do this, and this command runs inside the agent session "${req.agent.name}" (commands started from an agent, including its "!" shell prefix, count as the agent). Run it in a separate terminal.`,
    );
  }
  if (needTty && !req.caller.tty) throw forbidden("run this from an interactive terminal");
}

function requireAgent(req: Req): AgentRow {
  if (!req.agent) {
    throw invalid("this command must run inside an agent session (or pass --as <agent-name>)");
  }
  return req.agent;
}

const sender = (req: Req): Sender =>
  req.agent ? { kind: "agent", agent: req.agent } : { kind: "human" };
const viewer = (req: Req): InboxTarget => (req.agent ? { agent: req.agent } : { human: true });

const SendSchema = z.object({
  to: z.array(z.string()).optional(),
  kind: KindSchema.default("info"),
  text: z.string().optional(),
  parts: z.array(PartSchema).optional(),
  replyTo: z.string().optional(),
  thread: z.string().optional(),
  taskId: z.string().optional(),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(30 * 60_000)
    .optional(),
  ttlMs: z.number().int().positive().optional(),
  ack: AckSchema.optional(),
  force: z.boolean().optional(),
  replyAll: z.boolean().optional(),
});

const RegisterSchema = z.object({
  tool: z.string().min(1).default("generic"),
  sessionId: z.string().optional(),
  pid: z.number().int().positive().optional(),
  pidStart: z.string().optional(),
  cwd: z.string().optional(),
  name: z.string().optional(),
  capabilities: z.record(z.string(), z.boolean()).optional(),
  adapter: z.record(z.string(), z.unknown()).optional(),
  state: z.enum(["busy", "idle"]).optional(),
  model: z.string().max(200).optional(),
  title: z.string().max(400).optional(),
});

const Decision = z.enum(["allow", "hold", "refuse"]);
const Path = z.string().min(1).max(4096);
const HeadlessPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  runner: z
    .strictObject({
      harness: z.enum(HARNESSES),
      enabled: z.boolean().optional(),
      profile: z.enum(PROFILES).optional(),
      model: z.string().regex(MODEL_RE).nullable().optional(),
      bin: Path.optional(),
    })
    .optional(),
  addRoot: Path.optional(),
  removeRoot: Path.optional(),
  set: z.record(z.string(), z.union([z.number(), Decision, z.null()])).optional(),
});
const LIMIT_KEYS = [
  "maxConcurrent",
  "perAgentPerHour",
  "globalPerHour",
  "spawnPerHour",
  "perThreadRuns",
  "timeoutSec",
  "maxBudgetUsd",
  "maxSpawnDepth",
] as const;
const FROM_KEYS = ["local.wake", "local.spawn", "teammate.wake"] as const;
const WaitMs = z
  .number()
  .int()
  .min(0)
  .max(30 * 60_000)
  .optional();
// strict: a request can never carry a profile, a binary or flags of its own.
const SpawnSchema = z.strictObject({
  harness: z.enum(HARNESSES),
  task: z.string().min(1).max(LIMITS.maxTextBytes),
  cwd: Path.optional(),
  name: z.string().min(1).max(63).optional(),
  model: z.string().regex(MODEL_RE).optional(),
  waitMs: WaitMs,
});
const WakeSchema = z.strictObject({
  agent: z.string().min(1).max(200),
  text: z.string().max(LIMITS.maxTextBytes).optional(),
  waitMs: WaitMs,
});
const ENDED = ["done", "failed", "stopped", "denied"];

export function createDaemonServer(
  s: Services,
  shutdown: () => void,
): Server & { dispatch: Dispatch } {
  const { ctx, registry, mailbox, engine } = s;
  const routes: { method: string; re: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, pattern: string, handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp(
      `^${pattern.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
        keys.push(k);
        return "([^/]+)";
      })}$`,
    );
    routes.push({ method, re, keys, handler });
  };

  const itemView = (item: InboxItem, who: InboxTarget) => ({
    delivery: mailbox.deliveryView(item.delivery),
    message: mailbox.messageView(item.message, who),
    text: textOf(item.envelope),
    attachments: mailbox.renderItem(item).attachments,
    ...(item.envelope.meta.ack ? { ack: item.envelope.meta.ack } : {}),
  });

  const replyView = (m: MessageRow, who: InboxTarget) => {
    const env = mailbox.envelopeOf(m);
    return {
      message: mailbox.messageView(m, who),
      text: textOf(env),
      ...(env.meta.ack ? { ack: env.meta.ack } : {}),
    };
  };

  // ------------------------------------------------------------------ meta
  route("GET", "/v1/health", () => ({
    ok: true,
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    home: ctx.paths.home,
    handle: ctx.config.handle,
    paused: mailbox.paused,
    agents: registry.list().length,
  }));

  // How this machine is addressed by teammates (its team handle), plus its host name.
  const selfHandle = () => mailbox.remote?.selfHandle ?? ctx.config.handle;
  route("GET", "/v1/whoami", (req) => ({
    agent: req.agent
      ? { ...agentView(req.agent), address: `${selfHandle()}/${req.agent.name}` }
      : null,
    handle: selfHandle(),
    host: hostname(),
    team: mailbox.remote?.teamName ?? null,
    paused: mailbox.paused,
  }));

  route("POST", "/v1/config/reload", (req) => {
    requireHuman(req, false);
    const before = ctx.config.handle;
    ctx.config = loadConfig(ctx.paths);
    return { handle: ctx.config.handle, changed: before !== ctx.config.handle };
  });

  route("GET", "/v1/overview", (req) => {
    const count = (sql: string) => ctx.store.get<{ n: number }>(sql)?.n ?? 0;
    const tally = (states: string[]) => {
      const out = { busy: 0, idle: 0, offline: 0 };
      for (const st of states) out[st === "busy" || st === "idle" ? st : "offline"] += 1;
      return out;
    };
    const team = s.team.status().team as
      | { name: string; relay: string; connected: boolean }
      | null
      | undefined;
    const members = s.team.client?.members() ?? [];
    const page = (pragma: string) =>
      Number(Object.values(ctx.store.get(`PRAGMA ${pragma}`) ?? {})[0] ?? 0);
    return {
      version: VERSION,
      pid: process.pid,
      handle: selfHandle(),
      host: hostname(),
      paused: mailbox.paused,
      team: team
        ? {
            name: team.name,
            relay: team.relay,
            connected: team.connected,
            members: new Set(members.map((m) => m.handle)).size,
            membersOnline: new Set(members.filter((m) => m.online).map((m) => m.handle)).size,
          }
        : null,
      agents: {
        local: tally(registry.list({ includeOffline: true }).map((a) => a.state)),
        remote: tally((s.team.client?.remoteAgents() ?? []).map((a) => String(a.state))),
      },
      ...mailbox.counts(viewer(req)),
      ...(req.agent
        ? {}
        : {
            held:
              count("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'held'") +
              count("SELECT COUNT(*) AS n FROM runs WHERE state = 'held'"),
          }),
      outbox: count("SELECT COUNT(*) AS n FROM outbox"),
      db: {
        messages: count("SELECT COUNT(*) AS n FROM messages"),
        bytes: page("page_count") * page("page_size"),
      },
    };
  });

  route("POST", "/v1/prune", (req) => {
    requireHuman(req);
    const body = z
      .object({
        olderThanMs: z
          .number()
          .int()
          .min(3_600_000)
          .max(100 * 365 * 86_400_000),
        dryRun: z.boolean().default(false),
      })
      .parse(req.body);
    return mailbox.prune(body.olderThanMs, body.dryRun);
  });

  route("POST", "/v1/notify/test", (req) => {
    requireHuman(req, false);
    return s.notifier.test();
  });

  route("POST", "/v1/shutdown", (req) => {
    requireHuman(req, false);
    setTimeout(shutdown, 50);
    return { ok: true };
  });

  // A person at a terminal (like approvals) gets a one-time link into the local web UI.
  route("POST", "/v1/ui/session", (req) => {
    requireHuman(req);
    const body = z
      .object({ port: z.number().int().min(1024).max(65535).optional() })
      .parse(req.body);
    if (!s.ui) throw invalid("the web UI is not available in this daemon");
    return s.ui.session(body.port);
  });

  // ------------------------------------------------------------------ agents
  route("POST", "/v1/agents/register", (req) => {
    const input = RegisterSchema.parse(req.body);
    if (input.pid && !isAlive(input.pid)) throw invalid(`no running process with pid ${input.pid}`);
    if (req.agent && input.pid && input.pid !== req.agent.pid) {
      throw forbidden(`an agent can only register itself (you are ${req.agent.name})`);
    }
    // One process, one identity: a second name for a live process would be a look-alike.
    const holder = input.pid
      ? registry.list().find((a) => a.pid === input.pid && isLive(a))
      : undefined;
    if (holder && input.name && holder.name !== input.name.trim().toLowerCase()) {
      throw new AgentLinkError(
        "name_taken",
        `process ${input.pid} is already registered as ${holder.name} (rename it with: agentlink name <new-name> --agent ${holder.name})`,
        409,
      );
    }
    const previous = input.pid ? registry.byLivePid(input.tool, input.pid) : undefined;
    // The agent's own working directory decides its repo, not the shell that registered it.
    const cwd = (input.pid ? procCwd(input.pid) : undefined) ?? input.cwd;
    const pidStart = input.pidStart ?? (input.pid ? procInfo(input.pid)?.start : undefined);
    const { agent, created, resumed } = registry.register({
      tool: input.tool,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.pid ? { pid: input.pid } : {}),
      ...(pidStart ? { pidStart } : {}),
      ...(cwd ? { cwd } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      ...(input.adapter ? { adapter: input.adapter } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.title ? { title: input.title } : {}),
      state: input.state ?? "busy",
    });
    // Does the registering shell belong to the new agent? (Decides the "read your mail" hint.)
    const self = !!input.pid && req.caller.chain.some((p) => p.pid === input.pid);
    const renamedFrom = previous && previous.name !== agent.name ? previous.name : undefined;
    return {
      agent: agentView(agent),
      created,
      resumed,
      self,
      ...(renamedFrom ? { renamedFrom } : {}),
    };
  });

  route("DELETE", "/v1/agents/:name", (req) => {
    const agent = registry.require(req.params.name as string);
    if (req.agent && req.agent.id !== agent.id)
      throw forbidden("agents can only unregister themselves");
    registry.remove(agent.id);
    return { removed: agent.name };
  });

  route("GET", "/v1/agents", (req) => {
    const all = req.query.get("all") === "1";
    const local = registry.list({ includeOffline: all }).map((a) => ({
      ...agentView(a),
      address: `${selfHandle()}/${a.name}`,
      host: hostname(),
      local: true,
      wakeVia: engine.delivererFor(a)?.id ?? null,
    }));
    const remote = (s.team.client?.remoteAgents() ?? [])
      .filter((a) => all || a.state === "busy" || a.state === "idle")
      .map((a) => ({
        id: `${a.deviceId}:${a.name}`,
        name: `${a.member}/${a.name}`,
        member: a.member,
        tool: a.tool,
        harness: toolLabel(a.tool),
        model: a.model ?? null,
        modelShort: a.model ? modelShort(a.model) : null,
        title: a.title ?? null,
        project: a.project ?? null,
        dir: a.project ?? null,
        identity: identityLine({
          name: `${a.member}/${a.name}`,
          harness: toolLabel(a.tool),
          model: a.model ?? null,
          dir: a.project ?? null,
          branch: a.branch ?? null,
          title: a.title ?? null,
          host: a.host ?? null,
        }),
        state: a.state,
        stateAt: a.stateAt ?? a.at,
        lastSeenAt: a.at,
        repo: a.repo ?? null,
        branch: a.branch ?? null,
        status: a.status ?? null,
        muted: false,
        capabilities: {},
        reach: a.reach ?? null,
        address: `${a.member}/${a.name}`,
        host: a.host ?? null,
        tag: a.sid ?? null,
        local: false,
      }));
    return {
      agents: [...local, ...remote],
      paused: mailbox.paused,
      team: mailbox.remote?.teamName ?? null,
      you: { handle: selfHandle(), host: hostname() },
    };
  });

  // ------------------------------------------------------------------ team (relay)
  route("GET", "/v1/team", () => s.team.status());

  route("POST", "/v1/team/create", async (req) => {
    // Agents may do this when their user asks; their CLI's permission prompt confirms it.
    const body = z
      .object({
        name: z.string().min(1),
        relay: z.string().min(1).optional(),
        handle: z.string().optional(),
        createToken: z.string().optional(),
      })
      .parse(req.body);
    return s.team.create(body.name, body.relay, body.handle, body.createToken);
  });

  route("POST", "/v1/team/invite", async (req) => {
    // Agents may do this when their user asks; their CLI's permission prompt confirms it.
    const body = z
      .object({
        uses: z.number().int().min(1).max(100).default(1),
        ttlMs: z
          .number()
          .int()
          .positive()
          .default(24 * 3600_000),
        code: z.boolean().default(true),
      })
      .parse(req.body);
    return s.team.invite(body.uses, body.ttlMs, { code: body.code });
  });

  route("POST", "/v1/team/join", async (req) => {
    // Agents may do this when their user asks; their CLI's permission prompt confirms it.
    const body = z
      .object({
        invite: z.string().min(1),
        handle: z.string().optional(),
        relay: z.string().optional(),
      })
      .parse(req.body);
    return s.team.join(body.invite, body.handle, body.relay);
  });

  route("POST", "/v1/team/relay", async (req) => {
    requireHuman(req, false);
    const body = z.object({ url: z.string().min(1) }).parse(req.body);
    return s.team.setRelay(body.url);
  });

  route("POST", "/v1/team/leave", (req) => {
    requireHuman(req, false);
    s.team.leave();
    return { ok: true };
  });

  route("POST", "/v1/agents/rename", (req) => {
    const body = z.object({ name: z.string(), agent: z.string().optional() }).parse(req.body);
    const target = body.agent ? registry.require(body.agent) : requireAgent(req);
    if (req.agent && req.agent.id !== target.id)
      throw forbidden("agents can only rename themselves");
    return { agent: agentView(registry.rename(target.id, body.name)) };
  });

  route("POST", "/v1/agents/status", (req) => {
    const body = z.object({ text: z.string().max(200).nullable() }).parse(req.body);
    // Status text is shown to teammates on other machines.
    const secrets = body.text ? scanSecrets(body.text) : [];
    if (secrets.length) {
      throw invalid(
        `your status looks like it contains a secret (${[...new Set(secrets.map((f) => f.type))].join(", ")})`,
      );
    }
    return { agent: agentView(registry.setStatus(requireAgent(req).id, body.text || null)) };
  });

  // ------------------------------------------------------------------ messages
  route("POST", "/v1/messages", async (req) => {
    const input = SendSchema.parse(req.body);
    const result = mailbox.send(sender(req), {
      kind: input.kind,
      ...(input.to ? { to: input.to } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.parts ? { parts: input.parts } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.thread ? { thread: input.thread } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
      ...(input.ack ? { ack: input.ack } : {}),
      ...(input.force ? { force: true } : {}),
      ...(input.replyAll ? { replyAll: true } : {}),
      wait: !!input.waitMs,
    });
    const notes = engine.onQueued(result.queued);
    const deliveries = result.deliveries.map((d) => ({
      ...d,
      note:
        notes.get(d.id as number) ??
        (d.state === "seen" && d.method === "longpoll"
          ? `delivered (${d.to} was waiting for this answer)`
          : d.state === "held"
            ? "held until a person on that machine approves it (agentlink approvals)"
            : d.state === "refused"
              ? "refused by policy"
              : d.state === "delivered" && String(d.to).startsWith("@")
                ? `stored for ${d.to} (they read it with: agentlink inbox)`
                : String(d.state)),
    }));
    let reply: ReturnType<typeof replyView> | undefined;
    let failed: { to: string; state: string; note: string | null }[] | undefined;
    let timedOut = false;
    const reachable = result.deliveries.some((d) =>
      ["queued", "sent", "delivered", "seen"].includes(String(d.state)),
    );
    let replies: ReturnType<typeof replyView>[] | undefined;
    const offline = result.deliveries
      .filter((d) => ["queued", "sent"].includes(String(d.state)))
      .every((d) => {
        const to = String(d.to);
        if (to.includes("/") || to.startsWith("@")) {
          const [handle, agent] = to.startsWith("@")
            ? [to.slice(1), undefined]
            : (to.split("/") as [string, string]);
          if (handle === mailbox.handle || !mailbox.remote) return false;
          // A teammate's agent is reachable only while its session runs, not just its daemon.
          return agent
            ? !mailbox.remote.agentOnline(handle, agent)
            : !mailbox.remote.online(handle);
        }
        const agent = registry.byName(to);
        // An offline agent being woken headlessly can still answer.
        const run = agent ? s.headless.activeFor(agent.id) : undefined;
        return !!agent && !isLive(agent) && (!run || run.state === "held");
      });
    let offlineNote: string | undefined;
    if (input.waitMs && reachable && mailbox.paused) {
      timedOut = true; // nothing is delivered while paused, so there is nothing to wait for
    } else if (input.waitMs && reachable && offline && result.deliveries.length > 0) {
      timedOut = true;
      const remoteOnly = result.deliveries.every((d) => String(d.to).includes("/"));
      offlineNote =
        remoteOnly && mailbox.remote && !mailbox.remote.connected() ? "relay" : "offline";
    } else if (input.waitMs && reachable) {
      const expected = result.deliveries.filter((d) =>
        ["queued", "sent", "delivered", "seen"].includes(String(d.state)),
      ).length;
      const outcome = await mailbox.waitForReplies(
        String(result.message.id),
        expected,
        input.waitMs,
        req.signal,
      );
      if (outcome.replies.length) {
        replies = outcome.replies.map((m) => replyView(m, viewer(req)));
        reply = replies[0];
      }
      if (outcome.failed.length && !outcome.replies.length) {
        failed = outcome.failed.map((d) => ({ to: d.to_addr, state: d.state, note: d.note }));
      }
      timedOut = outcome.timedOut;
    } else if (input.waitMs) {
      failed = result.deliveries.map((d) => ({
        to: String(d.to),
        state: String(d.state),
        note: typeof d.note === "string" ? d.note : null,
      }));
    }
    return {
      message: result.message,
      deliveries,
      ...(reply ? { reply } : {}),
      ...(replies && replies.length > 1 ? { replies } : {}),
      ...(failed ? { failed } : {}),
      ...(mailbox.paused ? { paused: true } : {}),
      ...(offlineNote
        ? { offline: true, ...(offlineNote === "relay" ? { relayDown: true } : {}) }
        : {}),
      waited: !!input.waitMs,
      timedOut,
      asHuman: !req.agent,
      // A plain reply in a group reaches only the sender; say so (feedback: this surprised agents).
      ...(input.kind === "reply" && input.replyTo && !input.replyAll
        ? (() => {
            const others = mailbox.participants(
              mailbox.envelopeOf(mailbox.resolveMessage(input.replyTo)),
            ).length;
            return others > 2 ? { groupHint: true } : {};
          })()
        : {}),
    };
  });

  route("GET", "/v1/todo", (req) => {
    const target = req.agent ? { agent: req.agent } : ({ human: true } as const);
    return { items: mailbox.todo(target).map((i) => itemView(i, target)) };
  });

  route("GET", "/v1/inbox", async (req) => {
    if (req.agent?.muted) {
      const text = `agentlink: ${req.agent.name} is muted; messages wait until your user runs \`agentlink unmute ${req.agent.name}\`.`;
      return req.query.get("format") === "inject"
        ? { count: 0, text, muted: true }
        : { items: [], muted: true };
    }
    if (req.agent && mailbox.paused) {
      // The kill switch covers reads too: a paused agent sees nothing until you resume.
      const text =
        "agentlink is paused: no messages are delivered until your user runs `agentlink resume`.";
      return req.query.get("format") === "inject"
        ? { count: 0, text, paused: true }
        : { items: [], paused: true };
    }
    const target = req.agent ? { agent: req.agent } : ({ human: true } as const);
    const unreadOnly = req.query.get("all") !== "1";
    const limit = Math.min(Number(req.query.get("limit") ?? 20) || 20, 200);
    const waitMs = Math.min(Number(req.query.get("waitMs") ?? 0) || 0, 30 * 60_000);
    let items = mailbox.inbox(target, { unreadOnly, limit });
    if (items.length === 0 && waitMs > 0) {
      await mailbox.waitForInbox(target, waitMs, req.signal);
      items = mailbox.inbox(target, { unreadOnly, limit });
    }
    if (req.query.get("peek") !== "1") {
      mailbox.markSeen(
        items
          .filter((i) => ["queued", "delivered"].includes(i.delivery.state))
          .map((i) => i.delivery.id),
        "cli",
      );
    }
    if (req.query.get("format") === "inject") {
      return {
        count: items.length,
        text: mailbox.render(items, req.agent?.name ?? `@${ctx.config.handle}`),
      };
    }
    return { items: items.map((i) => itemView(i, target)) };
  });

  // Agents see only messages they sent or received (not held or refused); you see everything.
  const takesPart = (agent: AgentRow, message: MessageRow): boolean =>
    mailbox.visibleTo({ agent }, message);

  route("GET", "/v1/messages/:id", (req) => {
    const message = mailbox.resolveMessage(req.params.id as string, viewer(req));
    const envelope = mailbox.envelopeOf(message);
    const deliveries = mailbox.deliveriesOf(message.id);
    const mine = deliveries.filter((d) =>
      req.agent
        ? d.to_agent_id === req.agent.id
        : d.to_agent_id === null && d.to_addr === `@${ctx.config.handle}`,
    );
    if (req.query.get("peek") !== "1") {
      mailbox.markSeen(
        mine.filter((d) => ["queued", "delivered"].includes(d.state)).map((d) => d.id),
        "cli",
      );
    }
    const part = req.query.get("part");
    if (part) {
      const index = Number(part) - 1;
      const p = envelope.parts[index];
      if (!p) throw invalid(`message has ${envelope.parts.length} part(s)`);
      return { message: mailbox.messageView(message, viewer(req)), part: p };
    }
    return {
      message: mailbox.messageView(message, viewer(req)),
      text: textOf(envelope),
      attachments: mailbox.renderItem({
        delivery: deliveries[0] ?? (mine[0] as never),
        message,
        envelope,
      }).attachments,
      deliveries: deliveries.map((d) => mailbox.deliveryView(d)),
      ...(req.query.get("raw") === "1" ? { envelope } : {}),
    };
  });

  route("POST", "/v1/messages/:id/ack", (req) => {
    const body = z
      .object({ ack: AckSchema.default("processed"), note: z.string().optional() })
      .parse(req.body);
    const result = mailbox.send(sender(req), {
      kind: "ack",
      replyTo: req.params.id as string,
      text: body.note?.trim() || body.ack,
      ack: body.ack,
    });
    engine.onQueued(result.queued);
    return { message: result.message, deliveries: result.deliveries };
  });

  route("GET", "/v1/threads/:id", (req) => {
    const thread = mailbox.resolveThread(req.params.id as string, viewer(req));
    const all = mailbox.thread(thread);
    const visible = req.agent
      ? all.filter(({ message }) => takesPart(req.agent as AgentRow, message))
      : all;
    return {
      thread,
      messages: visible.map(({ message, deliveries }) => ({
        message: mailbox.messageView(message, viewer(req)),
        text: textOf(mailbox.envelopeOf(message)),
        deliveries: deliveries.map((d) => mailbox.deliveryView(d)),
      })),
    };
  });

  route("POST", "/v1/threads/:id/allow", (req) => {
    requireHuman(req);
    const body = z.object({ extra: z.number().int().min(1).max(100) }).parse(req.body);
    mailbox.allowThread(req.params.id as string, body.extra);
    return { ok: true };
  });

  // History filters (log, search). Times: ISO (2026-01-31, 2026-01-31T12:00:00Z) or an age (2h).
  const AGE_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
  const When = z.string().transform((s, c) => {
    const age = /^(\d{1,6})([mhdw])$/.exec(s.trim());
    const ms = age
      ? ctx.now().getTime() - Number(age[1]) * AGE_MS[age[2] as keyof typeof AGE_MS]
      : /^\d{4}-\d{2}-\d{2}/.test(s)
        ? Date.parse(s)
        : Number.NaN;
    const at = new Date(ms);
    if (Number.isNaN(at.getTime())) {
      c.addIssue({
        code: "custom",
        message: "use an ISO time (2026-01-31 or 2026-01-31T12:00:00Z) or an age (30m, 2h, 7d, 1w)",
      });
      return z.NEVER;
    }
    return at.toISOString();
  });
  const FilterSchema = z.object({
    from: z.string().trim().min(1).max(200).optional(),
    to: z.string().trim().min(1).max(200).optional(),
    kind: z
      .string()
      .transform((s) =>
        s
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
      )
      .pipe(z.array(KindSchema).min(1))
      .optional(),
    since: When.optional(),
    until: When.optional(),
    thread: z.string().trim().min(1).max(100).optional(),
    repo: z.string().trim().min(1).max(300).optional(),
  });
  const filterOf = (req: Req): MessageFilter => {
    const { kind, thread, ...rest } = FilterSchema.parse(Object.fromEntries(req.query));
    return {
      ...rest,
      ...(kind ? { kinds: kind } : {}),
      ...(thread ? { thread: mailbox.resolveThread(thread, viewer(req)) } : {}),
    };
  };
  const Paging = (max: number, def: number) =>
    z.object({
      limit: z.coerce.number().int().min(1).max(max).default(def),
      offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    });

  route("GET", "/v1/search", (req) => {
    const { q, limit, offset } = Paging(100, 20)
      .extend({ q: z.string().max(500).optional() })
      .parse(Object.fromEntries(req.query));
    return {
      results: mailbox.search(viewer(req), filterOf(req), q, limit, offset),
      fts: mailbox.fts,
    };
  });

  route("GET", "/v1/threads", (req) => {
    const q = Paging(100, 20)
      .extend({
        with: z.string().trim().min(1).max(200).optional(),
        open: z.enum(["0", "1", "true", "false"]).optional(),
      })
      .parse(Object.fromEntries(req.query));
    return {
      threads: mailbox.threads(viewer(req), {
        limit: q.limit,
        offset: q.offset,
        ...(q.with ? { with: q.with } : {}),
        open: q.open === "1" || q.open === "true",
      }),
    };
  });

  route("GET", "/v1/log", (req) => {
    const limit = Math.min(Number(req.query.get("limit") ?? 30) || 30, 500);
    // In a team, local names are shown as full addresses so a pasted log means the same anywhere.
    const full = (name: string) =>
      mailbox.remote && !name.includes("/") && !name.startsWith("@")
        ? `${mailbox.handle}/${name}`
        : name;
    const visible = mailbox.history(
      viewer(req),
      { ...filterOf(req), mine: req.query.get("mine") === "1" },
      limit,
    );
    return {
      messages: visible.map((m) => {
        const view = mailbox.messageView(m, viewer(req));
        return {
          message: { ...view, from: full(String(view.from)) },
          deliveries: mailbox.deliveriesOf(m.id).map((d) => {
            const dv = mailbox.deliveryView(d);
            return { ...dv, to: full(String(dv.to)) };
          }),
        };
      }),
    };
  });

  route("GET", "/v1/events", (req) => {
    req.res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    req.res.write(": connected\n\n");
    // Like the log: an agent sees only events about messages it sent or received.
    const visible = (event: DaemonEvent): boolean => {
      if (!req.agent || event.type === "agent" || event.type === "notice") return true;
      const id = event.type === "message" ? event.message.id : event.delivery.messageId;
      const message = ctx.store.get<MessageRow>("SELECT * FROM messages WHERE id = ?", String(id));
      return !!message && takesPart(req.agent, message);
    };
    const unsubscribe = ctx.events.subscribe((event) => {
      if (visible(event)) req.res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const ping = setInterval(() => req.res.write(": ping\n\n"), 15_000);
    req.raw.on("close", () => {
      unsubscribe();
      clearInterval(ping);
    });
    return STREAM;
  });

  // ------------------------------------------------------------------ claims
  route("POST", "/v1/claims", (req) => {
    const body = z
      .object({
        patterns: z.array(z.string().min(1)).min(1),
        ttlMinutes: z.number().positive().default(60),
        reason: z.string().max(200).optional(),
      })
      .parse(req.body);
    const agent = requireAgent(req);
    const { claims, conflicts } = s.claims.claim(
      agent,
      body.patterns,
      body.ttlMinutes,
      body.reason,
    );
    const view = (c: (typeof claims)[number]) => ({
      id: c.id,
      pattern: c.pattern,
      agent: registry.byId(c.agent_id)?.name ?? c.agent_id,
      reason: c.reason,
      repo: c.repo_key,
      createdAt: c.created_at,
      expiresAt: c.expires_at,
    });
    return { claims: claims.map(view), conflicts: conflicts.map(view) };
  });

  route("POST", "/v1/claims/release", (req) => {
    const body = z
      .object({ patterns: z.array(z.string()).optional(), all: z.boolean().optional() })
      .parse(req.body);
    const agent = requireAgent(req);
    return {
      released: s.claims.release(agent, body.all || !body.patterns?.length ? "all" : body.patterns),
    };
  });

  route("GET", "/v1/claims", () => ({
    claims: s.claims.active().map((c) => ({
      id: c.id,
      pattern: c.pattern,
      agent: registry.byId(c.agent_id)?.name ?? c.agent_id,
      reason: c.reason,
      repo: c.repo_key,
      createdAt: c.created_at,
      expiresAt: c.expires_at,
    })),
  }));

  // ------------------------------------------------------------------ policy / approvals / control
  route("GET", "/v1/policy", () => ({
    defaults: DEFAULT_POLICY,
    overrides: ctx.store.all(
      "SELECT scope, kind, action FROM policy_overrides ORDER BY scope, kind",
    ),
  }));

  route("POST", "/v1/policy", (req) => {
    requireHuman(req);
    const body = z
      .object({
        scope: z.string().min(1),
        kind: z.enum(KINDS),
        action: z.enum(POLICY_ACTIONS).nullable(),
      })
      .parse(req.body);
    const members = s.team.client?.handles() ?? [];
    if (!(TRUSTS as readonly string[]).includes(body.scope) && !members.includes(body.scope)) {
      throw invalid(
        `unknown policy scope "${body.scope}"${didYouMean(body.scope, [...TRUSTS, ...members])}; use ${TRUSTS.join(", ")}${members.length ? `, or a teammate (${members.join(", ")})` : ""}`,
      );
    }
    if (body.action === null) {
      ctx.store.run(
        "DELETE FROM policy_overrides WHERE scope = ? AND kind = ?",
        body.scope,
        body.kind,
      );
    } else {
      ctx.store.run(
        `INSERT INTO policy_overrides (scope, kind, action) VALUES (?, ?, ?)
         ON CONFLICT(scope, kind) DO UPDATE SET action = excluded.action`,
        body.scope,
        body.kind,
        body.action,
      );
    }
    return { ok: true };
  });

  route("GET", "/v1/approvals", (req) => {
    requireHuman(req, false);
    return {
      items: [...mailbox.held().map((i) => itemView(i, viewer(req))), ...s.headless.approvals()],
    };
  });

  route("POST", "/v1/approvals/:id", (req) => {
    requireHuman(req);
    const body = z.object({ decision: z.enum(["approve", "deny"]) }).parse(req.body);
    const raw = String(req.params.id).replace(/^#/, "");
    // Held headless runs are R<n> (agentlink approve R12).
    if (/^r\d+$/i.test(raw)) {
      const run = s.headless.decide(parseRunRef(raw) as number, body.decision, ctx.config.handle);
      return { run: s.headless.view(run) };
    }
    let deliveryId = Number(raw);
    if (!/^\d+$/.test(raw)) {
      const held = mailbox
        .deliveriesOf(mailbox.resolveMessage(raw).id)
        .filter((d) => d.state === "held");
      if (held.length !== 1) {
        throw invalid(
          held.length === 0
            ? `message ${raw} has nothing held (see: agentlink approvals)`
            : `message ${raw} is held for several recipients; use one of #${held.map((d) => d.id).join(", #")}`,
        );
      }
      deliveryId = (held[0] as { id: number }).id;
    }
    const item = mailbox.decide(deliveryId, body.decision, ctx.config.handle);
    if (body.decision === "approve") engine.onQueued([item]);
    return { item: itemView(item, viewer(req)) };
  });

  route("POST", "/v1/control", (req) => {
    const body = z
      .object({
        action: z.enum(["pause", "resume", "mute", "unmute"]),
        agent: z.string().optional(),
      })
      .parse(req.body);
    if (body.action !== "pause") requireHuman(req);
    if (body.action === "pause" || body.action === "resume") {
      ctx.store.setMeta("paused", body.action === "pause" ? "1" : undefined);
      if (body.action === "pause") s.headless.pauseAll();
      else s.headless.resume();
      engine.refreshAll();
      if (body.action === "resume") for (const a of registry.list()) engine.maybeWake(a);
      ctx.events.publish({ type: "notice", level: "info", text: `agentlink ${body.action}d` });
      return { paused: body.action === "pause" };
    }
    if (!body.agent) throw invalid("which agent?");
    const agent = registry.require(body.agent);
    registry.setMuted(agent.id, body.action === "mute");
    if (body.action === "unmute") engine.maybeWake(registry.byId(agent.id) as AgentRow);
    return { agent: agentView(registry.byId(agent.id) as AgentRow) };
  });

  // ------------------------------------------------------------------ headless runs
  const headlessView = () => {
    const h = ctx.config.headless;
    return {
      ...h,
      runners: HARNESSES.map((harness) => {
        const r = h.runners[harness];
        const profile = r?.profile ?? "read-only";
        const sample = (resume: boolean) =>
          RUNNERS[harness].argv({
            resume,
            sessionId: "<session>",
            cwd: "<dir>",
            profile,
            ...(r?.model ? { model: r.model } : {}),
            ...(h.maxBudgetUsd ? { maxBudgetUsd: h.maxBudgetUsd } : {}),
          });
        return {
          harness,
          enabled: !!r?.enabled,
          profile,
          model: r?.model ?? null,
          bin: s.headless.bin(harness) ?? null,
          experimental: !!RUNNERS[harness].experimental,
          argv: { new: sample(false).argv, resume: sample(true).argv },
          env: sample(false).env ?? null,
        };
      }),
      running: s.headless.running,
    };
  };

  // Agents may read the settings; only a person at a terminal changes them.
  route("GET", "/v1/headless", () => headlessView());

  route("POST", "/v1/headless", (req) => {
    requireHuman(req);
    const patch = HeadlessPatchSchema.parse(req.body);
    const config = loadConfig(ctx.paths);
    const h: HeadlessConfig = structuredClone(config.headless);
    if (patch.enabled !== undefined) h.enabled = patch.enabled;
    if (patch.runner) {
      const { harness, bin, model, ...rest } = patch.runner;
      const current = h.runners[harness] ?? { enabled: false, profile: "read-only" as const };
      const found = bin
        ? checkBin(bin)
        : current.bin && executable(current.bin)
          ? current.bin
          : findBin(BIN_NAMES[harness]);
      const { model: _, ...kept } = current;
      h.runners[harness] = {
        ...kept,
        ...rest,
        ...(model
          ? { model }
          : model === undefined && current.model
            ? { model: current.model }
            : {}),
        ...(found ? { bin: found } : {}),
      };
      if (rest.enabled && !found && !s.headless.bin(harness))
        throw invalid(`${harness} was not found on the daemon's PATH; pass its absolute path`);
    }
    if (patch.addRoot) {
      if (!isAbsolute(patch.addRoot)) throw invalid("a root must be an absolute path");
      let real: string;
      try {
        real = realpathSync(patch.addRoot);
        if (!statSync(real).isDirectory()) throw new Error("not a directory");
      } catch {
        throw invalid(`${patch.addRoot} is not a directory`);
      }
      if (real === "/") throw invalid("/ is too broad for a root");
      if (!h.roots.includes(real)) h.roots.push(real);
    }
    if (patch.removeRoot) {
      const target = patch.removeRoot;
      const before = h.roots.length;
      h.roots = h.roots.filter((r) => r !== target && r !== target.replace(/\/+$/, ""));
      if (h.roots.length === before) throw invalid(`${target} is not a root`);
    }
    for (const [key, value] of Object.entries(patch.set ?? {})) {
      if ((FROM_KEYS as readonly string[]).includes(key)) {
        const [who, what] = key.split(".") as ["local" | "teammate", "wake" | "spawn"];
        (h.from[who] as Record<string, unknown>)[what] = value;
      } else if ((LIMIT_KEYS as readonly string[]).includes(key)) {
        (h as Record<string, unknown>)[key] = value ?? undefined;
      } else {
        throw invalid(
          `unknown setting "${key}"${didYouMean(key, [...LIMIT_KEYS, ...FROM_KEYS])}; settings: ${[...LIMIT_KEYS, ...FROM_KEYS].join(", ")}`,
        );
      }
    }
    config.headless = HeadlessSchema.parse(h);
    saveConfig(ctx.paths, config);
    ctx.config = config;
    if (config.headless.enabled) s.headless.resume();
    return headlessView();
  });

  /** Waits for an answer to `messageId`; stops early when the run ends without one. */
  const waitRun = async (messageId: string, run: RunRow, ms: number, signal: AbortSignal) => {
    if (run.state === "held" || ENDED.includes(run.state)) return undefined;
    const stop = new AbortController();
    signal.addEventListener("abort", () => stop.abort(), { once: true });
    const poll = setInterval(() => {
      if (ENDED.includes(s.headless.get(run.id).state)) stop.abort();
    }, 250);
    try {
      return await mailbox.waitForReplies(messageId, 1, ms, stop.signal);
    } finally {
      clearInterval(poll);
    }
  };
  const answerOf = (out: Awaited<ReturnType<typeof waitRun>>, req: Req) => {
    const m = out?.replies[0];
    return m ? { reply: replyView(m, viewer(req)) } : {};
  };

  route("POST", "/v1/spawn", async (req) => {
    const body = SpawnSchema.parse(req.body);
    const cwd = body.cwd ?? req.agent?.cwd;
    if (!cwd || !isAbsolute(cwd)) throw invalid("which folder? pass an absolute --cwd");
    const { agent, run, sent } = s.headless.spawn(sender(req), {
      harness: body.harness,
      cwd,
      task: body.task,
      ...(body.name ? { name: body.name } : {}),
      ...(body.model ? { model: body.model } : {}),
    });
    const out = body.waitMs
      ? await waitRun(String(sent.message.id), run, body.waitMs, req.signal)
      : undefined;
    return {
      agent: agentView(agent),
      run: s.headless.view(s.headless.get(run.id)),
      message: sent.message,
      note: s.headless.note(run, agent),
      ...answerOf(out, req),
      waited: !!body.waitMs,
      timedOut: !!out?.timedOut,
    };
  });

  route("POST", "/v1/wake", async (req) => {
    const body = WakeSchema.parse(req.body);
    const target = registry.resolveName(body.agent)?.agent ?? registry.require(body.agent);
    if (req.agent?.id === target.id) throw invalid("an agent cannot wake itself");
    if (body.text?.trim()) {
      const result = mailbox.send(sender(req), { kind: "ask", to: [target.name], text: body.text });
      const notes = engine.onQueued(result.queued);
      const d = result.deliveries[0] as { id: number; state: string } | undefined;
      const run = s.headless.activeFor(target.id);
      const live = isLive(registry.byId(target.id) ?? target);
      const out = !body.waitMs
        ? undefined
        : run
          ? await waitRun(String(result.message.id), run, body.waitMs, req.signal)
          : live
            ? await mailbox.waitForReplies(String(result.message.id), 1, body.waitMs, req.signal)
            : undefined;
      return {
        agent: target.name,
        message: result.message,
        note: (d && notes.get(d.id)) ?? d?.state ?? "sent",
        run: run ? s.headless.view(s.headless.get(run.id)) : null,
        ...answerOf(out, req),
      };
    }
    const agent = registry.refreshLiveness(target);
    if (isLive(agent)) {
      const deliverer = engine.delivererFor(agent);
      engine.maybeWake(agent);
      return {
        agent: agent.name,
        run: null,
        note: deliverer
          ? `${agent.name} is running (${agent.state}); waking it via ${deliverer.id} if it has mail`
          : `${agent.name} is running (${agent.state}); it reads its mail at its next turn`,
      };
    }
    const pending = mailbox.pending(agent.id);
    if (pending.length === 0)
      throw invalid(
        `nothing is waiting for ${agent.name}; give it something to do: agentlink wake ${agent.name} "<message>"`,
      );
    const run = s.headless.request({
      agent,
      requester: s.headless.requesterOf(sender(req)),
      trigger: pending.find((i) => i.message.kind !== "info") ?? (pending[0] as InboxItem),
    });
    return { agent: agent.name, run: s.headless.view(run), note: s.headless.note(run, agent) };
  });

  const RunsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(20),
    agent: z.string().min(1).max(200).optional(),
    state: z.enum(["held", "queued", "running", "done", "failed", "stopped", "denied"]).optional(),
  });
  // Agents see the runs they asked for or ran in; you see all of them.
  const visibleRun = (req: Req, run: RunRow) =>
    !req.agent || run.agent_id === req.agent.id || run.requester_agent_id === req.agent.id;
  const runFor = (req: Req, ref: string): RunRow => {
    const id = parseRunRef(ref) ?? s.headless.activeFor(registry.require(ref).id)?.id;
    if (id === undefined) throw invalid(`${ref} has no headless run in progress`);
    const run = s.headless.get(id);
    if (!visibleRun(req, run)) throw new AgentLinkError("not_found", `run ${ref} not found`, 404);
    return run;
  };

  route("GET", "/v1/runs", (req) => {
    const q = RunsQuery.parse(Object.fromEntries(req.query));
    return {
      runs: s.headless
        .list({
          limit: q.limit,
          ...(q.agent ? { agentId: registry.require(q.agent).id } : {}),
          ...(q.state ? { state: q.state } : {}),
          ...(req.agent ? { viewer: req.agent.id } : {}),
        })
        .map((r) => s.headless.view(r)),
    };
  });

  route("GET", "/v1/runs/:id", (req) => ({
    run: s.headless.view(runFor(req, req.params.id as string)),
  }));

  // Stopping is the safe direction: the requester, the agent itself, or you.
  route("POST", "/v1/runs/:id/stop", (req) => {
    const run = runFor(req, req.params.id as string);
    const who = req.agent ? req.agent.name : `@${ctx.config.handle}`;
    return { run: s.headless.view(s.headless.stop(run.id, `stopped by ${who}`)) };
  });

  // ------------------------------------------------------------------ adapters
  route("POST", "/v1/hooks/:tool/:event", (req) => {
    const tool = req.params.tool as string;
    const event = req.params.event as string;
    if (!s.hooks.isEvent(event)) throw invalid(`unknown hook event "${event}"`);
    const body = HookRequestSchema.parse(req.body);
    // A verified caller's real process tree replaces whatever the hook process claimed.
    return s.hooks.handle(
      tool,
      event,
      req.caller.verified ? { ...body, chain: req.caller.chain, verified: true } : body,
    );
  });

  route("GET", "/v1/adapters/opencode/poll", async (req) => {
    const agent = registry.require(req.query.get("agent") ?? "");
    if (req.caller.verified && agent.pid && !req.caller.chain.some((p) => p.pid === agent.pid)) {
      throw forbidden("only the OpenCode process that owns this agent can poll its messages");
    }
    const timeoutMs = Math.min(Number(req.query.get("timeoutMs") ?? 25_000) || 25_000, 60_000);
    registry.setState(
      agent.id,
      agent.state === "offline" || agent.state === "stale" ? "idle" : agent.state,
    );
    setImmediate(() => engine.maybeWake(registry.byId(agent.id) as AgentRow));
    const push = await s.opencode.poll(agent.id, timeoutMs, req.signal);
    return { push };
  });

  route("POST", "/v1/adapters/opencode/ack", (req) => {
    const body = z.object({ token: z.string(), ok: z.boolean().default(true) }).parse(req.body);
    return { ok: s.opencode.ack(body.token, body.ok) };
  });

  // ------------------------------------------------------------------ dispatch
  let warnedUnverified = false;
  /** Replaces the client's claims with what the kernel says about the connecting process. */
  async function verifyCaller(raw: IncomingMessage, claimed: CallerInfo): Promise<CallerInfo> {
    if (s.trustClientCaller) return claimed;
    const pid = await peerPid(raw.socket);
    if (!pid) {
      // Where the kernel can name callers, one it cannot name (e.g. a process that made itself
      // non-dumpable, or one that exited before the lookup) is refused, never taken at its word.
      if (peerLookupAvailable()) {
        throw forbidden(
          "agentlink cannot tell which process is calling (it is hidden from the kernel's socket table); refusing",
        );
      }
      if (!warnedUnverified) {
        warnedUnverified = true;
        ctx.log.warn(
          "cannot verify callers on this system (needs Linux + ss); trusting client claims",
        );
      }
      return claimed;
    }
    return {
      pid,
      chain: ancestry(pid),
      tty: stdinIsTty(pid),
      verified: true,
      ...(claimed.as ? { as: claimed.as } : {}),
    };
  }

  const dispatch: Dispatch = async (raw, res, url, as) => {
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const match = routes
      .filter((r) => r.method === raw.method)
      .map((r) => ({ r, m: r.re.exec(url.pathname) }))
      .find((x) => x.m);
    const send = (status: number, payload: unknown) => {
      if (res.headersSent) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (!match?.m)
      return send(404, { error: { code: "no_route", message: `${raw.method} ${url.pathname}` } });
    try {
      const caller =
        as?.caller ?? (await verifyCaller(raw, parseCaller(raw.headers["x-agentlink-caller"])));
      const skipCaller =
        !!as ||
        url.pathname === "/v1/health" ||
        url.pathname.startsWith("/v1/hooks/") ||
        url.pathname.startsWith("/v1/adapters/");
      let agent: AgentRow | undefined;
      if (!skipCaller) {
        agent = registry.resolveCaller(caller);
        // Agents with hooks report busy/idle themselves; hook-less ones stay as registered.
        if (
          agent &&
          agent.tool !== "generic" &&
          (agent.state === "offline" ||
            agent.state === "stale" ||
            (agent.state === "idle" && raw.method !== "GET"))
        ) {
          agent = registry.setState(agent.id, "busy") ?? agent;
        }
      }
      const params = Object.fromEntries(
        match.r.keys.map((k, i) => [k, decodeURIComponent(match.m?.[i + 1] ?? "")]),
      );
      const body = as ? as.body : raw.method === "GET" ? {} : await readBody(raw);
      const out = await match.r.handler({
        method: raw.method ?? "GET",
        path: url.pathname,
        params,
        query: url.searchParams,
        body,
        caller,
        ...(agent ? { agent } : {}),
        signal: controller.signal,
        raw,
        res,
      });
      if (out !== STREAM) send(200, out ?? {});
    } catch (error) {
      if (error instanceof AgentLinkError) {
        send(error.status, {
          error: { code: error.code, message: error.message, details: error.details },
        });
      } else if (error instanceof z.ZodError) {
        send(400, {
          error: {
            code: "invalid",
            message: error.issues
              .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
              .join("; "),
          },
        });
      } else {
        ctx.log.error("request failed", {
          path: url.pathname,
          error: String((error as Error).stack ?? error),
        });
        send(500, {
          error: { code: "internal", message: String((error as Error).message ?? error) },
        });
      }
    }
  };
  const server = createServer((raw, res) =>
    dispatch(raw, res, new URL(raw.url ?? "/", "http://agentlink")),
  );
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return Object.assign(server, { dispatch });
}
