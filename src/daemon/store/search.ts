import type { DatabaseSync } from "node:sqlite";
import { parseJson } from "../types.ts";

interface LooseAddr {
  member?: unknown;
  agent?: unknown;
  role?: unknown;
}
interface LoosePart {
  kind?: unknown;
  text?: unknown;
  file?: { name?: unknown };
}

/** What the full-text index holds for one message: its text, attachment names and addresses. */
export function searchDoc(
  fromAddr: string,
  envelopeJson: string,
  toAddrs: string[],
): { body: string; names: string; addrs: string } {
  const env = parseJson<{ parts?: LoosePart[]; from?: LooseAddr; to?: LooseAddr[] }>(
    envelopeJson,
    {},
  );
  const parts = Array.isArray(env.parts) ? env.parts : [];
  const str = (v: unknown) => (typeof v === "string" ? [v] : []);
  const addr = (a: LooseAddr | undefined) =>
    !a || typeof a.member !== "string" || a.role === "system"
      ? []
      : typeof a.agent === "string"
        ? [`${a.member}/${a.agent}`]
        : [`@${a.member}`];
  return {
    body: parts.flatMap((p) => (p?.kind === "text" ? str(p.text) : [])).join("\n\n"),
    names: parts.flatMap((p) => (p?.kind === "file" ? str(p.file?.name) : [])).join(" "),
    addrs: [
      ...new Set([
        fromAddr,
        ...toAddrs,
        ...addr(env.from),
        ...(Array.isArray(env.to) ? env.to.flatMap(addr) : []),
      ]),
    ].join(" "),
  };
}

/**
 * Creates the FTS5 index over messages (filling it from existing rows) if it is missing.
 * Returns false where SQLite has no FTS5; search then falls back to LIKE.
 */
export function ensureSearchIndex(db: DatabaseSync): boolean {
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages_fts'").get()) {
      db.prepare("SELECT 1 FROM messages_fts LIMIT 0").all();
      return true;
    }
    db.exec(
      "CREATE VIRTUAL TABLE messages_fts USING fts5(id UNINDEXED, body, names, addrs, tokenize = 'unicode61 remove_diacritics 2')",
    );
  } catch {
    return false;
  }
  const insert = db.prepare(
    "INSERT INTO messages_fts (id, body, names, addrs) VALUES (?, ?, ?, ?)",
  );
  const rows = db
    .prepare(
      "SELECT m.id, m.from_addr, m.envelope, (SELECT group_concat(to_addr, ' ') FROM deliveries d WHERE d.message_id = m.id) AS to_addrs FROM messages m",
    )
    .all() as { id: string; from_addr: string; envelope: string; to_addrs: string | null }[];
  for (const r of rows) {
    const doc = searchDoc(r.from_addr, r.envelope, r.to_addrs ? r.to_addrs.split(" ") : []);
    insert.run(r.id, doc.body, doc.names, doc.addrs);
  }
  return true;
}
