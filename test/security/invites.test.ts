import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";

// SECURITY.md: agentlink refuses to carry invite codes in messages between agents, whatever part
// of the message they are in.
let t: TestDaemon;

beforeAll(async () => {
  t = await startTestDaemon();
  for (const name of ["alpha", "beta"]) {
    const proc = t.fakeAgentProcess("generic");
    await t.client().request("POST", "/v1/agents/register", {
      tool: "generic",
      name,
      pid: proc.pid,
      state: "idle",
    });
  }
}, 30_000);

afterAll(async () => {
  await t?.stop();
});

const b64 = (s: string) => Buffer.from(s).toString("base64");
const al1 = `al1.${"A1b2-C3d4_".repeat(6)}`;

describe("invite codes outside text parts", () => {
  for (const [what, parts] of [
    [
      "an al1 invite in file bytes",
      [{ kind: "file", file: { name: "notes.txt", bytes: b64(`join with ${al1}\n`) } }],
    ],
    ["a short code in a data part", [{ kind: "data", data: { code: "kite-moon-river-sail-07" } }]],
    [
      "a short code after a line break in a data part",
      [{ kind: "data", data: { note: "join:\nkite-moon-river-sail-07" } }],
    ],
    [
      "a short code as a file name",
      [{ kind: "file", file: { name: "lamp-orbit-moon-kite-42.txt", bytes: b64("hello") } }],
    ],
  ] as const) {
    it(`refuses ${what} from an agent`, async () => {
      const res = await t.raw("POST", "/v1/messages", { to: ["beta"], parts }, { as: "alpha" });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.data)).toContain("invites are for people");
    });

    it(`still lets a person send ${what}`, async () => {
      const res = await t.raw("POST", "/v1/messages", { to: ["beta"], parts });
      expect(res.status).toBe(200);
    });
  }
});

describe("invite codes split or spaced out", () => {
  for (const [what, parts] of [
    [
      "a short code split across two parts",
      [
        { kind: "text", text: "lamp-orbit" },
        { kind: "text", text: "moon-kite-42" },
      ],
    ],
    ["a short code with spaces", [{ kind: "text", text: "use lamp orbit moon kite 42" }]],
    ["a short code with a line break", [{ kind: "text", text: "lamp-orbit-moon-kite-\n42" }]],
    ["an al1 invite with a space after al1.", [{ kind: "text", text: al1.replace(".", ". ") }]],
  ] as const) {
    it(`refuses ${what} from an agent`, async () => {
      const res = await t.raw("POST", "/v1/messages", { to: ["beta"], parts }, { as: "alpha" });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.data)).toContain("invites are for people");
    });

    it(`still lets a person send ${what}`, async () => {
      const res = await t.raw("POST", "/v1/messages", { to: ["beta"], parts });
      expect(res.status).toBe(200);
    });
  }

  it("lets an agent send ordinary prose with words and numbers", async () => {
    const text = "The lamp test in moon kite 42 failed twice; see lines 10-42, then park the boat.";
    const res = await t.raw(
      "POST",
      "/v1/messages",
      { to: ["beta"], parts: [{ kind: "text", text }] },
      { as: "alpha" },
    );
    expect(res.status).toBe(200);
  });
});
