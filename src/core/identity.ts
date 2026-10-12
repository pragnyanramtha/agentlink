import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";
import { slugify } from "./addr.ts";
import { safeField } from "./sanitize.ts";

// Model, session title and project are claims (hooks, presence): display and address hints only.
export const LIMITS = { model: 60, title: 80, project: 64 } as const;

/** What a person needs to tell agents apart. Everything but name and harness is optional. */
export interface Identity {
  name: string;
  /** Human label of the CLI, e.g. "Claude Code". */
  harness: string;
  model?: string | null;
  /** Working directory (home as ~) for local agents, project name for teammates' agents. */
  dir?: string | null;
  branch?: string | null;
  title?: string | null;
  host?: string | null;
}

const FAMILY = /^(opus|sonnet|haiku)$/;

/** `claude-opus-4-5-20251101` → `opus-4.5`, `anthropic/claude-sonnet-4-5` → `sonnet-4.5`. */
export function modelShort(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.slice(m.lastIndexOf("/") + 1);
  m = m
    .replace(/^(?:[a-z]{2,4}\.)?anthropic\./, "")
    .replace(/(?:-v\d+)?(?::\d+)?$/, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/[-@]\d{8}$/, "");
  const ver = (major: string, minor?: string) => (minor ? `${major}.${minor}` : major);
  const a = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(m);
  if (a) return `${a[1]}-${ver(a[2] as string, a[3])}`;
  const b = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-|$)/.exec(m);
  if (b) return `${b[3]}-${ver(b[1] as string, b[2])}`;
  return m.slice(0, 40);
}

/** `opus`, `gpt-5`, `o3`, `gemini`, … (undefined when it can't tell). */
export function modelFamily(model: string): string | undefined {
  const s = modelShort(model);
  const head = s.split("-")[0] ?? "";
  if (FAMILY.test(head)) return head;
  const gpt = /^gpt-(\d+)/.exec(s);
  if (gpt) return `gpt-${gpt[1]}`;
  const word = /^[a-z]+\d*/.exec(s)?.[0];
  return word && (word.length >= 3 || /^o\d$/.test(word)) ? word : undefined;
}

/** The model an agent CLI was started with (`--model X`, `--model=X`, `-m X`). */
export function modelFromArgv(argv: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--model=")) return arg.slice(8) || undefined;
    if (arg === "--model" || arg === "-m") {
      const v = argv[i + 1];
      return v && !v.startsWith("-") ? v : undefined;
    }
  }
  return undefined;
}

/** The git remote's repo name, else the repo root's folder, else the working directory's. */
export function projectName(repo: { remote?: string; root?: string }, cwd?: string): string {
  const fromRemote = repo.remote?.split("/").filter(Boolean).pop();
  return fromRemote || basename(repo.root ?? "") || basename(cwd ?? "") || "agent";
}

export function homeShort(path: string, home = homedir()): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Short tag for one session on one machine: stable across resumes, new for another session. */
export function sessionTag(host: string, tool: string, session: string): string {
  return createHash("sha256").update(`${host}\0${tool}\0${session}`).digest("hex").slice(0, 4);
}

const field = (v: string | null | undefined, max: number) => (v ? safeField(v, max) : null);

function parts(i: Identity, quote: string): string[] {
  const dir = field(i.dir, 200);
  const branch = field(i.branch, 60);
  const title = field(i.title, LIMITS.title)?.replaceAll('"', "'");
  return [
    field(i.harness, 32) ?? "",
    i.model ? modelShort(field(i.model, LIMITS.model) ?? "") : "",
    dir ? `${dir}${branch ? ` (${branch})` : ""}` : branch ? `(${branch})` : "",
    title ? `${quote}${title}${quote}` : "",
  ].filter(Boolean);
}

/** `claude-api · Claude Code · opus-4.5 · ~/work/api (feat-login) · "fix login bug" · laptop` */
export function identityLine(i: Identity): string {
  const host = field(i.host, 64);
  return [field(i.name, 120) ?? "?", ...parts(i, '"'), ...(host ? [host] : [])].join(" · ");
}

/** For provenance lines: `claude-api (Claude Code · opus-4.5 · ~/work/api · 'fix login' · on laptop)`. */
export function fromLabelOf(i: Identity): string {
  const host = field(i.host, 64);
  const bits = [
    ...parts({ ...i, title: field(i.title, 40) }, "'"),
    ...(host ? [`on ${host}`] : []),
  ];
  return `${field(i.name, 120) ?? "?"} (${bits.join(" · ") || "agent"})`;
}

export interface FacetSource {
  tool: string;
  model?: string | null;
  project?: string | null;
  branch?: string | null;
  host?: string | null;
  title?: string | null;
}

/**
 * Words an agent can be addressed by when no name matches: harness, project, branch, model
 * (family and versions), host and, only when asked, title words.
 */
export function facetsOf(s: FacetSource, opts: { withTitle?: boolean } = {}): Set<string> {
  const out = new Set<string>([slugify(s.tool, 16)]);
  if (s.project) out.add(slugify(s.project, 64));
  if (s.branch) out.add(slugify(s.branch, 64));
  if (s.host) {
    out.add(slugify(s.host, 64));
    out.add(slugify(s.host.split(".")[0] ?? "", 64));
  }
  if (s.model) {
    const short = modelShort(s.model);
    const family = modelFamily(s.model);
    if (family) out.add(family);
    const segs = short.split("-");
    for (let i = 1; i <= segs.length; i++) out.add(segs.slice(0, i).join("-"));
    const major = /^([a-z]+-\d+)\.\d+/.exec(short)?.[1];
    if (major) out.add(major);
  }
  if (opts.withTitle && s.title)
    for (const w of s.title.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3) out.add(w);
  for (const f of out) if (!/[a-z]/.test(f) || f.length < 2 || f === "x") out.delete(f);
  return out;
}

/** Whether `query`, split at '-' or '.', is a sequence of facets ("opus", "claude-api", "gpt-5-web"). */
export function coversQuery(query: string, facets: Set<string>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const seps = [...q.matchAll(/[-.]/g)].map((m) => m.index as number);
  const starts = [0, ...seps.map((i) => i + 1)];
  const ends = [...seps, q.length];
  const reach = starts.map((_, i) => i === 0);
  reach.push(false);
  for (let s = 0; s < starts.length; s++) {
    if (!reach[s]) continue;
    for (let e = s; e < ends.length; e++)
      if (facets.has(q.slice(starts[s], ends[e]))) reach[e + 1] = true;
  }
  return reach[starts.length] === true;
}
