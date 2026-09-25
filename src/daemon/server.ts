import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { AckSchema, KINDS, KindSchema, PartSchema, textOf } from "../core/envelope.ts";
import { AgentLinkError, forbidden, invalid } from "../core/errors.ts";
import { DEFAULT_POLICY, POLICY_ACTIONS, TRUSTS } from "../core/policy.ts";
import { PROTOCOL_VERSION, VERSION } from "../version.ts";
import type { Claims } from "./claims.ts";
import type { DaemonContext } from "./context.ts";
import type { OpenCodeBridge } from "./deliverers.ts";
import type { DeliveryEngine } from "./delivery.ts";
import { type HookHandler, HookRequestSchema } from "./hooks.ts";
import type { Mailbox } from "./mailbox.ts";
import { agentView, type Registry } from "./registry.ts";
import type { TeamManager } from "./team-manager.ts";
import type { AgentRow, CallerInfo, InboxItem, MessageRow, Sender } from "./types.ts";

export interface Services {
  ctx: DaemonContext;
  registry: Registry;
  mailbox: Mailbox;
  engine: DeliveryEngine;
  hooks: HookHandler;
  claims: Claims;
  opencode: OpenCodeBridge;
  team: TeamManager;
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
      "only your human user can do this, not an AI agent (run it in your own terminal)",
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
});

export function createDaemonServer(s: Services, shutdown: () => void): Server {
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

  const itemView = (item: InboxItem) => ({
    delivery: mailbox.deliveryView(item.delivery),
    message: mailbox.messageView(item.message),
    text: textOf(item.envelope),
    attachments: mailbox.renderItem(item).attachments,
    ...(item.envelope.meta.ack ? { ack: item.envelope.meta.ack } : {}),
  });

  const replyView = (m: MessageRow) => {
    const env = mailbox.envelopeOf(m);
    return {
      message: mailbox.messageView(m),
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

  route("GET", "/v1/whoami", (req) => ({
    agent: req.agent ? agentView(req.agent) : null,
    handle: ctx.config.handle,
    paused: mailbox.paused,
  }));

  route("POST", "/v1/shutdown", (req) => {
    requireHuman(req, false);
    setTimeout(shutdown, 50);
    return { ok: true };
  });

  // ------------------------------------------------------------------ agents
  route("POST", "/v1/agents/register", (req) => {
    const input = RegisterSchema.parse(req.body);
    const { agent, created, resumed } = registry.register({
      tool: input.tool,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.pid ? { pid: input.pid } : {}),
      ...(input.pidStart ? { pidStart: input.pidStart } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      ...(input.adapter ? { adapter: input.adapter } : {}),
      state: input.state ?? "busy",
    });
    return { agent: agentView(agent), created, resumed };
  });

  route("GET", "/v1/agents", (req) => {
    const all = req.query.get("all") === "1";
    const local = registry.list({ includeOffline: all }).map((a) => ({
      ...agentView(a),
      wakeVia: engine.delivererFor(a)?.id ?? null,
    }));
    const remote = (s.team.client?.remoteAgents() ?? [])
      .filter((a) => all || a.state === "busy" || a.state === "idle")
      .map((a) => ({
        id: `${a.deviceId}:${a.name}`,
        name: `${a.member}/${a.name}`,
        member: a.member,
        tool: a.tool,
        state: a.state,
        stateAt: a.stateAt ?? a.at,
        lastSeenAt: a.at,
        repo: a.repo ?? null,
        branch: a.branch ?? null,
        status: a.status ?? null,
        muted: false,
        capabilities: {},
        local: false,
      }));
    return { agents: [...local, ...remote] };
  });

  // ------------------------------------------------------------------ team (relay)
  route("GET", "/v1/team", () => s.team.status());

  route("POST", "/v1/team/create", async (req) => {
    requireHuman(req, false);
    const body = z
      .object({ name: z.string().min(1), relay: z.string().min(1), handle: z.string().optional() })
      .parse(req.body);
    return s.team.create(body.name, body.relay, body.handle);
  });

  route("POST", "/v1/team/invite", async (req) => {
    requireHuman(req, false);
    const body = z
      .object({
        uses: z.number().int().min(1).max(100).default(1),
        ttlMs: z
          .number()
          .int()
          .positive()
          .default(24 * 3600_000),
      })
      .parse(req.body);
    return { invite: await s.team.invite(body.uses, body.ttlMs) };
  });

  route("POST", "/v1/team/join", async (req) => {
    requireHuman(req, false);
    const body = z
      .object({ invite: z.string().min(10), handle: z.string().optional() })
      .parse(req.body);
    return s.team.join(body.invite, body.handle);
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
            ? `held for approval (${ctx.config.handle} runs: agentlink approvals)`
            : d.state === "refused"
              ? "refused by policy"
              : d.state === "delivered" && String(d.to).startsWith("@")
                ? `stored for ${d.to} (they read it with: agentlink inbox)`
                : String(d.state)),
    }));
    let reply: ReturnType<typeof replyView> | undefined;
    const reachable = result.deliveries.some((d) =>
      ["queued", "sent", "delivered", "seen"].includes(String(d.state)),
    );
    if (input.waitMs && reachable) {
      const m = await mailbox.waitForReply(String(result.message.id), input.waitMs, req.signal);
      if (m) reply = replyView(m);
    }
    return {
      message: result.message,
      deliveries,
      ...(reply ? { reply } : {}),
      waited: !!input.waitMs,
    };
  });

  route("GET", "/v1/inbox", async (req) => {
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
    return { items: items.map(itemView) };
  });

  route("GET", "/v1/messages/:id", (req) => {
    const message = mailbox.resolveMessage(req.params.id as string);
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
      return { message: mailbox.messageView(message), part: p };
    }
    return {
      message: mailbox.messageView(message),
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

  route("GET", "/v1/threads/:id", (req) => ({
    thread: mailbox.resolveThread(req.params.id as string),
    messages: mailbox.thread(req.params.id as string).map(({ message, deliveries }) => ({
      message: mailbox.messageView(message),
      text: textOf(mailbox.envelopeOf(message)),
      deliveries: deliveries.map((d) => mailbox.deliveryView(d)),
    })),
  }));

  route("POST", "/v1/threads/:id/allow", (req) => {
    requireHuman(req);
    const body = z.object({ extra: z.number().int().min(1).max(100) }).parse(req.body);
    mailbox.allowThread(req.params.id as string, body.extra);
    return { ok: true };
  });

  route("GET", "/v1/log", (req) => {
    const limit = Math.min(Number(req.query.get("limit") ?? 30) || 30, 500);
    return {
      messages: mailbox.recent(limit).map((m) => ({
        message: mailbox.messageView(m),
        deliveries: mailbox.deliveriesOf(m.id).map((d) => mailbox.deliveryView(d)),
      })),
    };
  });

  route("GET", "/v1/events", (req) => {
    req.res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    req.res.write(": connected\n\n");
    const unsubscribe = ctx.events.subscribe((event) => {
      req.res.write(`data: ${JSON.stringify(event)}\n\n`);
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
    return {
      claims,
      conflicts: conflicts.map((c) => ({
        ...c,
        agent: registry.byId(c.agent_id)?.name ?? c.agent_id,
      })),
    };
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
    claims: s.claims
      .active()
      .map((c) => ({ ...c, agent: registry.byId(c.agent_id)?.name ?? c.agent_id })),
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
    if (!(TRUSTS as readonly string[]).includes(body.scope) && !/^[a-z0-9._-]+$/.test(body.scope)) {
      throw invalid(`unknown policy scope "${body.scope}"`);
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

  route("GET", "/v1/approvals", () => ({ items: mailbox.held().map(itemView) }));

  route("POST", "/v1/approvals/:id", (req) => {
    requireHuman(req);
    const body = z.object({ decision: z.enum(["approve", "deny"]) }).parse(req.body);
    const item = mailbox.decide(Number(req.params.id), body.decision, ctx.config.handle);
    if (body.decision === "approve") engine.onQueued([item]);
    return { item: itemView(item) };
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

  // ------------------------------------------------------------------ adapters
  route("POST", "/v1/hooks/:tool/:event", (req) => {
    const tool = req.params.tool as string;
    const event = req.params.event as string;
    if (!s.hooks.isEvent(event)) throw invalid(`unknown hook event "${event}"`);
    return s.hooks.handle(tool, event, HookRequestSchema.parse(req.body));
  });

  route("GET", "/v1/adapters/opencode/poll", async (req) => {
    const agent = registry.require(req.query.get("agent") ?? "");
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
  const server = createServer(async (raw, res) => {
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const url = new URL(raw.url ?? "/", "http://agentlink");
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
      const caller = parseCaller(raw.headers["x-agentlink-caller"]);
      const skipCaller =
        url.pathname === "/v1/health" ||
        url.pathname.startsWith("/v1/hooks/") ||
        url.pathname.startsWith("/v1/adapters/");
      let agent: AgentRow | undefined;
      if (!skipCaller) {
        agent = registry.resolveCaller(caller);
        if (
          agent &&
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
      const body = raw.method === "GET" ? {} : await readBody(raw);
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
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
