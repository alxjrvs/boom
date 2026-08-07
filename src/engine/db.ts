// boom's on-disk state as a single bun:sqlite database (state.db under the state dir),
// replacing the hand-parsed TSV manifest + per-run NDJSON journals. One store, real
// transactions, and — the reason it matters for a crash-recovery log — no torn-line
// problem: each journal row is committed atomically as it happens (WAL), so an interrupted
// run leaves whole rows, never a half-written record for the reader to trip over.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Env, stateHome } from "../lib/paths.ts";

function dbPath(env: Env): string {
  return join(stateHome(env), "boom", "state.db");
}

// Open the state DB (creating the dir + schema on first touch). WAL so a reader (rollback,
// verify's drift check) never blocks the writer mid-sync. Callers close it when done; the
// Journal holds one open for a run's lifetime, one-shot readers open+close.
export function openDb(env: Env): Database {
  mkdirSync(join(stateHome(env), "boom"), { recursive: true });
  const db = new Database(dbPath(env), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  // Individual statements (not one multi-statement string) — bun:sqlite's run() prepares a
  // single statement. All idempotent (IF NOT EXISTS), so this is a no-op after first open.
  db.run("CREATE TABLE IF NOT EXISTS manifest (dst TEXT PRIMARY KEY, kind TEXT NOT NULL, src TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, committed INTEGER NOT NULL DEFAULT 0)");
  // A `label` names a run as a checkpoint (`boom checkpoint <name>`): it survives pruning and is
  // a stable target for `boom rollback --to <name>`. Added by migration because CREATE TABLE IF
  // NOT EXISTS never alters an existing table — a state.db from before checkpoints has the old
  // shape, so add the column when it's missing (ALTER twice would throw on the duplicate).
  if (!columnExists(db, "runs", "label")) db.run("ALTER TABLE runs ADD COLUMN label TEXT");
  // ops.t is 'intent' | 'done'; undo is a JSON UndoToken, present for 'done' rows.
  db.run(
    "CREATE TABLE IF NOT EXISTS ops (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, t TEXT NOT NULL, op TEXT NOT NULL, dst TEXT NOT NULL, undo TEXT)",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS sides (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, op TEXT NOT NULL, label TEXT NOT NULL)",
  );
  // Facts about history that must outlive the rows they describe: how far pruning has destroyed
  // (`prune_horizon`) and each macOS default's true pre-boom prior (`osx:<domain> <key>`). Both
  // answer questions a caller asks precisely *because* the `ops` rows are gone, so they can't
  // live in `ops`. Run-scoped data does not belong here — that's what `ops`/`sides` are for.
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

// Does a table already have a column? Drives the idempotent ADD COLUMN migrations above —
// PRAGMA table_info returns one row per column, so a missing name means the migration must run.
function columnExists(db: Database, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
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
