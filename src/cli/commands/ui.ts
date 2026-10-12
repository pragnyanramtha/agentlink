import { spawn } from "node:child_process";
import { executable, hasInterop } from "../../core/wsl.ts";
import { type Command, out, parse, UsageError } from "../args.ts";
import { c } from "../format.ts";

/** How to open a URL here. Under WSL the Windows browser (interop), which reaches 127.0.0.1. */
export function browserOpener(
  url: string,
  sys: { platform: string; interop: boolean; exe: (path: string) => string | undefined } = {
    platform: process.platform,
    interop: hasInterop(),
    exe: executable,
  },
): { bin: string; args: string[]; okCodes: number[] } {
  if (sys.platform === "darwin") return { bin: "open", args: [url], okCodes: [0] };
  if (sys.interop) {
    const rundll = sys.exe("/mnt/c/Windows/System32/rundll32.exe");
    if (rundll) return { bin: rundll, args: ["url.dll,FileProtocolHandler", url], okCodes: [0] };
    // explorer.exe exits 1 even when it opened the page.
    const explorer = sys.exe("/mnt/c/Windows/explorer.exe") ?? "explorer.exe";
    return { bin: explorer, args: [url], okCodes: [0, 1] };
  }
  return { bin: "xdg-open", args: [url], okCodes: [0] };
}

/**
 * Opens a URL in the default browser: no shell, detached, output ignored. Opened only if the
 * opener exits successfully (xdg-open fails without a handler), or is still running after 5s.
 */
function openBrowser(url: string): Promise<boolean> {
  const { bin, args, okCodes } = browserOpener(url);
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, args, { detached: true, stdio: "ignore" });
      const timer = setTimeout(() => {
        child.unref();
        resolve(true);
      }, 5_000);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
      child.once("error", () => done(false));
      child.once("exit", (code) => done(code !== null && okCodes.includes(code)));
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
