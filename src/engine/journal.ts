// The sync transaction journal, backed by bun:sqlite (db.ts). Each mutation writes an
// `intent` then a `done` (with an undo token); a clean run marks the run `committed`.
// rollback replays `done` rows in reverse; --resume skips destinations already done. Each
// row commits atomically (WAL), so an interrupted run leaves whole rows — no torn-line
// recovery hazard the old NDJSON log had.
import type { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { backupTo } from "../lib/fs.ts";
import { openDb, withDb } from "./db.ts";
import { backupsDir, type Env } from "./state.ts";

// How to reverse one mutation: remove what we created, restore a backed-up file, or — for the
// one non-file effect — re-apply a macOS default's prior value (`prior: null` means the key
// was unset, so rollback deletes it). Timer plists roll back as ordinary file writes (the
// next reconcile re-settles their launchctl state), so they need no dedicated kind.
export type UndoToken =
  | { kind: "remove" }
  | { kind: "restore"; from: string }
  | { kind: "osx"; domain: string; key: string; type: string; prior: string | null };

// Displace whatever currently sits at `dst` so a create can take its place, and return how
// to reverse it. With a backup root, move the existing file into the run's backup tree
// (rollback restores it); without one, remove it (rollback just deletes what we create).
// This is the transaction's most safety-critical branch — one copy here instead of the four
// subtly-different hand-inlined versions it replaced across reconcile.ts + filesystem.ts.
// Assumes `dst` exists (every mutating caller has already confirmed a conflict); `recursive`
// covers a dst that may be a directory (a link/copy target that was a whole dir).
export async function displace(
  dst: string,
  backupRoot: string | undefined,
  recursive = false,
): Promise<UndoToken> {
  if (backupRoot) return { kind: "restore", from: await backupTo(dst, backupRoot) };
  await rm(dst, { recursive, force: true });
  return { kind: "remove" };
}

export interface DoneRecord {
  op: string;
  dst: string;
  undo: UndoToken;
}

// A non-reversible side effect (a `run` step or `hook`) — recorded so rollback can warn the
// operator that replaying the run cannot undo it.
export interface SideRecord {
  op: string;
  label: string;
}

// Per-process monotonic tie-breaker. The ISO timestamp only resolves to the millisecond,
// so two runs in one process within the same millisecond (back-to-back syncs — common in
// tests, possible in a script) would otherwise collide on runId. Zero-padded so it also
// sorts chronologically.
let runSeq = 0;

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${process.pid}-${String(runSeq++).padStart(4, "0")}`;
}

export class Journal {
  private readonly db: Database;
  private closed = false;
  readonly runId: string;

  constructor(env: Env, runId: string) {
    this.runId = runId;
    this.db = openDb(env);
    this.db.run("INSERT OR IGNORE INTO runs (run_id, committed) VALUES (?, 0)", [runId]);
  }

  intent(op: string, dst: string): Promise<void> {
    this.db.run("INSERT INTO ops (run_id, t, op, dst) VALUES (?, 'intent', ?, ?)", [this.runId, op, dst]);
    return Promise.resolve();
  }
  done(op: string, dst: string, undo: UndoToken): Promise<void> {
    this.db.run("INSERT INTO ops (run_id, t, op, dst, undo) VALUES (?, 'done', ?, ?, ?)", [
      this.runId,
      op,
      dst,
      JSON.stringify(undo),
    ]);
    return Promise.resolve();
  }
  side(op: string, label: string): Promise<void> {
    this.db.run("INSERT INTO sides (run_id, op, label) VALUES (?, ?, ?)", [this.runId, op, label]);
    return Promise.resolve();
  }
  // Mark the run cleanly committed. Split from close() so the caller only sets this when the
  // run actually succeeded (zero failures) — a run that reached the end with failed items
  // stays committed=0, which is exactly what `rollback --list` reads as "interrupted /
  // needs attention" (a half-applied run being labelled clean was the old trap).
  markCommitted(): void {
    this.db.run("UPDATE runs SET committed = 1 WHERE run_id = ?", [this.runId]);
  }
  // Release the DB handle. Idempotent, and separate from markCommitted() so reconcile can
  // always close in a finally — an early return (e.g. a malformed overlay) no longer leaks
  // the open WAL connection for the process lifetime.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

// Keep the last `keep` runs; delete older runs (rows + their backup trees). Rollback only
// ever reads the most recent run, so unbounded history is pure accumulation. Runs are
// deleted oldest-first — run ids sort chronologically. Called after a clean commit.
export async function pruneRuns(env: Env, keep = 10): Promise<void> {
  const stale = withDb(env, (db) => {
    const ids = (db.query("SELECT run_id FROM runs ORDER BY run_id").all() as { run_id: string }[]).map(
      (r) => r.run_id,
    );
    // Pure count-bound (drop oldest beyond `keep`), committed or not — this bounds growth
    // even when a run fails every sync. The most-recent run (the only one `--resume` or an
    // untargeted `rollback` ever reaches) is always inside the kept window, so its backups
    // are never reaped out from under it; older interrupted runs are superseded history.
    const drop = ids.slice(0, Math.max(0, ids.length - keep));
    const delRun = db.query("DELETE FROM runs WHERE run_id = ?");
    const delOps = db.query("DELETE FROM ops WHERE run_id = ?");
    const delSides = db.query("DELETE FROM sides WHERE run_id = ?");
    for (const id of drop) {
      delOps.run(id);
      delSides.run(id);
      delRun.run(id);
    }
    return drop;
  });
  for (const id of stale) await rm(`${backupsDir(env)}/${id}`, { recursive: true, force: true });
}

// Read a run's `done` + `side` records (the most recent run if `runId` is omitted). done
// rows come back in insertion order (ORDER BY id), so rollback's reverse replay is correct.
export async function readRun(
  env: Env,
  runId?: string,
): Promise<{ runId: string; committed: boolean; done: DoneRecord[]; sides: SideRecord[] } | undefined> {
  return withDb(env, (db) => {
    const id = runId ?? latestRunId(db);
    if (!id) return undefined;
    const runRow = db.query("SELECT committed FROM runs WHERE run_id = ?").get(id) as
      | { committed: number }
      | undefined;
    if (!runRow) return undefined;
    const done = (
      db.query("SELECT op, dst, undo FROM ops WHERE run_id = ? AND t = 'done' ORDER BY id").all(id) as {
        op: string;
        dst: string;
        undo: string;
      }[]
    ).map((r) => ({ op: r.op, dst: r.dst, undo: JSON.parse(r.undo) as UndoToken }));
    const sides = db
      .query("SELECT op, label FROM sides WHERE run_id = ? ORDER BY id")
      .all(id) as SideRecord[];
    return { runId: id, committed: runRow.committed === 1, done, sides };
  });
}

// One-line summary of a recorded run, for `boom rollback --list`: how many reversible ops
// it holds, how many non-reversible side effects, and whether it reached a clean committed
// state (an uncommitted run was interrupted mid-sync).
export interface RunSummary {
  readonly runId: string;
  readonly ops: number;
  readonly sides: number;
  readonly committed: boolean;
}

// Enumerate the retained runs, newest first (run ids sort chronologically).
export async function listRuns(env: Env): Promise<RunSummary[]> {
  return withDb(env, (db) => {
    const runs = db.query("SELECT run_id, committed FROM runs ORDER BY run_id DESC").all() as {
      run_id: string;
      committed: number;
    }[];
    const opsN = db.query("SELECT COUNT(*) AS n FROM ops WHERE run_id = ? AND t = 'done'");
    const sidesN = db.query("SELECT COUNT(*) AS n FROM sides WHERE run_id = ?");
    return runs.map((r) => ({
      runId: r.run_id,
      ops: (opsN.get(r.run_id) as { n: number }).n,
      sides: (sidesN.get(r.run_id) as { n: number }).n,
      committed: r.committed === 1,
    }));
  });
}

function latestRunId(db: Database): string | undefined {
  const row = db.query("SELECT run_id FROM runs ORDER BY run_id DESC LIMIT 1").get() as
    | { run_id: string }
    | undefined;
  return row?.run_id;
}
