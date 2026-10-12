import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRow } from "../../src/daemon/types.ts";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";

let t: TestDaemon;
afterEach(async () => {
  await t?.stop();
});

type Addr = { member: string; agent?: string; role: "agent" | "human" };
const agent = (name: string): Addr => ({ member: "tester", agent: name, role: "agent" });

describe("threads index performance", () => {
  it("stays fast over 200 threads x 30 messages and summarizes correctly", async () => {
    t = await startTestDaemon();
    const ids: Record<string, string> = {};
    for (const name of ["alpha", "beta", "gamma"]) {
      const proc = t.fakeAgentProcess("generic");
      const res = await t.client().request<{ agent: AgentRow }>("POST", "/v1/agents/register", {
        tool: "generic",
        name,
        pid: proc.pid,
        ...(proc.start ? { pidStart: proc.start } : {}),
        cwd: t.home,
      });
      ids[name] = res.agent.id;
    }
    const { store } = t.daemon.services.ctx;
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const pad = (n: number, w: number) => String(n).padStart(w, "0");
    const put = (
      thread: string,
      n: number,
      from: Addr,
      to: Addr[],
      kind: string,
      text: string,
      state: string,
    ) => {
      const id = `MSG${pad(n, 23)}`;
      const at = new Date(base + n * 1000).toISOString();
      const envelope = {
        v: 1,
        messageId: id,
        contextId: thread,
        kind,
        from,
        to,
        parts: [{ kind: "text", text }],
        meta: { hops: 0, expiresAt: "2027-01-01T00:00:00.000Z" },
        createdAt: at,
      };
      const addr = (a: Addr) =>
        a.role === "human"
          ? `@${a.member}`
          : a.member === "tester"
            ? a.agent
            : `${a.member}/${a.agent}`;
      store.run(
        `INSERT INTO messages (id, thread_id, kind, from_addr, from_agent_id, trust, envelope, preview, echo_key, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?)`,
        id,
        thread,
        kind,
        addr(from) as string,
        from.role === "agent" && from.member === "tester"
          ? (ids[from.agent as string] ?? null)
          : null,
        JSON.stringify(envelope),
        text,
        id,
        at,
        "2027-01-01T00:00:00.000Z",
      );
      for (const r of to) {
        const local = r.role === "agent" && r.member === "tester";
        store.run(
          "INSERT INTO deliveries (message_id, to_addr, to_agent_id, state, created_at) VALUES (?, ?, ?, ?, ?)",
          id,
          addr(r) as string,
          local ? (ids[r.agent as string] ?? null) : null,
          local ? state : "sent",
          at,
        );
      }
    };
    store.tx(() => {
      for (let i = 0; i < 200; i++) {
        const thread = `THR${pad(i, 23)}`;
        for (let j = 0; j < 30; j++) {
          const n = i * 30 + j;
          const text = `thread ${i} message ${j} ${"lorem ipsum ".repeat(40)}`;
          if (i === 199 && j === 0)
            put(
              thread,
              n,
              { member: "tester", role: "human" },
              [agent("alpha"), { member: "bob", agent: "x", role: "agent" }],
              "ask",
              "kickoff from the human",
              "seen",
            );
          else if (i === 199 && j === 15)
            put(thread, n, agent("beta"), [agent("gamma")], "info", "not for alpha", "seen");
          else if (i === 199 && j === 29)
            put(thread, n, agent("gamma"), [agent("alpha")], "info", "gamma wraps up", "queued");
          else if (j % 2)
            put(thread, n, agent("beta"), [agent("alpha")], j === 1 ? "ask" : "info", text, "seen");
          else put(thread, n, agent("alpha"), [agent("beta")], "info", text, "seen");
        }
      }
    });

    const { mailbox, registry } = t.daemon.services;
    const viewer = { agent: registry.byName("alpha") as AgentRow };
    // Median of 5 runs after a warm-up, for the agent (session-start hook), your view and open.
    const median = (run: () => unknown) => {
      run();
      const times = Array.from({ length: 5 }, () => {
        const start = performance.now();
        run();
        return performance.now() - start;
      }).sort((a, b) => a - b);
      return times[2] as number;
    };
    expect(median(() => mailbox.threads(viewer, { limit: 8, offset: 0 }))).toBeLessThan(150);
    expect(median(() => mailbox.threads({ human: true }, { limit: 8, offset: 0 }))).toBeLessThan(
      150,
    );
    expect(median(() => mailbox.threads(viewer, { limit: 8, offset: 0, open: true }))).toBeLessThan(
      150,
    );
    const rows = mailbox.threads(viewer, { limit: 8, offset: 0 });
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual({
      thread: `THR${pad(199, 23)}`,
      subject: "kickoff from the human",
      participants: ["@tester", "alpha", "bob/x", "beta", "gamma"],
      messages: 29,
      lastAt: new Date(base + (199 * 30 + 29) * 1000).toISOString(),
      lastFrom: "gamma",
      lastPreview: "gamma wraps up",
      open: true,
      needsAnswer: true,
      waiting: false,
      unread: 1,
    });
    expect(rows[1]).toMatchObject({
      thread: `THR${pad(198, 23)}`,
      participants: ["alpha", "beta"],
      messages: 30,
      lastFrom: "beta",
    });
  }, 30_000);
});
