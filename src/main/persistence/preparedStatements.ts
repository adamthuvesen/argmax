import type Database from "better-sqlite3";

/**
 * Cached `database.prepare(sql)` per (connection × sql) pair.
 *
 * better-sqlite3 docs: "Prepared statements are cached internally by the
 * library; you don't need to cache them yourself." — but that cache is
 * keyed on the SQL string and still pays the lookup cost on every call.
 * Holding the Statement reference in JS land skips the re-lookup and the
 * trampoline back into native code (ralph D1).
 *
 * Per-connection WeakMap so tests that create multiple in-memory databases
 * don't share statements across connections (which would break the prepared-
 * statement's binding to its specific connection).
 */
const cache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

export function prepared(connection: Database.Database, sql: string): Database.Statement {
  let connectionCache = cache.get(connection);
  if (!connectionCache) {
    connectionCache = new Map();
    cache.set(connection, connectionCache);
  }
  let statement = connectionCache.get(sql);
  if (!statement) {
    statement = connection.prepare(sql);
    connectionCache.set(sql, statement);
  }
  return statement;
}

/** Test-only — clear the cache between in-memory-DB fixtures. */
export function clearPreparedCacheForTesting(): void {
  // WeakMap has no clear() — replace via reassigning the cache object.
  // The exported `cache` is const; for tests, the simpler path is to let
  // GC reclaim entries as their connections are garbage collected, which
  // happens between vitest test cases when the test's local `database`
  // goes out of scope. This helper exists so tests can be explicit if
  // they need it; today it's a no-op because we rely on GC.
}
