import { LIMITS } from "../../core/limits.ts";
import {
  type CliContext,
  type Command,
  optionalValue,
  out,
  parse,
  parseDuration,
  readText,
  splitRecipients,
  UsageError,
} from "../args.ts";
import { ago, c, deliveryColor, indent } from "../format.ts";

interface DeliveryView {
  id: number;
  to: string;
  state: string;
  note?: string;
  method?: string | null;
  toState?: string;
}
interface MessageView {
  id: string;
  thread: string;
  kind: string;
  from: string;
  preview: string;
  createdAt: string;
  replyTo?: string | null;
}
interface SendResponse {
  message: MessageView;
  deliveries: DeliveryView[];
  reply?: { message: MessageView; text: string; ack?: string };
  replies?: { message: MessageView; text: string; ack?: string }[];
  failed?: { to: string; state: string; note: string | null }[];
  paused?: boolean;
  offline?: boolean;
  relayDown?: boolean;
  waited: boolean;
  timedOut?: boolean;
  asHuman?: boolean;
}
interface InboxItemView {
  delivery: DeliveryView;
  message: MessageView;
  text: string;
  attachments: string[];
  ack?: string;
}

const KINDS = [
  "info",
  "ask",
  "request",
  "handoff",
  "reply",
  "ack",
  "review_request",
  "review_result",
];

/** Prints the result of a send/ask; returns the exit code (1 when nobody could get it). */
function printSend(ctx: CliContext, res: SendResponse, waitMs: number): number {
  const bad = (state: string) => ["failed", "refused", "expired"].includes(state);
  const failedAll =
    (res.failed?.length ?? 0) > 0 ||
    (res.deliveries.length > 0 && res.deliveries.every((d) => bad(d.state)));
  out(ctx, res, () => {
    const lines = res.deliveries.map((d) =>
      bad(d.state)
        ? `${c.red("✗")} ${c.bold(d.to)}: ${d.state}${d.note ? ` (${d.note})` : ""}`
        : `${c.cyan("→")} ${c.bold(d.to)}: ${d.note ?? d.state}`,
    );
    lines.push(
      c.dim(
        `  message ${res.message.id.slice(0, 12)} (${res.message.kind}, thread ${res.message.thread.slice(0, 12)})`,
      ),
    );
    if (res.reply) {
      const all = res.replies ?? [res.reply];
      for (const r of all) {
        lines.push("");
        lines.push(
          `${c.green("←")} ${r.message.kind} from ${c.bold(r.message.from)} ${c.dim(`(${r.message.id})`)}:`,
        );
        lines.push(r.ack ? `[${r.ack}] ${r.text}` : r.text);
      }
      const answered = new Set(all.map((r) => r.message.from));
      const silent = res.deliveries
        .filter((d) => !answered.has(d.to) && !bad(d.state))
        .map((d) => d.to);
      if (silent.length && res.timedOut)
        lines.push(c.yellow(`No answer yet from ${silent.join(", ")}.`));
    } else if (res.paused && res.waited) {
      lines.push(
        c.yellow(
          res.asHuman
            ? "agentlink is paused, so nothing was delivered yet (agentlink resume)."
            : "agentlink is paused, so nothing was delivered yet; your user can resume it with agentlink resume.",
        ),
      );
    } else if (res.offline && res.relayDown && res.waited) {
      lines.push(
        c.yellow(
          "Not waiting: the relay is unreachable. The message waits here and goes out when agentlink reconnects.",
        ),
      );
    } else if (res.offline && res.waited) {
      lines.push(
        c.yellow(
          res.asHuman
            ? `Not waiting: nobody it went to is online. The answer will land in your inbox (agentlink inbox).`
            : `Not waiting: nobody it went to is online. The answer will be delivered to you when they are back.`,
        ),
      );
    } else if (res.failed?.length) {
      for (const f of res.failed) {
        if (!res.deliveries.some((d) => d.to === f.to && d.state === f.state)) {
          lines.push(`${c.red("✗")} ${c.bold(f.to)}: ${f.state}${f.note ? ` (${f.note})` : ""}`);
        }
      }
      lines.push(c.red("Nobody could receive this message, so there is no answer to wait for."));
    } else if (res.waited && res.timedOut) {
      lines.push(
        c.yellow(
          res.asHuman
            ? `No answer within ${Math.round(waitMs / 1000)}s. Check later: agentlink status ${res.message.id} (answers to you land in: agentlink inbox)`
            : `No answer within ${Math.round(waitMs / 1000)}s. The answer will be delivered to you automatically when it comes (or run: agentlink inbox).`,
        ),
      );
    }
    return lines.join("\n");
  });
  // Exit codes: 0 sent/answered, 1 nobody could receive it, 3 no answer in time.
  return failedAll ? 1 : res.waited && res.timedOut ? 3 : 0;
}

async function sendCommon(
  ctx: CliContext,
  opts: {
    to?: string[];
    kind: string;
    text: string;
    replyTo?: string;
    thread?: string;
    waitMs: number;
    ttl?: string;
    force?: boolean;
    replyAll?: boolean;
  },
): Promise<number> {
  if (!opts.text.trim()) throw new UsageError("message text is empty");
  const offered = ["info", "ask", "request", "handoff", "reply", "ack"];
  if (!offered.includes(opts.kind)) {
    throw new UsageError(`unknown --kind "${opts.kind}" (use: info, request, handoff, or ask)`);
  }
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<SendResponse>(
    "POST",
    "/v1/messages",
    {
      ...(opts.to ? { to: opts.to } : {}),
      kind: opts.kind,
      text: opts.text,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.thread ? { thread: opts.thread } : {}),
      ...(opts.waitMs > 0 ? { waitMs: opts.waitMs } : {}),
      ...(opts.ttl ? { ttlMs: parseDuration(opts.ttl, 0, "m") } : {}),
      ...(opts.force ? { force: true } : {}),
      ...(opts.replyAll ? { replyAll: true } : {}),
    },
    { timeoutMs: opts.waitMs > 0 ? opts.waitMs + 10_000 : 15_000 },
  );
  return printSend(ctx, res, opts.waitMs);
}

export const send: Command = async (ctx) => {
  const { values, positionals } = parse(optionalValue(ctx.argv, "wait", "w"), {
    kind: { type: "string", short: "k", default: "info" },
    thread: { type: "string", short: "t" },
    wait: { type: "string", short: "w" },
    stdin: { type: "boolean" },
    ttl: { type: "string" },
    force: { type: "boolean" },
    timeout: { type: "string" },
  });
  const [to, ...rest] = positionals;
  if (!to)
    throw new UsageError(
      'usage: agentlink send <agent>[,<agent>…] "<message>" [--kind ask|request|handoff]',
    );
  const kind = String(values.kind);
  // --wait [d] and --timeout <d> both wait for an answer (same as ask).
  const waitMs =
    values.timeout !== undefined
      ? parseDuration(values.timeout, LIMITS.cliAskDefaultWaitMs)
      : values.wait !== undefined
        ? parseDuration(values.wait, LIMITS.cliAskDefaultWaitMs)
        : 0;
  return sendCommon(ctx, {
    to: splitRecipients(to),
    kind,
    text: await readText(rest, Boolean(values.stdin)),
    ...(values.thread ? { thread: values.thread } : {}),
    waitMs,
    ...(values.ttl ? { ttl: values.ttl } : {}),
    ...(values.force ? { force: true } : {}),
  });
};

export const ask: Command = async (ctx) => {
  const { values, positionals } = parse(optionalValue(ctx.argv, "wait", "w"), {
    timeout: { type: "string" },
    wait: { type: "string", short: "w" },
    "no-wait": { type: "boolean" },
    thread: { type: "string", short: "t" },
    stdin: { type: "boolean" },
    force: { type: "boolean" },
  });
  const [to, ...rest] = positionals;
  if (!to)
    throw new UsageError('usage: agentlink ask <agent> "<question>" [--timeout 110s] [--no-wait]');
  return sendCommon(ctx, {
    to: splitRecipients(to),
    kind: "ask",
    text: await readText(rest, Boolean(values.stdin)),
    ...(values.thread ? { thread: values.thread } : {}),
    waitMs: values["no-wait"]
      ? 0
      : parseDuration(values.timeout ?? values.wait, LIMITS.cliAskDefaultWaitMs),
    ...(values.force ? { force: true } : {}),
  });
};

export const reply: Command = async (ctx) => {
  const { values, positionals } = parse(optionalValue(ctx.argv, "wait", "w"), {
    wait: { type: "string", short: "w" },
    stdin: { type: "boolean" },
    kind: { type: "string", short: "k", default: "reply" },
    all: { type: "boolean", short: "a" },
  });
  const [id, ...rest] = positionals;
  if (!id) throw new UsageError('usage: agentlink reply <message-id> "<answer>" [--all]');
  return sendCommon(ctx, {
    kind: String(values.kind),
    replyTo: id,
    text: await readText(rest, Boolean(values.stdin)),
    waitMs: values.wait !== undefined ? parseDuration(values.wait, LIMITS.cliAskDefaultWaitMs) : 0,
    ...(values.all ? { replyAll: true } : {}),
  });
};

export const ack: Command = async (ctx) => {
  const { values, positionals } = parse(ctx.argv, {
    accept: { type: "boolean" },
    decline: { type: "boolean" },
  });
  const [id, ...rest] = positionals;
  if (!id) throw new UsageError('usage: agentlink ack <message-id> [--accept|--decline] ["note"]');
  if (values.accept && values.decline)
    throw new UsageError("choose --accept or --decline, not both");
  const ackValue = values.accept ? "accept" : values.decline ? "decline" : "processed";
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{ message: MessageView; deliveries: DeliveryView[] }>(
    "POST",
    `/v1/messages/${encodeURIComponent(id)}/ack`,
    { ack: ackValue, ...(rest.length ? { note: rest.join(" ") } : {}) },
  );
  out(
    ctx,
    res,
    () => `${c.green("✓")} ${ackValue} sent to ${res.deliveries.map((d) => d.to).join(", ")}`,
  );
  return 0;
};

function printItems(items: InboxItemView[]): string {
  if (items.length === 0) return c.dim("No new messages.");
  return items
    .map((i) => {
      const m = i.message;
      const head = `${c.bold(m.kind)} from ${c.cyan(m.from)} ${c.dim(`· ${ago(m.createdAt)} · ${m.id}`)}`;
      const body = indent(
        i.ack ? (i.text === i.ack ? `[${i.ack}]` : `[${i.ack}] ${i.text}`) : i.text,
      );
      const atts = i.attachments.map((a) => c.dim(`  [${a}]`));
      const hint = ["ask", "request", "review_request"].includes(m.kind)
        ? c.dim(`  reply: agentlink reply ${m.id} "<answer>"`)
        : m.kind === "handoff"
          ? c.dim(
              `  accept: agentlink ack ${m.id} --accept   decline: agentlink ack ${m.id} --decline`,
            )
          : "";
      return [head, body, ...atts, hint].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

export const inbox: Command = async (ctx) => {
  const { values } = parse(optionalValue(ctx.argv, "wait", "w"), {
    all: { type: "boolean", short: "a" },
    peek: { type: "boolean" },
    wait: { type: "string", short: "w" },
    limit: { type: "string", short: "n" },
    format: { type: "string" },
  });
  const format = values.format ?? (process.stdout.isTTY || ctx.json ? "text" : "inject");
  if (!["text", "inject"].includes(format)) throw new UsageError("--format must be text or inject");
  await ctx.client.ensureDaemon();
  const q = new URLSearchParams();
  if (values.all) q.set("all", "1");
  if (values.peek) q.set("peek", "1");
  if (values.limit) q.set("limit", values.limit);
  const waitMs = values.wait !== undefined ? parseDuration(values.wait, 60_000) : 0;
  if (waitMs) q.set("waitMs", String(waitMs));
  if (format === "inject" && !ctx.json) {
    q.set("format", "inject");
    const res = await ctx.client.request<{ count: number; text: string }>(
      "GET",
      `/v1/inbox?${q}`,
      undefined,
      {
        timeoutMs: waitMs + 10_000,
      },
    );
    process.stdout.write(
      `${res.count || (res as { paused?: boolean }).paused ? res.text : "No new agentlink messages."}\n`,
    );
    return 0;
  }
  const res = await ctx.client.request<{ items: InboxItemView[]; paused?: boolean }>(
    "GET",
    `/v1/inbox?${q}`,
    undefined,
    { timeoutMs: waitMs + 10_000 },
  );
  out(ctx, res, () =>
    res.paused
      ? c.yellow("agentlink is paused: nothing is delivered until you run agentlink resume.")
      : printItems(res.items),
  );
  return 0;
};

export const show: Command = async (ctx) => {
  const { values, positionals } = parse(ctx.argv, {
    part: { type: "string", short: "p" },
    raw: { type: "boolean" },
  });
  const [id] = positionals;
  if (!id) throw new UsageError("usage: agentlink show <message-id> [--part N] [--raw]");
  await ctx.client.ensureDaemon();
  const q = new URLSearchParams();
  if (values.part) q.set("part", values.part);
  if (values.raw) q.set("raw", "1");
  const res = await ctx.client.request<{
    message: MessageView;
    text?: string;
    part?: {
      kind: string;
      text?: string;
      data?: unknown;
      file?: { name?: string; bytes?: string };
    };
    attachments?: string[];
    deliveries?: DeliveryView[];
  }>("GET", `/v1/messages/${encodeURIComponent(id)}?${q}`);
  out(ctx, res, () => {
    if (res.part) {
      const p = res.part;
      if (p.kind === "text") return p.text ?? "";
      if (p.kind === "data") return JSON.stringify(p.data, null, 2);
      return p.file?.bytes
        ? Buffer.from(p.file.bytes, "base64").toString("utf8")
        : JSON.stringify(p.file);
    }
    if (values.raw && (res as { envelope?: unknown }).envelope) {
      return JSON.stringify((res as { envelope?: unknown }).envelope, null, 2);
    }
    const m = res.message;
    const lines = [
      `${c.bold(m.kind)} from ${c.cyan(m.from)} ${c.dim(`· ${ago(m.createdAt)} · ${m.id} · thread ${m.thread}`)}`,
      m.replyTo ? c.dim(`  in reply to ${m.replyTo}`) : "",
      "",
      res.text ?? "",
      ...(res.attachments ?? []).map((a) => c.dim(`[${a}]`)),
      "",
      ...(res.deliveries ?? []).map(
        (d) =>
          `${c.dim("to")} ${d.to}: ${deliveryColor(d.state)}${d.method ? c.dim(` via ${d.method}`) : ""}`,
      ),
    ];
    return lines.filter((l, i) => l !== "" || i > 1).join("\n");
  });
  return 0;
};

export const thread: Command = async (ctx) => {
  const { values, positionals } = parse(ctx.argv, { allow: { type: "string" } });
  const [id] = positionals;
  if (!id) throw new UsageError("usage: agentlink thread <thread-or-message-id> [--allow N]");
  await ctx.client.ensureDaemon();
  if (values.allow) {
    await ctx.client.request("POST", `/v1/threads/${encodeURIComponent(id)}/allow`, {
      extra: Number(values.allow),
    });
    process.stdout.write(
      `${c.green("✓")} thread ${id} may continue for ${values.allow} more messages\n`,
    );
    return 0;
  }
  const res = await ctx.client.request<{
    thread: string;
    messages: { message: MessageView; text: string; deliveries: DeliveryView[] }[];
  }>("GET", `/v1/threads/${encodeURIComponent(id)}`);
  out(ctx, res, () =>
    [
      c.dim(`thread ${res.thread} · ${res.messages.length} message(s)`),
      ...res.messages.map(
        ({ message: m, text, deliveries }) =>
          `\n${c.bold(m.kind)} ${c.cyan(m.from)} → ${deliveries.map((d) => `${d.to} (${deliveryColor(d.state)})`).join(", ")} ${c.dim(`· ${ago(m.createdAt)} · ${m.id}`)}\n${indent(text)}`,
      ),
    ].join("\n"),
  );
  return 0;
};

export const status: Command = async (ctx) => {
  const { positionals } = parse(ctx.argv, {});
  await ctx.client.ensureDaemon();
  const [id] = positionals;
  if (id) {
    const res = await ctx.client.request<{ message: MessageView; deliveries: DeliveryView[] }>(
      "GET",
      `/v1/messages/${encodeURIComponent(id)}?peek=1`,
    );
    out(ctx, res, () =>
      [
        `${c.bold(res.message.kind)} ${res.message.id} ${c.dim(`from ${res.message.from} · ${ago(res.message.createdAt)}`)}`,
        ...res.deliveries.map(
          (d) =>
            `  ${d.to}: ${deliveryColor(d.state)}${d.method ? c.dim(` via ${d.method}`) : ""}${d.note ? c.dim(` (${d.note})`) : ""}`,
        ),
      ].join("\n"),
    );
    return 0;
  }
  const who = await ctx.client.request<{ agent: { name: string } | null; handle: string }>(
    "GET",
    "/v1/whoami",
  );
  const me = who.agent?.name ?? `@${who.handle}`;
  const log = await ctx.client.request<{
    messages: { message: MessageView; deliveries: DeliveryView[] }[];
  }>("GET", "/v1/log?limit=10&mine=1");
  const mine = log.messages;
  out(ctx, { me, messages: mine }, () =>
    mine.length === 0
      ? c.dim(`No messages sent by ${me} yet.`)
      : mine
          .map(
            ({ message: m, deliveries }) =>
              `${c.bold(m.kind)} ${c.dim(m.id)} "${m.preview}"\n${deliveries
                .map(
                  (d) =>
                    `  → ${d.to}: ${deliveryColor(d.state)}${d.method ? c.dim(` via ${d.method}`) : ""}`,
                )
                .join("\n")}`,
          )
          .join("\n"),
  );
  return 0;
};

export const log: Command = async (ctx) => {
  const { values } = parse(ctx.argv, { limit: { type: "string", short: "n", default: "30" } });
  if (!/^\d+$/.test(String(values.limit))) throw new UsageError("-n must be a number");
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{
    messages: { message: MessageView; deliveries: DeliveryView[] }[];
  }>("GET", `/v1/log?limit=${encodeURIComponent(String(values.limit))}`);
  out(ctx, res, () =>
    res.messages.length === 0
      ? c.dim("No messages yet.")
      : res.messages
          .map(
            ({ message: m, deliveries }) =>
              `${c.dim(ago(m.createdAt).padEnd(8))} ${c.dim(m.id.slice(0, 12))} ${c.bold(m.kind.padEnd(8))} ${c.cyan(m.from)} → ${
                deliveries.length
                  ? deliveries.map((d) => `${d.to} ${deliveryColor(d.state)}`).join(", ")
                  : c.dim("(no recipient here)")
              }  ${c.dim(`"${m.preview}"`)}`,
          )
          .join("\n"),
  );
  return 0;
};

export const watch: Command = async (ctx) => {
  parse(ctx.argv, {});
  await ctx.client.ensureDaemon();
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  if (!ctx.json) process.stdout.write(c.dim("watching agentlink events (Ctrl-C to stop)…\n"));
  await ctx.client.events((event) => {
    if (ctx.json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    const time = c.dim(new Date().toLocaleTimeString());
    if (event.type === "agent") {
      const a = event.agent as Record<string, string>;
      process.stdout.write(
        `${time} agent   ${c.bold(a.name ?? "?")} ${a.state}${a.status ? c.dim(` · ${a.status}`) : ""}\n`,
      );
    } else if (event.type === "message") {
      const m = event.message as Record<string, string>;
      process.stdout.write(
        `${time} message ${c.bold(m.kind ?? "")} ${c.cyan(m.from ?? "")} ${c.dim(`"${m.preview}"`)}\n`,
      );
    } else if (event.type === "delivery") {
      const d = event.delivery as Record<string, string>;
      process.stdout.write(
        `${time} deliver ${d.to} ${deliveryColor(d.state ?? "")}${d.method ? c.dim(` via ${d.method}`) : ""}\n`,
      );
    } else if (event.type === "notice") {
      process.stdout.write(`${time} notice  ${String(event.text)}\n`);
    }
  }, controller.signal);
  return 0;
};

export const todo: Command = async (ctx) => {
  parse(ctx.argv, {});
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{ items: InboxItemView[] }>("GET", "/v1/todo");
  out(ctx, res, () =>
    res.items.length === 0
      ? c.dim("Nothing waiting for an answer from you.")
      : [
          c.bold(`${res.items.length} waiting for your answer:`),
          ...res.items.map(
            (i) =>
              `  ${c.dim(i.message.id.slice(0, 12))} ${c.bold(i.message.kind.padEnd(8))} from ${c.cyan(i.message.from)} ${c.dim(ago(i.message.createdAt))}  "${i.text.replace(/\s+/g, " ").slice(0, 80)}"`,
          ),
          c.dim(
            '  answer: agentlink reply <id> "…"   ·   handoffs: agentlink ack <id> --accept|--decline',
          ),
        ].join("\n"),
  );
  return 0;
};
