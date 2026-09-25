#!/usr/bin/env node
// Spike helper: logs a CLI hook invocation (payload, env, process tree) and optionally
// answers with an injection. Usage: hook-probe.mjs <tool> <event> <mode> [format]
//   mode:   log | inject-once | block-once
//   format: claude (hookSpecificOutput.additionalContext) | flat (additionalContext) |
//           snake (additional_context)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [tool = "x", event = "x", mode = "log", format = "claude"] = process.argv.slice(2);
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "out", tool);
mkdirSync(outDir, { recursive: true });
const started = Date.now();

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    return "?";
  }
}

function ppidOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return 0;
  }
}

const raw = readStdin();
let payload = raw;
try {
  payload = JSON.parse(raw);
} catch {}
const chain = [];
for (let pid = process.ppid, i = 0; pid > 1 && i < 6; pid = ppidOf(pid), i++) chain.push({ pid, cmd: cmdline(pid) });
const interesting = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    /^(CLAUDE|CODEX|GEMINI|COPILOT|CURSOR|KIRO|DEVIN|OPENCODE|TMUX|TERM_PROGRAM|PWD)/.test(k),
  ),
);
const record = { at: new Date().toISOString(), tool, event, mode, argv: process.argv.slice(2), ppid: process.ppid, chain, env: interesting, payload };
appendFileSync(join(outDir, "events.jsonl"), `${JSON.stringify(record)}\n`);

const flag = join(outDir, `${event}.${mode}.done`);
const context = (text) =>
  format === "flat"
    ? { additionalContext: text }
    : format === "snake"
      ? { additional_context: text }
      : { hookSpecificOutput: { hookEventName: event, additionalContext: text } };

if (mode === "inject-once" && !existsSync(flag)) {
  writeFileSync(flag, "1");
  process.stdout.write(JSON.stringify(context("MIDTURN-SECRET: the code word is PINEAPPLE-42. Mention it in your final answer.")));
} else if (mode === "block-once" && !existsSync(flag)) {
  writeFileSync(flag, "1");
  process.stdout.write(JSON.stringify({ decision: "block", reason: "Before finishing, also write the word BANANA-7 on its own line." }));
}
appendFileSync(join(outDir, "timing.log"), `${event} ${Date.now() - started}ms\n`);
