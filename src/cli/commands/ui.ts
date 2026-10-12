import { spawn } from "node:child_process";
import { type Command, out, parse, UsageError } from "../args.ts";
import { c } from "../format.ts";

/** Opens a URL in the default browser: no shell, detached, output ignored. */
function openBrowser(url: string): Promise<boolean> {
  const bin = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, [url], { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

export const ui: Command = async (ctx) => {
  const { values } = parse(ctx.argv, {
    "no-open": { type: "boolean" },
    port: { type: "string" },
  });
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && !(Number.isInteger(port) && port >= 1024 && port <= 65535)) {
    throw new UsageError("--port takes a number from 1024 to 65535");
  }
  await ctx.client.ensureDaemon();
  const res = await ctx.client.request<{ url: string; port: number; expiresAt: string }>(
    "POST",
    "/v1/ui/session",
    port ? { port } : {},
  );
  const opened = !values["no-open"] && (await openBrowser(res.url));
  out(ctx, { ...res, opened }, () =>
    [
      `${c.green("✓")} agentlink web UI${opened ? " opened in your browser" : ""}:`,
      `  ${res.url}`,
      c.dim(
        `The link works once and expires in 2 minutes; run agentlink ui again for a new one.${port && port !== res.port ? ` (The UI already runs on port ${res.port}.)` : ""}`,
      ),
    ].join("\n"),
  );
  return 0;
};
