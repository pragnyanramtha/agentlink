import { appendFileSync, mkdirSync } from "node:fs";
const OUT = "/home/pik/dev/agent-speak/spikes/out/opencode";
mkdirSync(OUT, { recursive: true });
const log = (x: unknown) => appendFileSync(`${OUT}/events.jsonl`, `${JSON.stringify(x)}\n`);
const keys = (o: unknown) => (o && typeof o === "object" ? Object.keys(o as object) : typeof o);
export const Probe = async (ctx: Record<string, any>) => {
  log({ type: "init", pid: process.pid, ctxKeys: keys(ctx), directory: ctx.directory, worktree: ctx.worktree,
        serverUrl: ctx.serverUrl ? String(ctx.serverUrl) : undefined, project: ctx.project,
        clientKeys: keys(ctx.client), sessionKeys: keys(ctx.client?.session), tuiKeys: keys(ctx.client?.tui) });
  return {
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      const p = event.properties ?? {};
      log({ type: "event", event: event.type, propKeys: keys(p), sessionID: (p as any).sessionID ?? (p as any).info?.id ?? (p as any).part?.sessionID, status: (p as any).status });
    },
  };
};
