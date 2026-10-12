import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "../../src/cli/client.ts";
import { resolvePaths } from "../../src/core/paths.ts";

describe("a daemon that cannot start", () => {
  const home = mkdtempSync(join(tmpdir(), "agentlink-start-"));
  const savedHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("says why, from the daemon's own output, instead of only pointing at the log", async () => {
    process.env.HOME = home;
    // `run` is a file, so the daemon cannot create its socket directory and exits at once.
    writeFileSync(join(home, "run"), "");
    const paths = resolvePaths({ AGENTLINK_HOME: home, HOME: home } as NodeJS.ProcessEnv);
    const started = Date.now();
    const error = await new Client(paths).ensureDaemon({ waitMs: 10_000 }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const lines = (error as Error).message.split("\n");
    expect(lines[0]).toMatch(/^the daemon did not start: EEXIST: .*mkdir '.*\/run'/);
    expect(lines.at(-1)).toBe(`  (log: ${paths.log})`);
    // it stops waiting once the daemon has exited
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000);
});
