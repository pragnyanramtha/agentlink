import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { invalid } from "../../core/errors.ts";

/** One file edit. `after: null` deletes the file. */
export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
  mode?: number;
  /** Create a symlink instead of writing content (`after` holds the target). */
  symlink?: boolean;
}

export interface Step {
  /** argv for an external command, e.g. ["claude", "mcp", "add", …]. */
  cmd: string[];
  why: string;
}

export interface Plan {
  tool: string;
  changes: FileChange[];
  steps: Step[];
  notes: string[];
  skipped?: string;
}

export const MARK_START = "<!-- agentlink:start -->";
export const MARK_END = "<!-- agentlink:end -->";

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export type JsonObject = Record<string, unknown>;

/** Parses a JSON config; refuses to rewrite files it cannot round-trip (e.g. JSONC comments). */
export function parseJsonConfig(path: string, text: string | null): JsonObject {
  if (text === null || !text.trim()) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("top level is not an object");
    }
    return value as JsonObject;
  } catch (error) {
    throw invalid(
      `cannot safely edit ${path}: ${(error as Error).message}. Fix the file or add agentlink manually (agentlink install --dry-run shows the snippet).`,
    );
  }
}

export const toJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function shq(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Inserts or replaces the agentlink block in a markdown file's text. */
export function upsertBlock(text: string | null, block: string): string {
  const body = `${MARK_START}\n${block.trim()}\n${MARK_END}`;
  const current = text ?? "";
  const start = current.indexOf(MARK_START);
  const end = current.indexOf(MARK_END);
  if (start >= 0 && end > start) {
    return `${current.slice(0, start)}${body}${current.slice(end + MARK_END.length)}`;
  }
  const sep =
    current.length === 0
      ? ""
      : current.endsWith("\n\n")
        ? ""
        : current.endsWith("\n")
          ? "\n"
          : "\n\n";
  return `${current}${sep}${body}\n`;
}

export function removeBlock(text: string | null): string | null {
  if (text === null) return null;
  const start = text.indexOf(MARK_START);
  const end = text.indexOf(MARK_END);
  if (start < 0 || end < start) return text;
  const before = text.slice(0, start).replace(/\n+$/, "\n");
  const after = text.slice(end + MARK_END.length).replace(/^\n+/, "");
  const joined = `${before}${after}`;
  return joined.trim() ? joined : "";
}

/** True for hook commands this tool installed (any shim location). */
export function isAgentlinkCommand(command: unknown): boolean {
  return typeof command === "string" && /agentlink['"]?\s+hook\s/.test(command);
}

/** Line diff (LCS) rendered as -/+ lines with a little context. */
export function renderDiff(
  path: string,
  before: string | null,
  after: string | null,
  context = 2,
): string {
  const a = before === null ? [] : before.split("\n");
  const b = after === null ? [] : after.split("\n");
  if (a.length * b.length > 4_000_000) {
    return `--- ${path}\n+++ ${path}\n(${a.length} → ${b.length} lines; too large to diff)`;
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    const row = dp[i] as number[];
    const next = dp[i + 1] as number[];
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: { t: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] as string });
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || (dp[i]?.[j + 1] ?? 0) >= (dp[i + 1]?.[j] ?? 0))) {
      ops.push({ t: "+", line: b[j] as string });
      j++;
    } else {
      ops.push({ t: "-", line: a[i] as string });
      i++;
    }
  }
  const keep = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.t !== " ") for (let k = idx - context; k <= idx + context; k++) keep.add(k);
  });
  const out = [
    `--- ${before === null ? "(new file)" : path}`,
    `+++ ${after === null ? "(deleted)" : path}`,
  ];
  let last = -2;
  ops.forEach((op, idx) => {
    if (!keep.has(idx)) return;
    if (idx !== last + 1) out.push("@@");
    out.push(`${op.t}${op.line}`);
    last = idx;
  });
  return out.join("\n");
}

/** Applies file changes, backing up every existing file under `backupDir` first. */
export function applyChanges(changes: FileChange[], backupDir: string, home: string): string[] {
  const done: string[] = [];
  for (const change of changes) {
    if (change.symlink) {
      if (change.after === null) {
        if (isSymlinkTo(change.path, change.before)) rmSync(change.path, { force: true });
      } else {
        mkdirSync(dirname(change.path), { recursive: true });
        rmSync(change.path, { force: true });
        symlinkSync(change.after, change.path);
      }
      done.push(change.path);
      continue;
    }
    if (change.before === change.after) continue;
    if (existsSync(change.path)) {
      const rel = relative(home, change.path);
      const backup = join(backupDir, rel.startsWith("..") ? change.path.replace(/^\//, "") : rel);
      mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
      copyFileSync(change.path, backup);
    }
    if (change.after === null) {
      rmSync(change.path, { force: true });
    } else {
      mkdirSync(dirname(change.path), { recursive: true });
      const tmp = `${change.path}.agentlink-tmp`;
      writeFileSync(tmp, change.after, { mode: change.mode ?? 0o644 });
      renameSync(tmp, change.path);
    }
    done.push(change.path);
  }
  return done;
}

export function isSymlinkTo(path: string, target: string | null): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && (target === null || readlinkSync(path) === target);
  } catch {
    return false;
  }
}
