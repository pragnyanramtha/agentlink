import { describe, expect, it } from "vitest";
import { Store } from "../../src/daemon/store/db.ts";

describe("Store statement cache", () => {
  it("reuses statements and still sees schema changes and many distinct queries", () => {
    const store = new Store(":memory:");
    store.run("CREATE TABLE t (a INTEGER)");
    store.run("INSERT INTO t (a) VALUES (?)", 1);
    expect(store.all("SELECT * FROM t")).toEqual([{ a: 1 }]);
    store.run("ALTER TABLE t ADD COLUMN b TEXT");
    store.run("INSERT INTO t (a) VALUES (?)", 2);
    expect(store.all("SELECT * FROM t")).toEqual([
      { a: 1, b: null },
      { a: 2, b: null },
    ]);
    // more distinct queries than the cache holds (IN lists of every length)
    for (let n = 1; n <= 600; n++) {
      const marks = Array.from({ length: n }, () => "?").join(",");
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      expect(
        store.get<{ c: number }>(`SELECT COUNT(*) AS c FROM t WHERE a IN (${marks})`, ...ids)?.c,
      ).toBe(Math.min(n, 2));
    }
    expect(store.get<{ a: number }>("SELECT a FROM t WHERE a = ?", 2)?.a).toBe(2);
    store.close();
  });
});
