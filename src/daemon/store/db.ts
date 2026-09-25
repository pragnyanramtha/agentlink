import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";

export type Row = Record<string, SQLInputValue>;
export type Params = SQLInputValue[];

/** Thin synchronous wrapper around node:sqlite with migrations and transactions. */
export class Store {
  readonly db: DatabaseSync;
  #depth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  migrate(): number {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    let version = row?.version ?? 0;
    if (!row) this.db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
    while (version < MIGRATIONS.length) {
      const sql = MIGRATIONS[version] as string;
      this.tx(() => {
        this.db.exec(sql);
        this.db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
      });
      version += 1;
    }
    return version;
  }

  get<T = Row>(sql: string, ...params: Params): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Params): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: Params): { changes: number; lastInsertRowid: number } {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Runs fn in a transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.#depth += 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }

  getMeta(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
  }

  setMeta(key: string, value: string | undefined): void {
    if (value === undefined) this.run("DELETE FROM meta WHERE key = ?", key);
    else
      this.run(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        key,
        value,
      );
  }

  close(): void {
    this.db.close();
  }
}
