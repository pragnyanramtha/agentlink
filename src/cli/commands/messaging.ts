import { LIMITS } from "../../core/limits.ts";
import {
  type CliContext,
  type Command,
  FILTER_OPTIONS,
  filterQuery,
  optionalValue,
  out,
  parse,
  parseDuration,
  readText,
  splitRecipients,
  UsageError,
} from "../args.ts";
import {
  ackWord,
  ago,
  c,
  clock,
  deliveryColor,
  indent,
  reLine,
  short,
  span,
  stateColor,
  stateLabel,
  statusLine,
  table,
  when,
} from "../format.ts";

interface DeliveryView {
  id: number;
  to: string;
  state: string;
  note?: string | null;
  method?: string | null;
  toState?: string;
  messageId?: string;
  deliveredAt?: string | null;
  seenAt?: string | null;
  ackedAt?: string | null;
  repliedAt?: string | null;
  replyId?: string | null;
}
interface MessageView {
  id: string;
  thread: string;
  kind: string;
  from: string;
  preview: string;
  createdAt: string;
  replyTo?: string | null;
  /** What a reply/ack/review_result answers (newer daemons). */
  re?: { id: string; from: string; preview: string } | null;
}
interface ThreadView {
  thread: string;
  messages: { message: MessageView; text: string; deliveries: DeliveryView[]; ack?: string }[];
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
  groupHint?: boolean;
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

/** Prints the result of a send/ask; returns the exit code (1 when nobody could get it). */
function printSend(ctx: CliContext, res: SendResponse, waitMs: number): number {
  const bad = (state: string) => ["failed", "refused", "expired"].includes(state);
  const failedAll =
    (res.failed?.length ?? 0) > 0 ||
    (res.deliveries.length > 0 && res.deliveries.every((d) => bad(d.state)));
  out(ctx, res, () => (ctx.verbose ? verboseSend(res, waitMs) : compactSend(res)));
  // Exit codes: 0 sent/answered, 1 nobody could receive it, 3 no answer in time.
  return failedAll ? 1 : res.waited && res.timedOut ? 3 : 0;
}

/**
 * Just what matters: the answers for an ask, one line per recipient otherwise, and only
 * delivery states worth knowing about (offline, held, refused…). --verbose shows everything.
 */
export function compactSend(res: SendResponse): string {
  const bad = (state: string) => ["failed", "refused", "expired"].includes(state);
  const lines: string[] = [];
  const answers = res.replies ?? (res.reply ? [res.reply] : []);
  for (const r of answers) {
    const text = withAck(r.text, r.ack);
    lines.push(
      answers.length > 1 || text.includes("\n") ? `${c.bold(r.message.from)}: ${text}` : text,
    );
  }
  const answered = new Set(answers.map((r) => r.message.from));
  const sent: DeliveryView[] = [];
  const failed: string[] = [];
  for (const d of res.deliveries) {
    if (answered.has(d.to)) continue;
    if (bad(d.state)) failed.push(`${c.red("✗")} ${d.to}: ${sendNote(d)}`);
    else if (!res.waited) sent.push(d);
    else if (noteworthy(d)) lines.push(c.dim(`${d.to}: ${sendNote(d)}`));
  }
  if (sent.length) {
    // One line: who got it and the id to follow up with (status, thread); notes only if unusual.
    const solo = sent.length === 1 && noteworthy(sent[0] as DeliveryView) ? sent[0] : undefined;
    lines.push(
      `${c.green("✓")} sent to ${sent.map((d) => d.to).join(", ")} ${c.dim(`· ${short(res.message.id)}${solo ? ` · ${sendNote(solo)}` : ""}`)}`,
    );
    if (!solo)
      for (const d of sent.filter(noteworthy)) lines.push(c.dim(`  ${d.to}: ${sendNote(d)}`));
  }
  lines.push(...failed);
  if (res.groupHint)
    lines.push(c.dim("  (only to the sender; --all answers everyone in the group)"));
  if (!answers.length && res.waited) {
    const who = res.deliveries
      .filter((d) => !bad(d.state))
      .map((d) => d.to)
      .join(", ");
    if (res.paused) lines.push(c.yellow("agentlink is paused; nothing was delivered."));
    else if (res.offline && res.relayDown)
      lines.push(c.yellow("relay unreachable; queued, will send when it reconnects."));
    else if (res.offline)
      lines.push(c.yellow(`${who} offline; the answer will come to your inbox.`));
    else if (res.timedOut && who)
      lines.push(
        c.yellow(
          `no answer yet from ${who}; it will come to your inbox (agentlink status ${short(res.message.id)}).`,
        ),
      );
  } else if (answers.length && res.timedOut) {
    const silent = res.deliveries
      .filter((d) => !answered.has(d.to) && !bad(d.state))
      .map((d) => d.to);
    if (silent.length) lines.push(c.yellow(`no answer yet from ${silent.join(", ")}.`));
  }
  return lines.join("\n");
}

/** Deliveries a sender should hear about (anything but a normal hand-over). */
function noteworthy(d: { state: string; note?: string | null }): boolean {
  if (["held", "refused", "failed", "expired"].includes(d.state)) return true;
  return /offline|paused|muted|relay|held|queued here/i.test(d.note ?? "");
}

/** "[accepted] on it"; just "[accepted]" when there is no note. */
function withAck(text: string, ack: string | undefined): string {
  if (!ack) return text;
  return text === ack || ackWord(text) === ackWord(ack)
    ? `[${ackWord(ack)}]`
    : `[${ackWord(ack)}] ${text}`;
}

/** The sender-facing note of a delivery, in this machine's terms. */
function sendNote(d: { to: string; state: string; note?: string | null }): string {
  // The daemon words holds for teammates; a hold here waits for this machine's user.
  if (d.state === "held" && !/[/@]/.test(d.to))
    return "held until a person approves it on this machine (agentlink approvals)";
  return d.note && !/^(sent|queued|delivered|seen)$/.test(d.note) ? d.note : d.state;
}

function verboseSend(res: SendResponse, waitMs: number): string {
  const bad = (state: string) => ["failed", "refused", "expired"].includes(state);
  const lines = res.deliveries.map((d) =>
    bad(d.state)
      ? `${c.red("✗")} ${c.bold(d.to)}: ${d.state}${d.note ? ` (${d.note})` : ""}`
      : `${c.cyan("→")} ${c.bold(d.to)}: ${d.note ?? d.state}`,
  );
  lines.push(
    c.dim(`  message ${res.message.id} (${res.message.kind}, thread ${res.message.thread})`),
  );
  const answers = res.replies ?? (res.reply ? [res.reply] : []);
  for (const r of answers) {
    lines.push(
      "",
      `${c.green("←")} ${r.message.kind} from ${c.bold(r.message.from)} ${c.dim(`(${r.message.id})`)}:`,
    );
    lines.push(withAck(r.text, r.ack));
  }
  if (!answers.length && res.waited && res.timedOut)
    lines.push(c.yellow(`no answer within ${Math.round(waitMs / 1000)}s`));
  return lines.join("\n");
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
  const offered = ["info", "ask", "request", "handoff", "review_request", "reply", "ack"];
  if (!offered.includes(opts.kind)) {
    throw new UsageError(
      `unknown --kind "${opts.kind}" (use: info, request, handoff, review_request, or ask)`,
    );
  }
  const ttlMs = opts.ttl ? parseDuration(opts.ttl, 0, "m") : 0;
  await ctx.client.ensureDaemon();
  // A wait can take minutes: on a terminal, say so (stderr, cleared when done).
  const who = opts.to?.join(", ") ?? "an answer";
  const stop =
    opts.waitMs > 0 && !ctx.json
      ? statusLine(
          (s) => `waiting for ${who}… ${s}s (Ctrl-C to stop; the answer still reaches your inbox)`,
        )
      : () => {};
  let res: SendResponse;
  try {
    res = await ctx.client.request<SendResponse>(
      "POST",
      "/v1/messages",
      {
        ...(opts.to ? { to: opts.to } : {}),
        kind: opts.kind,
        text: opts.text,
        ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
        ...(opts.thread ? { thread: opts.thread } : {}),
        ...(opts.waitMs > 0 ? { waitMs: opts.waitMs } : {}),
        ...(ttlMs ? { ttlMs } : {}),
        ...(opts.force ? { force: true } : {}),
        ...(opts.replyAll ? { replyAll: true } : {}),
      },
      { timeoutMs: opts.waitMs > 0 ? opts.waitMs + 10_000 : 15_000 },
    );
  } finally {
    stop();
  }
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
      'usage: agentlink send <agent>[,<agent>…] "<message>" [--kind ask|request|handoff|review_request]',
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
    () =>
      `${c.green("✓")} ${ackWord(ackValue)} · sent to ${res.deliveries.map((d) => d.to).join(", ")}`,
  );
  return 0;
};

export function printItems(items: InboxItemView[], all = false): string {
  if (items.length === 0) return c.dim(all ? "No messages." : "No new messages.");
  return items
    .map((i) => {
      const m = i.message;
      const id = short(m.id);
      const head = `${c.bold(m.kind)} from ${c.cyan(m.from)} ${c.dim(`· ${ago(m.createdAt)} · ${id}`)}`;
      const re = m.re ? c.dim(`  ${reLine(m.re)}`) : "";
      const body = indent(withAck(i.text, i.ack));
      const atts = i.attachments.map((a) => c.dim(`  [${a}]`));
      const hint = ["ask", "request", "review_request"].includes(m.kind)
        ? c.dim(`  reply: agentlink reply ${id} "<answer>"`)
        : m.kind === "handoff"
          ? c.dim(`  accept: agentlink ack ${id} --accept   decline: agentlink ack ${id} --decline`)
          : "";
      return [head, re, body, ...atts, hint].filter(Boolean).join("\n");
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
      : printItems(res.items, Boolean(values.all)),
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
      m.re
        ? c.dim(`  ${reLine(m.re)} · ${m.re.id}`)
        : m.replyTo
          ? c.dim(`  in reply to ${m.replyTo}`)
          : "",
      "",
      res.text ?? "",
      ...(res.attachments ?? []).map((a) => c.dim(`[${a}]`)),
      "",
      ...(res.deliveries ?? []).map(
        (d) =>
          `${c.dim("to")} ${d.to}: ${deliveryColor(stateLabel(d))}${d.method ? c.dim(` via ${d.method}`) : ""}`,
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
  const res = await ctx.client.request<ThreadView>("GET", `/v1/threads/${encodeURIComponent(id)}`);
  out(ctx, res, () => threadText(res));
  return 0;
};

/** The value of an ack in a thread: given by newer daemons, else read off the handoff's receipt. */
function ackValueOf(entry: ThreadView["messages"][number], all: ThreadView["messages"]) {
  const { message: m, text, ack } = entry;
  if (m.kind !== "ack") return undefined;
  if (ack) return ackWord(ack);
  for (const x of all) {
    for (const d of x.deliveries) {
      if (d.replyId !== m.id && !(x.message.id === m.replyTo && d.to === m.from)) continue;
      // The receipt keeps "accepted: …" even after a later reply changes its state.
      const word = /^(accepted|declined)\b/.exec(d.note ?? "")?.[1];
      if (word) return word;
    }
  }
  if (["accept", "decline", "processed"].includes(text)) return ackWord(text);
  const target = all.find((x) => x.message.id === m.replyTo);
  return target && target.message.kind !== "handoff" ? "processed" : undefined;
}

export function threadText(res: ThreadView): string {
  return [
    c.dim(`thread ${short(res.thread)} · ${res.messages.length} message(s)`),
    ...res.messages.map((entry) => {
      const { message: m, text, deliveries } = entry;
      const to = deliveries.map((d) => `${d.to} (${deliveryColor(stateLabel(d))})`).join(", ");
      const re = m.re ? `\n${c.dim(`  ${reLine(m.re)}`)}` : "";
      const body = withAck(text, ackValueOf(entry, res.messages));
      return `\n${c.bold(m.kind)} ${c.cyan(m.from)} → ${to} ${c.dim(`· ${ago(m.createdAt)} · ${short(m.id)}`)}${re}\n${indent(body)}`;
    }),
  ].join("\n");
}

/** When each receipt came: "delivered immediately, seen 12s after delivery, replied 2m later". */
export function receipts(d: DeliveryView, createdAt: string): string {
  const steps = (
    [
      ["delivered", d.deliveredAt],
      ["seen", d.seenAt],
      [stateLabel({ state: "acked", note: d.note }), d.ackedAt],
      ["replied", d.repliedAt],
    ] as [string, string | null | undefined][]
  )
    .filter((s): s is [string, string] => Boolean(s[1]))
    .sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]));
  let prev: [string, string] = ["sending", createdAt];
  return steps
    .map(([what, at], i) => {
      const ms = Date.parse(at) - Date.parse(prev[1]);
      const after =
        i === 0 ? "after sending" : prev[0] === "delivered" ? "after delivery" : "later";
      prev = [what, at];
      return `${what} ${ms < 1000 ? (i === 0 ? "immediately" : "right away") : `${span(ms)} ${after}`}`;
    })
    .join(", ");
}

/** A delivery note worth showing next to its state (not the state again). */
function extraNote(d: DeliveryView): string {
  const note =
    stateLabel(d) === d.state
      ? (d.note ?? "")
      : (d.note ?? "").replace(/^(accepted|declined)(: )?/, "");
  return note && note !== d.state ? note : "";
}

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
        `${c.bold(res.message.kind)} ${short(res.message.id)} ${c.dim(`from ${res.message.from} · ${ago(res.message.createdAt)}`)}`,
        ...res.deliveries.map((d) => {
          const note = extraNote(d);
          const times = receipts(d, res.message.createdAt);
          return `  ${d.to}: ${deliveryColor(stateLabel(d))}${d.method ? c.dim(` via ${d.method}`) : ""}${note ? c.dim(` · ${note}`) : ""}${times ? c.dim(` · ${times}`) : ""}`;
        }),
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
              `${c.bold(m.kind)} ${c.dim(short(m.id))} "${m.preview}"\n${deliveries
                .map(
                  (d) =>
                    `  → ${d.to}: ${deliveryColor(stateLabel(d))}${d.method ? c.dim(` via ${d.method}`) : ""}`,
                )
                .join("\n")}`,
          )
          .join("\n"),
  );
  return 0;
};

export function logText(
  messages: { message: MessageView; deliveries: DeliveryView[] }[],
  now = Date.now(),
): string {
  if (messages.length === 0) return c.dim("No messages yet.");
  return table(
    messages.map(({ message: m, deliveries }) => [
      c.dim(when(m.createdAt, now)),
      c.dim(short(m.id)),
      c.bold(m.kind),
      c.cyan(m.from),
      deliveries.length
        ? deliveries.map((d) => `${d.to} ${deliveryColor(stateLabel(d))}`).join(", ")
        : c.dim("(no recipient here)"),
      c.dim(`"${m.preview}"${m.re ? ` · ${reLine(m.re)}` : ""}`),
    ]),
    ["WHEN", "ID", "KIND", "FROM", "TO", "MESSAGE"],
  );
}

export const log: Command = async (ctx) => {
  const { values } = parse(ctx.argv, {
    limit: { type: "string", short: "n", default: "30" },
    ...FILTER_OPTIONS,
  });
  if (!/^\d+$/.test(String(values.limit))) throw new UsageError("-n must be a number");
  const q = await filterQuery(values);
  const filtered = q.size > 0;
  q.set("limit", String(values.limit));
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{
    messages: { message: MessageView; deliveries: DeliveryView[] }[];
  }>("GET", `/v1/log?${q}`);
  out(ctx, res, () =>
    filtered && !res.messages.length
      ? c.dim("No messages match those filters.")
      : logText(res.messages),
  );
  return 0;
};

/**
 * One line of `agentlink watch`; `key` is the line without its time, so identical
 * delivery updates can be collapsed. `kinds` remembers message kinds by id.
 */
export function watchLine(
  event: Record<string, unknown>,
  kinds: Map<string, string>,
  now = new Date(),
): { text: string; key: string } | undefined {
  let key: string | undefined;
  if (event.type === "agent") {
    const a = event.agent as Record<string, string>;
    key = `${c.blue("agent  ")} ${c.bold(a.name ?? "?")} ${stateColor(a.state ?? "")}${a.status ? c.dim(` · ${a.status}`) : ""}`;
  } else if (event.type === "message") {
    const m = event.message as MessageView;
    kinds.set(m.id, m.kind);
    if (kinds.size > 500) kinds.delete(kinds.keys().next().value as string);
    key = `${c.magenta("message")} ${c.dim(short(m.id))} ${c.bold(m.kind ?? "")} ${c.cyan(m.from ?? "")} ${c.dim(`"${m.preview}"${m.re ? ` · ${reLine(m.re)}` : ""}`)}`;
  } else if (event.type === "delivery") {
    const d = event.delivery as DeliveryView;
    const kind = kinds.get(d.messageId ?? "");
    key = `${c.cyan("deliver")} ${c.dim(short(d.messageId))} ${kind ? `${c.bold(kind)} ` : ""}→ ${d.to} ${deliveryColor(stateLabel(d))}${d.method ? c.dim(` via ${d.method}`) : ""}`;
  } else if (event.type === "notice") {
    key = `${c.yellow("notice ")} ${String(event.text)}`;
  }
  return key === undefined ? undefined : { text: `${c.dim(clock(now))} ${key}`, key };
}

export const watch: Command = async (ctx) => {
  parse(ctx.argv, {});
  await ctx.client.ensureDaemon();
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  if (!ctx.json) process.stdout.write(c.dim("watching agentlink events (Ctrl-C to stop)…\n"));
  const kinds = new Map<string, string>();
  let last = "";
  let repeats = 1;
  await ctx.client.events((event) => {
    if (ctx.json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    const line = watchLine(event, kinds);
    if (!line) return;
    if (event.type === "delivery" && line.key === last) {
      // The same update again: count it on the previous line (a terminal) or skip it.
      repeats++;
      if (process.stdout.isTTY)
        process.stdout.write(`\u001b[1A\r\u001b[K${line.text}${c.dim(` ×${repeats}`)}\n`);
      return;
    }
    last = event.type === "delivery" ? line.key : "";
    repeats = 1;
    process.stdout.write(`${line.text}\n`);
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
