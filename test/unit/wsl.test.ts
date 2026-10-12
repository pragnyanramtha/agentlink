import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type InstallContext,
  instructionPath,
  planTool,
  skillPath,
  VirtualFs,
} from "../../src/adapters/install/targets.ts";
import { lastStartError, startError, startFailure, startHint } from "../../src/cli/client.ts";
import { browserOpener } from "../../src/cli/commands/ui.ts";
import { resolvePaths } from "../../src/core/paths.ts";
import { classifyProbe, probePeerLookup } from "../../src/core/peer.ts";
import {
  fsType,
  hasInterop,
  onWindowsDrive,
  socketlessFs,
  type WslIo,
  wslVersion,
} from "../../src/core/wsl.ts";
import type { DaemonContext } from "../../src/daemon/context.ts";
import type { Mailbox } from "../../src/daemon/mailbox.ts";
import { DesktopNotifier, notifierArgs, toastScript } from "../../src/daemon/notify.ts";

const io = (files: Record<string, string>): WslIo => ({
  read: (p) => files[p],
  exists: (p) => p in files,
});
const OSREL = "/proc/sys/kernel/osrelease";
const INTEROP = "/proc/sys/fs/binfmt_misc/WSLInterop";

const tmp: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlink-wsl-"));
  tmp.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("WSL detection", () => {
  it("tells WSL 1, WSL 2 and plain Linux apart from the kernel, not the environment", () => {
    expect(wslVersion(io({ [OSREL]: "5.15.167.4-microsoft-standard-WSL2\n" }))).toBe(2);
    expect(wslVersion(io({ [OSREL]: "4.4.0-19041-Microsoft\n" }))).toBe(1);
    expect(wslVersion(io({ [OSREL]: "6.6.36-custom\n", [INTEROP]: "enabled\n" }))).toBe(2);
    expect(wslVersion(io({ [OSREL]: "6.8.0-45-generic\n" }))).toBe(0);
    expect(wslVersion(io({}))).toBe(0);
  });

  it("knows whether Windows programs can be started", () => {
    const wsl2 = { [OSREL]: "5.15.0-microsoft-standard-WSL2" };
    expect(hasInterop(io({ ...wsl2, [INTEROP]: "enabled\ninterpreter /init\n" }))).toBe(true);
    expect(hasInterop(io({ ...wsl2, [INTEROP]: "disabled\n" }))).toBe(false);
    expect(
      hasInterop(io({ ...wsl2, "/proc/sys/fs/binfmt_misc/WSLInterop-late": "enabled\n" })),
    ).toBe(true);
    expect(
      hasInterop(io({ [OSREL]: "4.4.0-Microsoft", "/mnt/c/Windows/System32/cmd.exe": "" })),
    ).toBe(true);
    expect(hasInterop(io({ [OSREL]: "6.8.0-generic", [INTEROP]: "enabled" }))).toBe(true);
    expect(hasInterop(io({ [OSREL]: "6.8.0-generic" }))).toBe(false);
  });

  it("finds Windows drives and filesystems without Unix sockets", () => {
    expect(onWindowsDrive("/mnt/c/Users/me/AppData/Roaming/npm")).toBe(true);
    expect(onWindowsDrive("/mnt/c")).toBe(true);
    expect(onWindowsDrive("/mnt/data/bin")).toBe(false);
    expect(onWindowsDrive("/home/me/.local/bin")).toBe(false);
    const mountinfo = [
      "22 1 8:32 / / rw,relatime - ext4 /dev/sdc rw",
      "60 22 0:52 / /mnt/c rw,noatime - 9p C:\\134 rw,aname=drvfs;path=C:\\",
      "61 22 0:53 / /mnt/wslg rw,relatime - tmpfs none rw",
      "62 22 0:54 / /mnt/my\\040drive rw - drvfs D:\\134 rw",
    ].join("\n");
    expect(fsType("/mnt/c/Users/me/.agentlink/run", mountinfo)).toBe("9p");
    expect(socketlessFs("/mnt/c/Users/me/.agentlink", mountinfo)).toBe("9p");
    expect(socketlessFs("/mnt/my drive/x", mountinfo)).toBe("drvfs");
    expect(socketlessFs("/mnt/wslg/runtime-dir", mountinfo)).toBeUndefined();
    expect(socketlessFs("/home/me/.agentlink", mountinfo)).toBeUndefined();
    expect(fsType("/mnt/cc/x", mountinfo)).toBe("ext4");
  });
});

describe("the socket directory fallback", () => {
  const longHome = (dir: string) => join(dir, "x".repeat(110));

  it("skips an XDG_RUNTIME_DIR that is not ours (WSLg's shared one) for the private /tmp dir", () => {
    const home = longHome(tempDir());
    const paths = resolvePaths({ AGENTLINK_HOME: home, XDG_RUNTIME_DIR: "/" });
    expect(paths.socket.startsWith(join(tmpdir(), `agentlink-${process.getuid?.()}`))).toBe(true);
    const missing = resolvePaths({ AGENTLINK_HOME: home, XDG_RUNTIME_DIR: "/nonexistent/run" });
    expect(missing.socket.startsWith("/nonexistent")).toBe(false);
  });

  it("uses an XDG_RUNTIME_DIR that belongs to us", () => {
    const runtime = tempDir();
    const paths = resolvePaths({ AGENTLINK_HOME: longHome(tempDir()), XDG_RUNTIME_DIR: runtime });
    expect(paths.socket.startsWith(`${runtime}/agentlink-`)).toBe(true);
  });
});

describe("daemon start diagnostics", () => {
  const paths = resolvePaths({ AGENTLINK_HOME: "/mnt/c/Users/me/.agentlink" });

  it("finds the reason in the daemon's log, including Node's own errors", () => {
    const log = [
      "2026-01-01T00:00:00.000Z INFO  daemon stopped",
      "agentlink daemon: listen EOPNOTSUPP: operation not supported on socket /mnt/c/Users/me/.agentlink/run/agentlink.sock",
    ].join("\n");
    expect(startError(log)).toMatch(/^listen EOPNOTSUPP/);
    const node = [
      "node:internal/modules/esm/resolve:275",
      "    throw new ERR_UNKNOWN_BUILTIN_MODULE(specifier);",
      "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite",
      "    at foo (node:internal/x:1:1)",
      "Node.js v20.11.0",
    ].join("\n");
    expect(startError(node)).toMatch(/^Error \[ERR_UNKNOWN_BUILTIN_MODULE\]/);
    expect(startError("2026 INFO  daemon started\n")).toBeUndefined();
  });

  it("maps known failures to a next step", () => {
    expect(startHint("listen EOPNOTSUPP: operation not supported on socket /mnt/c/x", paths)).toBe(
      "Unix sockets don't work on Windows drives (/mnt/c, …) under WSL: use a Linux path, e.g. export AGENTLINK_HOME=~/.agentlink (now /mnt/c/Users/me/.agentlink)",
    );
    expect(
      startHint(
        "socket directory /mnt/wslg/runtime-dir is not a directory owned by you; refusing to use it",
        paths,
        { XDG_RUNTIME_DIR: "/mnt/wslg/runtime-dir" },
      ),
    ).toContain("XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir");
    expect(startHint("EACCES: permission denied, mkdir '/x/run'", paths)).toContain("ls -ld");
    expect(
      startHint("Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite", paths),
    ).toContain("Node.js 22.13");
    expect(startHint("database is locked", paths)).toContain("local Linux disk");
    // the daemon's own refusal already says what to do
    expect(
      startHint("/mnt/c/x is on a 9p filesystem …; set AGENTLINK_HOME to a Linux path", paths),
    ).toBeUndefined();
    expect(startHint("something new", paths)).toBeUndefined();
  });

  it("explains a failed start instead of only pointing at the log", () => {
    const text = startFailure(
      paths,
      "agentlink daemon: listen EOPNOTSUPP: operation not supported on socket /mnt/c/s.sock\n",
      1,
    );
    expect(text.split("\n")).toEqual([
      "the daemon did not start: listen EOPNOTSUPP: operation not supported on socket /mnt/c/s.sock",
      expect.stringContaining("Unix sockets don't work on Windows drives"),
      `  (log: ${paths.log})`,
    ]);
    expect(startFailure(paths, "", 1)).toContain("it exited with code 1");
    expect(startFailure(paths, "", null)).toContain("did not answer within a few seconds");
  });

  it("reports the last failed start until a start succeeds", () => {
    const home = tempDir();
    const p = resolvePaths({ AGENTLINK_HOME: home });
    expect(lastStartError(p)).toBeUndefined();
    writeFileSync(p.log, "x INFO  daemon started\nagentlink daemon: listen EACCES: nope\n");
    expect(lastStartError(p)).toBe("listen EACCES: nope");
    writeFileSync(p.log, "agentlink daemon: listen EACCES: nope\nx INFO  daemon started\n");
    expect(lastStartError(p)).toBeUndefined();
    writeFileSync(p.log, "agentlink daemon: agentlink daemon already running (pid 4)\n");
    expect(lastStartError(p)).toBeUndefined();
  });
});

describe("the caller-check self-test", () => {
  const table = (rows: string[]) => `${rows.join("\n")}\n`;

  it("tells a system that can name callers from one that never can", () => {
    expect(classifyProbe({ pid: 42 }, 42, 0)).toEqual({ state: "ok" });
    expect(classifyProbe({ error: { code: "ENOENT", message: "ss not found" } }, 42, 0).state).toBe(
      "missing",
    );
    const netlink = classifyProbe(
      {
        error: {
          code: 1,
          stderr: "Cannot open netlink socket: Protocol not supported\n",
          message: "x",
        },
      },
      42,
      1,
    );
    expect(netlink).toMatchObject({
      state: "broken",
      remedy: expect.stringContaining("wsl --set-version"),
    });
    // no unix_diag: ss reads /proc/net/unix, where every peer is 0
    const noDiag = classifyProbe(
      {
        table: table([
          'u_str ESTAB 0 0 /run/a.sock 1234 * 0 users:(("node",pid=42,fd=20))',
          'u_str ESTAB 0 0 * 1235 * 0 users:(("node",pid=42,fd=21))',
        ]),
      },
      42,
      2,
    );
    expect(noDiag).toMatchObject({
      state: "broken",
      reason: expect.stringContaining("unix_diag"),
      remedy: expect.stringContaining("sudo modprobe unix_diag"),
    });
    const unnamed = classifyProbe(
      { table: "u_str ESTAB 0 0 * 5 * 6\n", row: { client: "5", procs: "" } },
      42,
      2,
    );
    expect(unnamed).toMatchObject({ state: "broken", reason: expect.stringContaining("name") });
  });

  it("stays fail-closed when the self-test proves nothing (no downgrade by load)", () => {
    // peers are reported, but our row is missing: something odd, not a missing capability
    const odd = classifyProbe(
      { table: 'u_str ESTAB 0 0 * 7 * 8 users:(("x",pid=9,fd=3))\n' },
      42,
      2,
    );
    expect(odd.state).toBe("inconclusive");
    const timeout = classifyProbe(
      { error: { code: "ETIMEDOUT", message: "Command failed: timed out" } },
      42,
      2,
    );
    expect(timeout.state).toBe("inconclusive");
    const buffer = classifyProbe(
      { error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", message: "maxBuffer exceeded" } },
      42,
      2,
    );
    expect(buffer.state).toBe("inconclusive");
    const wrong = classifyProbe(
      { table: "x", row: { client: "5", procs: 'users:(("x",pid=7,fd=3))' } },
      42,
      2,
    );
    expect(wrong.state).toBe("inconclusive");
  });

  it.skipIf(process.platform !== "linux")("runs against a real socket", async () => {
    expect((await probePeerLookup(tempDir())).state).toBe("ok");
    const broken = await probePeerLookup(tempDir(), {
      wsl: 2,
      run: async () => ({ stdout: 'u_str ESTAB 0 0 * 11 * 0 users:(("node",pid=1,fd=2))\n' }),
    });
    expect(broken.state).toBe("broken");
    const missing = await probePeerLookup(tempDir(), {
      run: async () => ({ error: { code: "ENOENT", message: "spawn ss ENOENT" } }),
    });
    expect(missing.state).toBe("missing");
  });
});

describe("opening the web UI", () => {
  const url = "http://127.0.0.1:4567/login?t=abc";
  const exe = (have: string[]) => (p: string) => (have.includes(p) ? p : undefined);

  it("opens the Windows browser under WSL, without a shell", () => {
    const rundll = "/mnt/c/Windows/System32/rundll32.exe";
    expect(browserOpener(url, { platform: "linux", interop: true, exe: exe([rundll]) })).toEqual({
      bin: rundll,
      args: ["url.dll,FileProtocolHandler", url],
      okCodes: [0],
    });
    const explorer = "/mnt/c/Windows/explorer.exe";
    expect(browserOpener(url, { platform: "linux", interop: true, exe: exe([explorer]) })).toEqual({
      bin: explorer,
      args: [url],
      okCodes: [0, 1],
    });
  });

  it("keeps xdg-open and open elsewhere", () => {
    expect(browserOpener(url, { platform: "linux", interop: false, exe: exe([]) }).bin).toBe(
      "xdg-open",
    );
    expect(browserOpener(url, { platform: "darwin", interop: false, exe: exe([]) }).bin).toBe(
      "open",
    );
  });
});

describe("Windows toast notifications", () => {
  it("passes the text base64-encoded inside an encoded command, never as PowerShell source", () => {
    const evil = 'hi\'); Remove-Item -Recurse C:\\ ; $(calc) `whoami` "x"';
    const script = toastScript(evil);
    expect(script).not.toContain("Remove-Item");
    expect(script).toContain(Buffer.from(evil, "utf8").toString("base64"));
    const args = notifierArgs(
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      evil,
    );
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(args[3]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(args[3] as string, "base64").toString("utf16le")).toBe(script);
    expect(notifierArgs("/usr/bin/notify-send", "x")).toEqual(["--", "agentlink", "x"]);
  });

  it("reports a test notification as sent only when the notifier succeeded", async () => {
    const dir = tempDir();
    const ctx = { config: {}, events: { subscribe: () => () => {} } } as unknown as DaemonContext;
    const script = (name: string, code: number) => {
      const bin = join(dir, name);
      writeFileSync(bin, `#!/bin/sh\nexit ${code}\n`);
      chmodSync(bin, 0o755);
      return bin;
    };
    const failing = new DesktopNotifier(ctx, {} as Mailbox, { bin: script("no-handler", 1) });
    expect(await failing.test()).toMatchObject({ found: true, sent: false });
    const working = new DesktopNotifier(ctx, {} as Mailbox, { bin: script("works", 0) });
    expect(await working.test()).toMatchObject({ found: true, sent: true });
  });
});

describe("CODEX_HOME and CLAUDE_CONFIG_DIR", () => {
  it("writes those tools' user config where their env vars point", () => {
    const home = tempDir();
    const codexHome = join(home, "elsewhere", "codex");
    const claudeHome = join(home, "elsewhere", "claude");
    mkdirSync(codexHome, { recursive: true });
    const ctx: InstallContext = {
      home,
      agentlinkHome: join(home, ".agentlink"),
      socket: join(home, ".agentlink", "run", "agentlink.sock"),
      pendingDir: join(home, ".agentlink", "run", "pending"),
      shim: join(home, ".agentlink", "bin", "agentlink"),
      scope: "user",
      mcp: false,
      env: { PATH: "/usr/bin:/bin", CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome },
    };
    const fs = new VirtualFs();
    planTool("codex", ctx, fs, true);
    planTool("claude", ctx, fs, true);
    const paths = fs.changes().map((c) => c.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        join(codexHome, "hooks.json"),
        join(codexHome, "config.toml"),
        join(codexHome, "AGENTS.md"),
        join(codexHome, "skills", "agentlink", "SKILL.md"),
        join(claudeHome, "settings.json"),
        join(claudeHome, "CLAUDE.md"),
        join(claudeHome, "skills", "agentlink", "SKILL.md"),
      ]),
    );
    expect(paths.some((p) => p.includes(`${home}/.codex`) || p.includes(`${home}/.claude`))).toBe(
      false,
    );
    expect(instructionPath("codex", ctx)).toBe(join(codexHome, "AGENTS.md"));
    expect(skillPath("claude", ctx)).toBe(join(claudeHome, "skills", "agentlink", "SKILL.md"));
  });
});
