import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { openCodePluginSource } from "../../src/adapters/install/opencode-plugin.ts";

// The generated plugin runs inside OpenCode: drive it with OpenCode's event shapes
// (session.created/updated → info: Session; message.updated → info: Message) and a fake daemon.
const dir = mkdtempSync(join(tmpdir(), "agentlink-ocplugin-"));
const socket = join(dir, "d.sock");
const hooks: { event: string; payload: Record<string, unknown> }[] = [];
let server: Server;

afterAll(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("OpenCode plugin", () => {
  it("reports the session's model and title with its busy/idle hooks", async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const m = /^\/v1\/hooks\/opencode\/(.+)$/.exec(req.url ?? "");
        if (!m) return; // the long poll: never answered here
        hooks.push({ event: m[1] as string, payload: JSON.parse(body).payload });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ env: { AGENTLINK_AGENT: "a1" } }));
      });
    });
    await new Promise<void>((r) => server.listen(socket, r));
    const file = join(dir, "plugin.mjs");
    writeFileSync(file, openCodePluginSource(socket));
    const { AgentLink } = await import(pathToFileURL(file).href);
    const client = {
      session: {
        get: async () => ({ data: { id: "ses_1", title: "New session" } }),
        promptAsync: async () => ({}),
      },
    };
    const plugin = await AgentLink({ client, directory: dir });
    const fire = (type: string, properties: Record<string, unknown>) =>
      plugin.event({ event: { type, properties } });
    const settle = () => new Promise((r) => setTimeout(r, 100));

    await fire("session.created", { info: { id: "ses_1", title: "New session" } });
    await settle();
    await fire("message.updated", {
      info: {
        id: "m1",
        sessionID: "ses_1",
        role: "user",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      },
    });
    await fire("session.status", { sessionID: "ses_1", status: { type: "busy" } });
    await settle();
    await fire("session.updated", { info: { id: "ses_1", title: "Refactor auth" } });
    await fire("message.updated", {
      info: {
        id: "m2",
        sessionID: "ses_1",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
      },
    });
    await fire("session.status", { sessionID: "ses_1", status: { type: "idle" } });
    await settle();

    expect(hooks[0]?.event).toBe("session-start");
    const busy = hooks.find((h) => h.event === "prompt-submit");
    expect(busy?.payload).toMatchObject({
      session_id: "ses_1",
      model: "anthropic/claude-sonnet-4-5",
      session_title: "New session",
    });
    const idle = hooks.filter((h) => h.event === "turn-complete").at(-1);
    expect(idle?.payload).toMatchObject({ model: "openai/gpt-5", session_title: "Refactor auth" });
  });
});
