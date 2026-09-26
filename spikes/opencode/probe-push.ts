import { appendFileSync, mkdirSync } from "node:fs";
const OUT = "__REPO__/spikes/out/opencode";
mkdirSync(OUT, { recursive: true });
const log = (x: unknown) => appendFileSync(`${OUT}/push.jsonl`, `${JSON.stringify(x)}\n`);
let pushed = false;
export const Probe = async (ctx: Record<string, any>) => {
  log({ type: "init", pid: process.pid, serverUrl: String(ctx.serverUrl) });
  return {
    event: async ({ event }: { event: { type: string; properties?: Record<string, any> } }) => {
      if (event.type === "session.idle" && !pushed) {
        pushed = true;
        const id = event.properties?.sessionID;
        try {
          const res = await ctx.client.session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text: "Reply with just: PUSHED-OK" }] } });
          log({ type: "promptAsync", id, status: res?.response?.status, error: res?.error ?? null });
        } catch (e) { log({ type: "promptAsync-error", error: String(e) }); }
      }
      if (event.type === "session.status" || event.type === "session.idle") log({ type: event.type, status: event.properties?.status });
    },
  };
};
