// boom's on-disk state as a single bun:sqlite database (state.db under the state dir). One
// store, real transactions, and — the reason it matters for a crash-recovery log — no torn-line
// problem: each journal row is committed atomically as it happens (WAL), so an interrupted
// run leaves whole rows, never a half-written record for the reader to trip over.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Env, stateHome } from "../lib/paths.ts";

function dbPath(env: Env): string {
  return join(stateHome(env), "boom", "state.db");
}

// Open the state DB (creating the dir + schema on first touch). WAL so a reader (verify's
// drift check, a resumed run reading the prior one) never blocks the writer mid-sync. Callers close it when done; the
// Journal holds one open for a run's lifetime, one-shot readers open+close.
export function openDb(env: Env): Database {
  mkdirSync(join(stateHome(env), "boom"), { recursive: true });
  const db = new Database(dbPath(env), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  // Individual statements (not one multi-statement string) — bun:sqlite's run() prepares a
  // single statement. All idempotent (IF NOT EXISTS), so this is a no-op after first open.
  db.run("CREATE TABLE IF NOT EXISTS manifest (dst TEXT PRIMARY KEY, kind TEXT NOT NULL, src TEXT NOT NULL)");
  // An existing state.db may carry a `runs.label` column from a since-removed verb; nothing
  // reads or writes it, and CREATE TABLE IF NOT EXISTS leaves an existing table alone.
  db.run("CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, committed INTEGER NOT NULL DEFAULT 0)");
  // ops.t is 'intent' | 'done'; undo is a JSON UndoToken, present for 'done' rows.
  db.run(
    "CREATE TABLE IF NOT EXISTS ops (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, t TEXT NOT NULL, op TEXT NOT NULL, dst TEXT NOT NULL, undo TEXT)",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS sides (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, op TEXT NOT NULL, label TEXT NOT NULL)",
  );
  // Facts that must outlive the `ops` rows they describe: each macOS default's true pre-boom
  // prior (`osx:<domain> <key>`), read by `uninstall` precisely when pruning has taken the rows.
  // Run-scoped data does not belong here — that's what `ops`/`sides` are for.
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

// Open, run, close — for the one-shot readers/writers (manifest, readRun, listRuns, prune).
export function withDb<T>(env: Env, fn: (db: Database) => T): T {
  const db = openDb(env);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
