import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";

// An agent may only join conversations it takes part in: replying to, acking or continuing the
// thread of a message it cannot see must fail exactly like an unknown id.
let t: TestDaemon;
let privateAsk: { id: string; thread: string };
let heldInfo: { id: string; thread: string };
type Res = {
  status: number;
  data: { error?: { code: string; message: string } } & Record<string, unknown>;
};

beforeAll(async () => {
  t = await startTestDaemon();
  for (const name of ["alpha", "beta", "gamma"]) {
    const proc = t.fakeAgentProcess("generic");
    await t.client().request("POST", "/v1/agents/register", {
      tool: "generic",
      name,
      pid: proc.pid,
      state: "idle",
    });
  }
  const sent = await t.raw<{ message: { id: string; thread: string } }>(
    "POST",
    "/v1/messages",
    { to: ["beta"], kind: "ask", text: "private: what is the db password rotation plan?" },
    { as: "alpha" },
  );
  expect(sent.status).toBe(200);
  privateAsk = sent.data.message;
  // A delivery gamma never received (held for approval) does not make it a participant.
  const policy = await t.raw(
    "POST",
    "/v1/policy",
    { scope: "local", kind: "handoff", action: "hold" },
    { tty: true },
  );
  expect(policy.status).toBe(200);
  const held = await t.raw<{ message: { id: string; thread: string } }>(
    "POST",
    "/v1/messages",
    { to: ["gamma"], kind: "handoff", text: "take over the migration" },
    { as: "alpha" },
  );
  expect(held.status).toBe(200);
  heldInfo = held.data.message;
}, 30_000);

afterAll(async () => {
  await t?.stop();
});

const post = (as: string | undefined, path: string, body: unknown) =>
  t.raw("POST", path, body, as ? { as } : {}) as Promise<Res>;
const unknown = () =>
  post("gamma", "/v1/messages", {
    kind: "reply",
    replyTo: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
    text: "x",
  });
const unknownThread = () =>
  post("gamma", "/v1/messages", { to: ["beta"], thread: "01JZZZZZZZZZZZZZZZZZZZZZZZ", text: "x" });

describe("joining someone else's conversation", () => {
  it("an outsider cannot reply to it (same error as an unknown id)", async () => {
    const ref = await unknown();
    expect(ref.status).toBe(404);
    for (const replyTo of [privateAsk.id, privateAsk.id.slice(0, 10)]) {
      const res = await post("gamma", "/v1/messages", { kind: "reply", replyTo, text: "me too" });
      expect(res.status).toBe(404);
      expect(res.data.error?.code).toBe(ref.data.error?.code);
      expect(res.data.error?.message.replace(replyTo, "X")).toBe(
        ref.data.error?.message.replace("01JZZZZZZZZZZZZZZZZZZZZZZZ", "X"),
      );
    }
    const all = await post("gamma", "/v1/messages", {
      kind: "reply",
      replyTo: privateAsk.id,
      replyAll: true,
      text: "hi all",
    });
    expect(all.status).toBe(404);
  });

  it("an outsider cannot attach a new message to it with replyTo or thread", async () => {
    for (const body of [
      { to: ["beta"], kind: "info", replyTo: privateAsk.id, text: "fyi" },
      { to: ["beta"], kind: "ask", thread: privateAsk.thread, text: "question?" },
      { to: ["beta"], kind: "ask", thread: privateAsk.id, text: "question 2?" },
    ]) {
      const res = await post("gamma", "/v1/messages", body);
      expect(res.status, JSON.stringify(body)).toBe(404);
    }
    expect((await unknownThread()).status).toBe(404);
  });

  it("an outsider cannot ack it", async () => {
    const res = await post("gamma", `/v1/messages/${privateAsk.id}/ack`, { ack: "processed" });
    expect(res.status).toBe(404);
    expect(res.data.error?.code).toBe((await unknown()).data.error?.code);
  });

  it("a held delivery does not let its recipient answer or continue the thread", async () => {
    expect((await post("gamma", `/v1/messages/${heldInfo.id}/ack`, { ack: "accept" })).status).toBe(
      404,
    );
    expect(
      (await post("gamma", "/v1/messages", { kind: "reply", replyTo: heldInfo.id, text: "ok" }))
        .status,
    ).toBe(404);
    expect(
      (await post("gamma", "/v1/messages", { to: ["alpha"], thread: heldInfo.thread, text: "?" }))
        .status,
    ).toBe(404);
  });

  it("an outsider cannot tell it exists by reading it (same error as an unknown id)", async () => {
    const get = (path: string) => t.raw("GET", path, undefined, { as: "gamma" }) as Promise<Res>;
    const fake = "01JZZZZZZZZZZZZZZZZZZZZZZZ";
    for (const [real, path] of [
      [privateAsk.id, (id: string) => `/v1/messages/${id}`],
      [privateAsk.thread, (id: string) => `/v1/threads/${id}`],
      [heldInfo.id, (id: string) => `/v1/messages/${id}?peek=1`],
      [heldInfo.thread, (id: string) => `/v1/threads/${id}`],
      [privateAsk.thread, (id: string) => `/v1/log?thread=${id}`],
      [privateAsk.thread, (id: string) => `/v1/search?q=password&thread=${id}`],
    ] as const) {
      const ref = await get(path(fake));
      const res = await get(path(real));
      expect(res.status, path(real)).toBe(404);
      expect(res.status).toBe(ref.status);
      expect(res.data.error?.message.replace(real, "X")).toBe(
        ref.data.error?.message.replace(fake, "X"),
      );
    }
  });

  it("nothing was attached to the private thread", async () => {
    const th = await t.raw<{ messages: unknown[] }>("GET", `/v1/threads/${privateAsk.thread}`);
    expect(th.data.messages).toHaveLength(1);
  });

  it("participants and your user still can", async () => {
    const reply = await post("beta", "/v1/messages", {
      kind: "reply",
      replyTo: privateAsk.id.slice(0, 12),
      text: "rotate monthly",
    });
    expect(reply.status, JSON.stringify(reply.data)).toBe(200);
    const follow = await post("alpha", "/v1/messages", {
      to: ["beta"],
      kind: "info",
      thread: privateAsk.thread,
      text: "thanks",
    });
    expect(follow.status, JSON.stringify(follow.data)).toBe(200);
    expect((follow.data.message as { thread: string }).thread).toBe(privateAsk.thread);
    const human = await post(undefined, "/v1/messages", {
      to: ["beta"],
      kind: "info",
      thread: privateAsk.thread,
      text: "from the user",
    });
    expect(human.status, JSON.stringify(human.data)).toBe(200);
  });
});
