// A fake agent session: a long-lived process that the daemon sees as the agent CLI (the worker
// starts it with argv[0] = /usr/local/bin/<tool's binary>), driven by the worker over IPC. It calls the
// daemon as itself (so kernel caller checks resolve it), fires hooks in-process (as the CLI's
// hook command would, same 2s timeout) or through the real `agentlink hook` CLI as a child, and
// stands in for push channels: a Claude inbox socket and the OpenCode plugin's long-poll.
// Config comes from SIM_AGENT_CFG (never argv: argv is matched against tool names).
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { performance } from "node:perf_hooks";
import { ancestry } from "../../src/core/proc.ts";
import { b64, injectedIds, type Json, unixRequest } from "./lib.ts";

const cfg = JSON.parse(process.env.SIM_AGENT_CFG ?? "{}") as {
  key: string;
  socket: string;
  tool: string;
  cliPath: string;
  agentlinkHome: string;
  home: string;
  cwd: string;
};
delete process.env.SIM_AGENT_CFG;

const chain = () =>
  ancestry(process.pid).map((p) => ({
    pid: p.pid,
    ppid: p.ppid,
    ...(p.start ? { start: p.start } : {}),
    cmd: p.cmd.slice(0, 4).map((a) => a.slice(0, 200)),
  }));
let cachedChain: ReturnType<typeof chain> | undefined;
const caller = () => {
  cachedChain ??= chain();
  return b64({ pid: process.pid, chain: cachedChain, tty: false });
};

const emit = (ev: Json) => process.send?.({ ev: { ...ev, t: Date.now(), agent: cfg.key } });

let claudeServer: Server | undefined;
let claudeSocketPath: string | undefined;
let opencodeAgentId: string | undefined;
let opencodeRunning = false;
let opencodeAck: "ok" | "fail" | "slow" = "ok";
let sseAbort: (() => void) | undefined;

async function hook(args: {
  event: string;
  payload: Json;
  real?: boolean;
  timeoutMs?: number;
}): Promise<Json> {
  const env: Json = {
    cwd: cfg.cwd,
    ...(claudeSocketPath ? { claudeSocket: claudeSocketPath } : {}),
  };
  if (args.real) {
    const t0 = performance.now();
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [cfg.cliPath, "hook", cfg.tool, args.event], {
        cwd: cfg.cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: cfg.home,
          AGENTLINK_HOME: cfg.agentlinkHome,
          ...(claudeSocketPath ? { CLAUDE_CODE_MESSAGING_SOCKET: claudeSocketPath } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      child.stderr.on("data", (c: Buffer) => {
        err += c.toString("utf8");
      });
      child.on("close", (code) => {
        const ms = performance.now() - t0;
        const ids = injectedIds(out);
        if (ids.length) emit({ type: "inject", via: `hook:${args.event}`, ids });
        resolve({ ms, code, stdout: out.slice(0, 200_000), stderr: err.slice(0, 2000), ids });
      });
      child.stdin.end(JSON.stringify(args.payload));
    });
  }
  const res = await unixRequest<{ stdout?: string; env?: Record<string, string> }>(
    cfg.socket,
    "POST",
    `/v1/hooks/${cfg.tool}/${args.event}`,
    { payload: args.payload, chain: chain(), env },
    { "x-agentlink-caller": caller() },
    args.timeoutMs ?? 2_000,
  );
  const ids = injectedIds(res.data?.stdout);
  if (ids.length) emit({ type: "inject", via: `hook:${args.event}`, ids });
  if (res.data?.env?.AGENTLINK_AGENT) opencodeAgentId = res.data.env.AGENTLINK_AGENT;
  return { ...res, ids };
}

function claudeInbox(path: string): Promise<Json> {
  return new Promise((resolve) => {
    rmSync(path, { force: true });
    claudeServer = createServer((conn) => {
      let buf = "";
      conn.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
      });
      conn.on("end", () => {
        for (const line of buf.split("\n").filter(Boolean)) {
          let text = "";
          try {
            text = String(
              (JSON.parse(line) as { message?: { content?: string } }).message?.content,
            );
          } catch {
            text = line;
          }
          emit({ type: "inject", via: "claude-inbox", ids: injectedIds(text) });
        }
      });
    });
    claudeServer.listen(path, () => {
      claudeSocketPath = path;
      resolve({ ok: true, path });
    });
    claudeServer.on("error", (e) => resolve({ ok: false, error: String(e) }));
  });
}

async function opencodeLoop(): Promise<void> {
  if (opencodeRunning) return;
  opencodeRunning = true;
  while (opencodeRunning) {
    if (!opencodeAgentId) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    const res = await unixRequest<{
      push?: { token: string; text: string; deliveryIds: number[]; reply: boolean } | null;
    }>(
      cfg.socket,
      "GET",
      `/v1/adapters/opencode/poll?agent=${opencodeAgentId}&timeoutMs=25000`,
      undefined,
      { "x-agentlink-caller": caller() },
      35_000,
      true,
    );
    if (res.status !== 200) {
      emit({ type: "opencode-poll-error", status: res.status, error: res.error ?? null });
      await new Promise((r) => setTimeout(r, 1_000));
      continue;
    }
    const push = res.data.push;
    if (!push) continue;
    const ok = opencodeAck !== "fail";
    if (ok)
      emit({
        type: "inject",
        via: "opencode-push",
        ids: injectedIds(push.text),
        deliveryIds: push.deliveryIds,
      });
    if (opencodeAck === "slow") await new Promise((r) => setTimeout(r, 16_000));
    await unixRequest(
      cfg.socket,
      "POST",
      "/v1/adapters/opencode/ack",
      { token: push.token, ok },
      { "x-agentlink-caller": caller() },
      5_000,
    );
  }
}

function sse(): Json {
  sseAbort?.();
  const req = request(
    {
      socketPath: cfg.socket,
      path: "/v1/events",
      method: "GET",
      headers: { "x-agentlink-caller": caller() },
    },
    (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let i = buffer.indexOf("\n\n");
        while (i >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const e = JSON.parse(line.slice(6)) as Json;
              const m = e.message as Json | undefined;
              const d = e.delivery as Json | undefined;
              if (e.type === "message")
                emit({ type: "sse", kind: "message", id: m?.id, from: m?.from });
              else if (e.type === "delivery")
                emit({
                  type: "sse",
                  kind: "delivery",
                  id: d?.messageId,
                  did: d?.id,
                  state: d?.state,
                });
            } catch {}
          }
          i = buffer.indexOf("\n\n");
        }
      });
      res.on("end", () => emit({ type: "sse-end" }));
    },
  );
  req.on("error", (e) => emit({ type: "sse-end", error: String(e) }));
  req.end();
  sseAbort = () => req.destroy();
  return { ok: true };
}

process.on("message", async (msg: { id: number; op: string; args?: Json }) => {
  let result: unknown;
  try {
    const a = msg.args ?? {};
    switch (msg.op) {
      case "hook":
        result = await hook(a as never);
        break;
      case "api":
        result = await unixRequest(
          cfg.socket,
          String(a.method),
          String(a.path),
          a.body,
          { "x-agentlink-caller": caller() },
          Number(a.timeoutMs ?? 15_000),
        );
        break;
      case "claudeInbox":
        result = await claudeInbox(String(a.path));
        break;
      case "opencode":
        if (a.agentId) opencodeAgentId = String(a.agentId);
        if (a.ack) opencodeAck = a.ack as never;
        void opencodeLoop();
        result = { ok: true };
        break;
      case "sse":
        result = sse();
        break;
      case "ping":
        result = { pid: process.pid, chain: chain() };
        break;
      default:
        result = { error: `unknown op ${msg.op}` };
    }
  } catch (error) {
    result = { error: String((error as Error)?.stack ?? error) };
  }
  process.send?.({ id: msg.id, result });
});
process.on("disconnect", () => process.exit(0));
process.send?.({ ready: true, pid: process.pid });
