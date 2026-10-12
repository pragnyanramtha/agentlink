import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopNotifier } from "../../src/daemon/notify.ts";
import { sleep, startTestDaemon, type TestDaemon, until } from "../helpers.ts";

type Json = Record<string, unknown>;
interface Row {
  id: string;
  thread: string;
  kind: string;
  from: string;
  to: string[];
  createdAt: string;
  snippet: string;
  tokens: number;
}
interface ThreadRow {
  thread: string;
  subject: string;
  participants: string[];
  messages: number;
  lastAt: string;
  lastFrom: string;
  lastPreview: string;
  open: boolean;
  unread: number;
}

let t: TestDaemon;
afterEach(async () => {
  delete process.env.AGENTLINK_NOTIFY_BIN;
  await t?.stop();
});

async function register(name: string) {
  const proc = t.fakeAgentProcess("generic");
  await t.client().request("POST", "/v1/agents/register", {
    tool: "generic",
    name,
    pid: proc.pid,
    ...(proc.start ? { pidStart: proc.start } : {}),
    cwd: t.home,
  });
  return proc;
}

const send = async (as: string | undefined, body: Json) => {
  const res = await t.raw<{ message: { id: string; thread: string } }>(
    "POST",
    "/v1/messages",
    body,
    as ? { as } : {},
  );
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  return res.data.message;
};
const search = async (query: string, as?: string) =>
  t.raw<{ results: Row[]; fts: boolean }>(
    "GET",
    `/v1/search?${query}`,
    undefined,
    as ? { as } : {},
  );

describe("search", () => {
  it("finds messages by body word, with filters and paging", async () => {
    t = await startTestDaemon();
    await register("alpha");
    await register("beta");
    const m1 = await send(undefined, {
      to: ["alpha"],
      text: "please deploy the frobnicator tonight",
    });
    const m2 = await send("alpha", {
      to: ["beta"],
      kind: "ask",
      text: "is the zebra protocol\nready?",
    });
    await send("beta", { kind: "reply", replyTo: m2.id, text: "yes, zebra is ready" });

    const hit = await search("q=frobnicator");
    expect(hit.status).toBe(200);
    expect(hit.data.fts).toBe(true);
    expect(hit.data.results.map((r) => r.id)).toEqual([m1.id]);
    const row = hit.data.results[0] as Row;
    expect(row).toMatchObject({ thread: m1.thread, kind: "info", from: "@tester", to: ["alpha"] });
    expect(row.snippet).toContain("frobnicator");
    expect(row.snippet).not.toMatch(/\n/);
    expect(row.tokens).toBe(Math.ceil("please deploy the frobnicator tonight".length / 4));
    // prefix match, case-insensitive
    expect((await search("q=FROBNIC")).data.results).toHaveLength(1);
    // newest first; snippet stays on one line
    const zebra = (await search("q=zebra")).data.results;
    expect(zebra).toHaveLength(2);
    expect(zebra[0]?.kind).toBe("reply");
    expect(zebra.every((r) => !r.snippet.includes("\n"))).toBe(true);
    // filters
    expect((await search("q=zebra&from=alpha")).data.results.map((r) => r.id)).toEqual([m2.id]);
    expect((await search("q=zebra&from=tester/alpha")).data.results).toHaveLength(1);
    expect((await search("q=zebra&to=alpha")).data.results).toHaveLength(1);
    expect((await search("q=zebra&kind=reply")).data.results).toHaveLength(1);
    expect((await search("q=zebra&kind=ask,reply")).data.results).toHaveLength(2);
    expect((await search(`thread=${m2.thread}`)).data.results).toHaveLength(2);
    expect((await search("q=zebra&since=2999-01-01T00:00:00Z")).data.results).toHaveLength(0);
    expect((await search("q=zebra&until=2000-01-01")).data.results).toHaveLength(0);
    expect((await search("q=zebra&since=1h")).data.results).toHaveLength(2);
    expect((await search("q=zebra&limit=1")).data.results).toHaveLength(1);
    expect((await search("q=zebra&limit=1&offset=1")).data.results[0]?.kind).toBe("ask");
    // addresses are searchable too
    expect((await search("q=beta")).data.results.length).toBeGreaterThanOrEqual(2);
    // bad input is a 400, not a 500
    expect((await search("q=x&limit=1000")).status).toBe(400);
    expect((await search("q=x&kind=nope")).status).toBe(400);
    expect((await search("q=x&since=yesterday-ish")).status).toBe(400);
  });

  it("never turns FTS query syntax into errors", async () => {
    t = await startTestDaemon();
    await register("alpha");
    await send(undefined, {
      to: ["alpha"],
      text: 'a "quoted" (thing) - with * stars OR near NEAR',
    });
    for (const q of [
      '"',
      '""',
      "*",
      "-foo",
      "a OR b",
      "(x",
      "x)",
      "NEAR(a b)",
      "NEAR",
      "AND",
      "NOT",
      "body:x",
      "^x",
      "'",
      "a + b",
      "{x}",
      "%",
      "_",
      "\\",
    ]) {
      const res = await search(`q=${encodeURIComponent(q)}`);
      expect(res.status, `${q}: ${JSON.stringify(res.data)}`).toBe(200);
    }
    expect((await search(`q=${encodeURIComponent('"quoted"')}`)).data.results).toHaveLength(1);
    expect((await search(`q=${encodeURIComponent("NEAR(stars")}`)).data.results).toHaveLength(1);
  });

  it("falls back to LIKE when FTS5 is unavailable", async () => {
    process.env.AGENTLINK_NO_FTS = "1";
    try {
      t = await startTestDaemon();
    } finally {
      delete process.env.AGENTLINK_NO_FTS;
    }
    await register("alpha");
    await send(undefined, { to: ["alpha"], text: "the 100% frobnicator\nsecond line" });
    const res = await search("q=frobnicator");
    expect(res.data.fts).toBe(false);
    expect(res.data.results).toHaveLength(1);
    expect(res.data.results[0]?.snippet).toContain("frobnicator");
    expect((await search("q=%25")).data.results).toHaveLength(1);
    expect((await search("q=_")).data.results).toHaveLength(0);
  });
});

describe("visibility", () => {
  it("an agent cannot see others' messages via search, threads, log filters or reply context", async () => {
    t = await startTestDaemon();
    await register("alpha");
    await register("beta");
    await register("gamma");
    const secret = await send("alpha", {
      to: ["beta"],
      kind: "ask",
      text: "classified zebra plan",
    });
    // beta answers into the same thread, but to gamma, quoting nothing
    const fwd = await send("beta", {
      to: ["gamma"],
      kind: "reply",
      replyTo: secret.id,
      text: "gamma, can you help?",
    });

    // search
    expect((await search("q=classified", "gamma")).data.results).toHaveLength(0);
    expect((await search("q=classified", "beta")).data.results).toHaveLength(1);
    expect((await search("q=classified")).data.results).toHaveLength(1);
    expect(
      (await search(`thread=${secret.thread}`, "gamma")).data.results.map((r) => r.id),
    ).toEqual([fwd.id]);
    expect((await search("from=alpha", "gamma")).data.results).toHaveLength(0);

    // conversation list
    const g = await t.raw<{ threads: ThreadRow[] }>("GET", "/v1/threads", undefined, {
      as: "gamma",
    });
    expect(g.status).toBe(200);
    expect(g.data.threads).toHaveLength(1);
    const gt = g.data.threads[0] as ThreadRow;
    expect(gt.messages).toBe(1);
    expect(gt.subject).not.toContain("classified");
    expect(JSON.stringify(gt)).not.toContain("classified");
    expect(gt.participants.sort()).toEqual(["beta", "gamma"]);
    expect(gt.unread).toBe(1);
    const withAlpha = await t.raw<{ threads: ThreadRow[] }>(
      "GET",
      "/v1/threads?with=alpha",
      undefined,
      { as: "gamma" },
    );
    expect(withAlpha.data.threads).toHaveLength(0);
    const human = await t.raw<{ threads: ThreadRow[] }>("GET", "/v1/threads");
    expect(human.data.threads[0]?.messages).toBe(2);
    expect(human.data.threads[0]?.subject).toContain("classified");
    expect(human.data.threads[0]?.lastFrom).toBe("beta");
    const a = await t.raw<{ threads: ThreadRow[] }>("GET", "/v1/threads", undefined, {
      as: "alpha",
    });
    expect(a.data.threads[0]).toMatchObject({ messages: 1, unread: 0 });

    // log filters
    const log = await t.raw<{ messages: { message: Json }[] }>(
      "GET",
      `/v1/log?thread=${secret.thread}`,
      undefined,
      { as: "gamma" },
    );
    expect(log.data.messages.map((m) => m.message.id)).toEqual([fwd.id]);
    const logFrom = await t.raw<{ messages: unknown[] }>("GET", "/v1/log?from=alpha", undefined, {
      as: "gamma",
    });
    expect(logFrom.data.messages).toHaveLength(0);
    const humanLog = await t.raw<{ messages: { message: Json }[] }>(
      "GET",
      "/v1/log?from=alpha&kind=ask",
    );
    expect(humanLog.data.messages.map((m) => m.message.id)).toEqual([secret.id]);

    // reply context: gamma never sees the parent; beta does
    const inbox = await t.raw<{ items: { message: Json }[] }>(
      "GET",
      "/v1/inbox?peek=1",
      undefined,
      {
        as: "gamma",
      },
    );
    expect(inbox.data.items[0]?.message.id).toBe(fwd.id);
    expect(inbox.data.items[0]?.message.re).toBeUndefined();
    const shown = await t.raw<{ message: Json }>("GET", `/v1/messages/${fwd.id}`, undefined, {
      as: "gamma",
    });
    expect(shown.data.message.re).toBeUndefined();
    const thread = await t.raw<{ messages: { message: Json }[] }>(
      "GET",
      `/v1/threads/${fwd.id}`,
      undefined,
      { as: "gamma" },
    );
    expect(JSON.stringify(thread.data)).not.toContain("classified");
    const inject = await t.raw<{ text: string }>(
      "GET",
      "/v1/inbox?peek=1&all=1&format=inject",
      undefined,
      { as: "gamma" },
    );
    expect(inject.data.text).toContain("gamma, can you help?");
    expect(inject.data.text).not.toContain("classified");
    const beta = await t.raw<{ message: Json }>("GET", `/v1/messages/${fwd.id}`, undefined, {
      as: "beta",
    });
    expect(beta.data.message.re).toEqual({
      id: secret.id,
      from: "alpha",
      preview: "classified zebra plan",
    });
    const humanShow = await t.raw<{ message: Json }>("GET", `/v1/messages/${fwd.id}`);
    expect((humanShow.data.message.re as Json).id).toBe(secret.id);

    // open: an ask still awaiting an answer, from the asker's and the recipient's side
    const ask = await send("alpha", { to: ["beta"], kind: "ask", text: "second question" });
    const openFor = async (as?: string) =>
      (
        await t.raw<{ threads: ThreadRow[] }>(
          "GET",
          "/v1/threads?open=1",
          undefined,
          as ? { as } : {},
        )
      ).data.threads.map((x) => x.thread);
    expect(await openFor("beta")).toEqual([ask.thread]);
    expect(await openFor("alpha")).toEqual([ask.thread]);
    expect(await openFor("gamma")).toEqual([]);
    expect(await openFor()).toEqual([]);
    await send("beta", { kind: "reply", replyTo: ask.id, text: "answer" });
    expect(await openFor("beta")).toEqual([]);
    expect(await openFor("alpha")).toEqual([]);
  });
});

describe("held mail", () => {
  it("stays invisible to the recipient agent until a person approves it", async () => {
    t = await startTestDaemon();
    await register("alpha");
    await register("beta");
    await t.raw(
      "POST",
      "/v1/policy",
      { scope: "local", kind: "request", action: "hold" },
      { tty: true },
    );
    const held = await send("alpha", { to: ["beta"], kind: "request", text: "heldword task" });
    const beta = { as: "beta" };
    expect((await search("q=heldword", "beta")).data.results).toHaveLength(0);
    expect((await search("q=heldword", "alpha")).data.results).toHaveLength(1);
    expect((await t.raw("GET", `/v1/messages/${held.id}`, undefined, beta)).status).toBe(404);
    const log = await t.raw<{ messages: unknown[] }>("GET", "/v1/log", undefined, beta);
    expect(log.data.messages).toHaveLength(0);
    const all = await t.raw<{ items: unknown[] }>("GET", "/v1/inbox?all=1", undefined, beta);
    expect(all.data.items).toHaveLength(0);
    const threads = await t.raw<{ threads: unknown[] }>("GET", "/v1/threads", undefined, beta);
    expect(threads.data.threads).toHaveLength(0);
    await t.raw("POST", `/v1/approvals/${held.id}`, { decision: "approve" }, { tty: true });
    expect((await search("q=heldword", "beta")).data.results).toHaveLength(1);
  });
});

describe("upgrade", () => {
  it("builds the search index from existing messages", async () => {
    t = await startTestDaemon();
    await register("alpha");
    await send(undefined, {
      to: ["alpha"],
      parts: [
        { kind: "text", text: "backfilled words" },
        { kind: "file", file: { name: "report-final.pdf", bytes: "aGk=" } },
      ],
    });
    const home = t.home;
    await t.stop(true);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(home, "agentlink.db"));
    db.exec("DROP TABLE messages_fts");
    db.close();
    t = await startTestDaemon({ home });
    expect((await search("q=backfilled")).data.results).toHaveLength(1);
    expect((await search("q=report")).data.results).toHaveLength(1);
    expect((await search("q=alpha")).data.results).toHaveLength(1);
  });
});

describe("overview", () => {
  it("counts agents, unread, todo and held for the caller", async () => {
    t = await startTestDaemon();
    await register("alpha");
    await register("beta");
    await send("alpha", { to: ["@tester"], kind: "ask", text: "question for you" });
    await send("alpha", { to: ["beta"], text: "fyi" });
    await t.raw(
      "POST",
      "/v1/policy",
      { scope: "local", kind: "request", action: "hold" },
      { tty: true },
    );
    await send("alpha", { to: ["beta"], kind: "request", text: "do a thing" });

    const human = await t.raw<Json>("GET", "/v1/overview");
    expect(human.status).toBe(200);
    expect(human.data).toMatchObject({
      handle: "tester",
      paused: false,
      team: null,
      agents: { local: { busy: 2, idle: 0, offline: 0 }, remote: { busy: 0, idle: 0, offline: 0 } },
      unread: 1,
      todo: 1,
      held: 1,
      outbox: 0,
    });
    expect(typeof human.data.version).toBe("string");
    expect((human.data.db as Json).messages).toBe(3);
    expect((human.data.db as Json).bytes).toBeGreaterThan(0);

    const beta = await t.raw<Json>("GET", "/v1/overview", undefined, { as: "beta" });
    expect(beta.data).toMatchObject({ unread: 1, todo: 0 });
    expect("held" in beta.data).toBe(false);
  });
});

describe("prune", () => {
  it("is human-only, deletes only finished messages and keeps search consistent", async () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    t = await startTestDaemon({ now: () => new Date(clock) });
    await register("alpha");
    await register("beta");
    const done = await send(undefined, { to: ["alpha"], text: "oldword finished" });
    await t.raw("GET", "/v1/inbox", undefined, { as: "alpha" }); // seen
    const openAsk = await send(undefined, { to: ["alpha"], kind: "ask", text: "oldword open ask" });
    await t.raw("GET", "/v1/inbox", undefined, { as: "alpha" }); // seen, not answered
    const queued = await send("alpha", { to: ["beta"], text: "oldword queued" });
    const answered = await send(undefined, {
      to: ["alpha"],
      kind: "ask",
      text: "oldword answered",
    });
    const answer = await send("alpha", {
      kind: "reply",
      replyTo: answered.id,
      text: "oldword reply",
    });
    await t.raw("GET", "/v1/inbox"); // the human reads the reply
    const unread = await send("alpha", { to: ["@tester"], text: "oldword unread for human" });
    clock += 2 * 24 * 3600_000;
    const recent = await send(undefined, { to: ["alpha"], text: "oldword recent" });

    expect(
      (await t.raw("POST", "/v1/prune", { olderThanMs: 86_400_000 }, { as: "alpha", tty: true }))
        .status,
    ).toBe(403);
    expect((await t.raw("POST", "/v1/prune", { olderThanMs: 86_400_000 })).status).toBe(403);
    expect((await t.raw("POST", "/v1/prune", { olderThanMs: 60_000 }, { tty: true })).status).toBe(
      400,
    );

    const dry = await t.raw<Json>(
      "POST",
      "/v1/prune",
      { olderThanMs: 86_400_000, dryRun: true },
      { tty: true },
    );
    expect(dry.status).toBe(200);
    expect(dry.data).toMatchObject({
      dryRun: true,
      messages: 3,
      deliveries: 3,
      threads: 2,
      kept: 3,
    });
    expect((await search("q=oldword")).data.results).toHaveLength(7);

    const res = await t.raw<Json>("POST", "/v1/prune", { olderThanMs: 86_400_000 }, { tty: true });
    expect(res.data).toMatchObject({
      dryRun: false,
      messages: 3,
      deliveries: 3,
      threads: 2,
      kept: 3,
    });
    const left = (await search("q=oldword")).data.results.map((r) => r.id).sort();
    expect(left).toEqual([openAsk.id, queued.id, unread.id, recent.id].sort());
    expect(left).not.toContain(done.id);
    expect(left).not.toContain(answer.id);
    expect((await t.raw("GET", `/v1/messages/${done.id}`)).status).toBe(404);
    const log = await t.raw<{ messages: unknown[] }>("GET", "/v1/log");
    expect(log.data.messages).toHaveLength(4);
    expect((await t.raw<Json>("GET", "/v1/overview")).data.db).toMatchObject({ messages: 4 });
  });

  it("applies config retention in the daemon's sweep", async () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    t = await startTestDaemon({ now: () => new Date(clock) });
    await register("alpha");
    await send(undefined, { to: ["alpha"], text: "retained word" });
    await t.raw("GET", "/v1/inbox", undefined, { as: "alpha" });
    clock += 3 * 24 * 3600_000;
    await sleep(400);
    expect((await search("q=retained")).data.results).toHaveLength(1); // no retention: kept
    writeFileSync(
      join(t.home, "config.json"),
      JSON.stringify({ handle: "tester", wake: { tmux: false }, retention: { days: 1 } }),
    );
    expect((await t.raw("POST", "/v1/config/reload")).status).toBe(200);
    const gone = await until(async () => (await search("q=retained")).data.results.length === 0);
    expect(gone).toBe(true);
  });
});

describe("desktop notifications", () => {
  const fakeNotifier = (dir: string, name = "notify") => {
    const out = join(dir, `${name}.out`);
    const bin = join(dir, `${name}.sh`);
    writeFileSync(
      bin,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${out}'; done\necho --- >> '${out}'\n`,
    );
    chmodSync(bin, 0o755);
    return {
      bin,
      out,
      // Only finished calls: the script appends one argument per line, then "---".
      calls: () => (existsSync(out) ? readFileSync(out, "utf8").split("---\n").slice(0, -1) : []),
    };
  };
  const enable = async (desktop: boolean) => {
    writeFileSync(
      join(t.home, "config.json"),
      JSON.stringify({ handle: "tester", wake: { tmux: false }, notify: { desktop } }),
    );
    expect((await t.raw("POST", "/v1/config/reload")).status).toBe(200);
  };

  it("notifies the human only when enabled, with sanitized single-line text", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "agentlink-notify-"));
    const fake = fakeNotifier(dir);
    process.env.AGENTLINK_NOTIFY_BIN = fake.bin;
    t = await startTestDaemon();
    await register("alpha");
    await register("beta");
    await send("alpha", { to: ["@tester"], text: "while disabled" });
    await sleep(300);
    expect(fake.calls()).toHaveLength(0);

    await enable(true);
    await send("alpha", {
      to: ["@tester"],
      kind: "handoff",
      text: "-u critical \u001b[31mred\u001b[0m\nline two \u202e",
    });
    const calls = await until(() => fake.calls().length >= 1 && fake.calls());
    const args = (calls as string[])[0]?.trimEnd().split("\n") ?? [];
    expect(args[0]).toBe("--");
    expect(args[1]).toBe("agentlink");
    expect(args).toHaveLength(3);
    expect(args[2]).toContain("handoff from alpha");
    expect(args[2]).toContain("line two");
    expect(args[2]).not.toContain("\u001b");
    expect(args[2]).not.toContain("\u202e");

    // agent → agent traffic does not notify; a held delivery does (another kind, not rate-limited)
    await send("alpha", { to: ["beta"], text: "between agents" });
    await t.raw(
      "POST",
      "/v1/policy",
      { scope: "local", kind: "request", action: "hold" },
      { tty: true },
    );
    await send("alpha", { to: ["beta"], kind: "request", text: "needs approval" });
    const two = await until(() => fake.calls().length >= 2 && fake.calls());
    expect((two as string[])[1]).toContain("approval");
    expect((two as string[]).join("")).not.toContain("between agents");

    // the test route is human-only and reports the notifier it found
    expect((await t.raw("POST", "/v1/notify/test", {}, { as: "alpha" })).status).toBe(403);
    const test = await t.raw<Json>("POST", "/v1/notify/test", {});
    expect(test.data).toMatchObject({ found: true, sent: true, notifier: fake.bin, enabled: true });
    await until(() => fake.calls().length >= 3);

    await enable(false);
    const before = fake.calls().length;
    await send("alpha", { to: ["@tester"], text: "disabled again" });
    await sleep(300);
    expect(fake.calls()).toHaveLength(before);
  });

  it("rate-limits per kind and coalesces, and reports a missing binary", async () => {
    t = await startTestDaemon();
    await register("alpha");
    const fake = fakeNotifier(t.home, "coalesce");
    const { ctx, mailbox } = t.daemon.services;
    ctx.config = { ...ctx.config, notify: { desktop: true } };
    // the daemon's own notifier would also fire; point it at a binary that does not exist
    process.env.AGENTLINK_NOTIFY_BIN = join(t.home, "missing-notifier");
    const notifier = new DesktopNotifier(ctx, mailbox, { bin: fake.bin, windowMs: 200 });
    const stop = notifier.start();
    try {
      await send("alpha", { to: ["@tester"], text: "first" });
      await send("alpha", { to: ["@tester"], text: "second" });
      await send("alpha", { to: ["@tester"], text: "third" });
      await until(() => fake.calls().length >= 1);
      await sleep(50);
      expect(fake.calls()).toHaveLength(1);
      const all = await until(() => fake.calls().length >= 2 && fake.calls(), 2_000);
      expect((all as string[])[1]).toContain("2 new messages");
      await sleep(300);
      expect(fake.calls()).toHaveLength(2);
    } finally {
      stop();
    }
    const missing = await t.raw<Json>("POST", "/v1/notify/test", {});
    expect(missing.status).toBe(200);
    expect(missing.data).toMatchObject({ found: false, sent: false });
  });
});
