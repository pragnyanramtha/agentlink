import { execFile } from "node:child_process";
import { request } from "node:http";
import { join } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server.ts";
import { startTestDaemon, type TestDaemon, until } from "../helpers.ts";

// Found by scripts/sim (invariant: nothing is delivered while paused). `agentlink pause` made
// GET /v1/inbox return nothing for agents, but log, search, thread and show still returned the
// new message's text, `show` marked it seen, and the event stream carried it.
let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon();
  for (const name of ["ann", "bob"]) {
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

describe("while agentlink is paused", () => {
  it("an agent cannot read new mail through any route; you still can", async () => {
    await t.raw("POST", "/v1/control", { action: "pause" });
    const sent = await t.raw<{ message: { id: string; thread: string } }>(
      "POST",
      "/v1/messages",
      { to: ["bob"], kind: "ask", text: "zebracorn deploy key rotation" },
      { as: "ann" },
    );
    const { id, thread } = sent.data.message;
    const inbox = await t.raw<{ paused?: boolean }>("GET", "/v1/inbox", undefined, { as: "bob" });
    expect(inbox.data.paused).toBe(true);

    const reads = {
      log: await t.raw("GET", "/v1/log", undefined, { as: "bob" }),
      search: await t.raw("GET", "/v1/search?q=zebracorn", undefined, { as: "bob" }),
      threads: await t.raw("GET", "/v1/threads", undefined, { as: "bob" }),
      thread: await t.raw("GET", `/v1/threads/${thread}`, undefined, { as: "bob" }),
      show: await t.raw("GET", `/v1/messages/${id}`, undefined, { as: "bob" }),
      todo: await t.raw("GET", "/v1/todo", undefined, { as: "bob" }),
    };
    const leaked = Object.entries(reads)
      .filter(([, r]) => JSON.stringify(r.data).includes("zebracorn"))
      .map(([k]) => k);
    expect(leaked).toEqual([]);
    expect(JSON.stringify(reads.show.data)).toContain("paused");
    expect(t.daemon.services.mailbox.deliveriesOf(id)[0]?.state).toBe("queued");

    // You are not paused: your view shows it, without marking it read for bob.
    const mine = await t.raw("GET", "/v1/search?q=zebracorn");
    expect(JSON.stringify(mine.data)).toContain("zebracorn");
    expect(t.daemon.services.mailbox.deliveriesOf(id)[0]?.state).toBe("queued");

    await t.raw("POST", "/v1/control", { action: "resume" }, { tty: true });
    const after = await t.raw("GET", `/v1/messages/${id}`, undefined, { as: "bob" });
    expect(JSON.stringify(after.data)).toContain("zebracorn");
  });

  it("an agent's event stream says paused instead of carrying mail", async () => {
    await t.raw("POST", "/v1/control", { action: "pause" });
    const header = Buffer.from(
      JSON.stringify({ pid: 0, chain: [], tty: false, as: "bob" }),
    ).toString("base64url");
    let seen = "";
    const req = request({
      socketPath: t.paths.socket,
      path: "/v1/events",
      headers: { "x-agentlink-caller": header },
    });
    req.on("response", (res) => res.on("data", (c: Buffer) => (seen += c.toString("utf8"))));
    req.on("error", () => undefined);
    req.end();
    await until(() => seen.includes(": connected"));
    await t.raw(
      "POST",
      "/v1/messages",
      { to: ["bob"], text: "zebracorn while paused" },
      { as: "ann" },
    );
    await t.raw("POST", "/v1/control", { action: "resume" }, { tty: true });
    await t.raw("POST", "/v1/messages", { to: ["bob"], text: "after resume" }, { as: "ann" });
    await until(() => seen.includes("after resume"));
    req.destroy();
    expect(seen).toContain("agentlink is paused");
    expect(seen).not.toContain("zebracorn");
  });

  it("the CLI and MCP tools say paused instead of 'nothing'", async () => {
    await t.raw("POST", "/v1/control", { action: "pause" });
    const sent = await t.raw<{ message: { id: string; thread: string } }>(
      "POST",
      "/v1/messages",
      { to: ["bob"], kind: "ask", text: "zebracorn deploy key rotation" },
      { as: "ann" },
    );
    const { id, thread } = sent.data.message;
    const CLI = join(import.meta.dirname, "../../src/cli/index.ts");
    const env = { ...process.env, HOME: t.home, AGENTLINK_HOME: t.home, NO_COLOR: "1" };
    const cli = (...args: string[]) =>
      new Promise<string>((resolve) =>
        execFile(process.execPath, [CLI, "--as", "bob", ...args], { env }, (_e, out, err) =>
          resolve(out + err),
        ),
      );
    const said: Record<string, string> = {};
    for (const args of [["todo"], ["log"], ["search", "zebracorn"], ["threads"], ["status"]])
      said[`cli ${args[0]}`] = await cli(...args);
    said["cli show"] = await cli("show", id);
    said["cli thread"] = await cli("thread", thread);

    const server = createMcpServer({ paths: t.paths, as: "bob" });
    const client = new McpClient({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    for (const [name, args] of [
      ["inbox", {}],
      ["todo", {}],
      ["search", { words: "zebracorn" }],
      ["threads", {}],
      ["show", { id }],
      ["thread", { id: thread }],
    ] as const) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: { text: string }[];
      };
      said[`mcp ${name}`] = res.content.map((x) => x.text).join("\n");
    }
    await client.close();
    const quiet = Object.entries(said)
      .filter(([, text]) => !text.includes("agentlink is paused") || text.includes("zebracorn"))
      .map(([k, text]) => `${k}: ${text}`);
    expect(quiet).toEqual([]);
  }, 30_000);
});
