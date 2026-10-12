import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";

export type Row = Record<string, SQLInputValue>;
export type Params = SQLInputValue[];

const STATEMENT_CACHE = 256;

/** Thin synchronous wrapper around node:sqlite with migrations and transactions. */
export class Store {
  readonly db: DatabaseSync;
  #depth = 0;
  readonly #stmts = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    // No fsync per commit (each hook commits; on some disks that takes 100s of ms). With WAL this
    // stays consistent after a crash; a power loss can drop the last few commits.
    this.db.exec("PRAGMA synchronous = NORMAL");
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
      this.#stmts.clear();
    }
    return version;
  }

  /** Prepared statements by SQL text, least recently used first (preparing each query cost CPU and memory). */
  #prepare(sql: string): StatementSync {
    let stmt = this.#stmts.get(sql);
    if (stmt) this.#stmts.delete(sql);
    else {
      stmt = this.db.prepare(sql);
      if (this.#stmts.size >= STATEMENT_CACHE)
        this.#stmts.delete(this.#stmts.keys().next().value as string);
    }
    this.#stmts.set(sql, stmt);
    return stmt;
  }

  get<T = Row>(sql: string, ...params: Params): T | undefined {
    return this.#prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Params): T[] {
    return this.#prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: Params): { changes: number; lastInsertRowid: number } {
    // Cached statements keep the columns they were prepared with ("SELECT *"): a schema change drops them.
    const ddl = /^\s*(ALTER|CREATE|DROP)\b/i.test(sql);
    const r = (ddl ? this.db.prepare(sql) : this.#prepare(sql)).run(...params);
    if (ddl) this.#stmts.clear();
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
    this.#stmts.clear();
    this.db.close();
  }
}
