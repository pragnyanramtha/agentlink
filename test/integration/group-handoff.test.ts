import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";

// Found by scripts/sim (invariant: thread status matches who still owes an answer). Once one
// recipient of a group handoff accepted it, threadStatus still listed the others as awaiting
// and the handoff stayed in their todo, while the same thread row said open:false.
let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon();
  for (const name of ["boss", "ann", "bob"]) {
    const proc = t.fakeAgentProcess("generic");
    await t.client().request("POST", "/v1/agents/register", {
      tool: "generic",
      name,
      pid: proc.pid,
      state: "idle",
    });
  }
});
afterEach(async () => {
  await t.stop();
});

type Row = { thread: string; state: string; open: boolean; needsAnswer: boolean };

describe("a group handoff someone accepted", () => {
  it("no longer waits on the other recipients", async () => {
    const sent = await t.raw<{ message: { id: string; thread: string } }>(
      "POST",
      "/v1/messages",
      { to: ["ann", "bob"], kind: "handoff", text: "take the flaky e2e" },
      { as: "boss" },
    );
    const { id, thread } = sent.data.message;
    await t.raw("GET", `/v1/messages/${id}`, undefined, { as: "bob" }); // bob saw it
    const before = await t.raw<{ awaiting: string[] }>("GET", `/v1/threads/${thread}`, undefined, {
      as: "boss",
    });
    expect(before.data.awaiting).toEqual(["ann", "bob"]);
    const ack = await t.raw("POST", `/v1/messages/${id}/ack`, { ack: "accept" }, { as: "ann" });
    expect(ack.status).toBe(200);

    const forBoss = await t.raw<{ state: string; awaiting: string[] }>(
      "GET",
      `/v1/threads/${thread}`,
      undefined,
      { as: "boss" },
    );
    expect(forBoss.data.awaiting).not.toContain("bob");
    expect(forBoss.data.state).toBe("answered");

    const forBob = await t.raw<{ state: string }>("GET", `/v1/threads/${thread}`, undefined, {
      as: "bob",
    });
    expect(forBob.data.state).not.toBe("waiting_on_you");
    const todo = await t.raw<{ items: unknown[] }>("GET", "/v1/todo", undefined, { as: "bob" });
    expect(todo.data.items).toHaveLength(0);
    // the thread row agrees with the status
    for (const who of ["boss", "bob"]) {
      const rows = await t.raw<{ threads: Row[] }>("GET", "/v1/threads", undefined, { as: who });
      const row = rows.data.threads.find((r) => r.thread === thread);
      expect(row).toMatchObject({ open: false, needsAnswer: false, state: "answered" });
    }
    const counts = await t.raw<{ todo: number }>("GET", "/v1/overview", undefined, { as: "bob" });
    expect(counts.data.todo).toBe(0);
  });

  it("a decline leaves it open for the others", async () => {
    const sent = await t.raw<{ message: { id: string; thread: string } }>(
      "POST",
      "/v1/messages",
      { to: ["ann", "bob"], kind: "handoff", text: "take the release notes" },
      { as: "boss" },
    );
    const { id, thread } = sent.data.message;
    await t.raw("POST", `/v1/messages/${id}/ack`, { ack: "decline" }, { as: "ann" });
    const forBoss = await t.raw<{ awaiting: string[] }>("GET", `/v1/threads/${thread}`, undefined, {
      as: "boss",
    });
    expect(forBoss.data.awaiting).toEqual(["bob"]);
    const todo = await t.raw<{ items: unknown[] }>("GET", "/v1/todo", undefined, { as: "bob" });
    expect(todo.data.items).toHaveLength(1);
  });
});
