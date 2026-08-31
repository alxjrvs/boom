// The sync transaction journal, backed by bun:sqlite (db.ts). Each mutation writes an
// `intent` then a `done` (with an undo token); a clean run marks the run `committed`.
// `--resume` skips destinations already done, and every row names where the original it
// displaced was put, so nothing an overwrite replaced is destroyed. Each row commits
// atomically (WAL), so an interrupted run leaves whole rows — no torn-line recovery hazard
// the old NDJSON log had.
import type { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { backupTo, pathExists } from "../lib/fs.ts";
import { backupsDir, type Env } from "../lib/paths.ts";
import { openDb, withDb } from "./db.ts";
import type { ReconcileCtx } from "./types.ts";

// How to reverse one mutation: remove what we created, rmdir a directory we created, restore a
// backed-up file, or — for the one non-file effect — re-apply a macOS default's prior value
// (`prior: null` means the key was unset, so `uninstall` deletes it). Timer plists are undone as
// ordinary file writes (the next reconcile re-settles their launchctl state), so they need no
// dedicated kind.
//
// `rmdir` exists because reversing a `mkdir` with `rm -rf` is the one undo that can destroy data
// boom never touched: by undo time the user may have filled the directory boom created.
// rmdir(2) refuses a non-empty directory, so the failure mode is a report, not a deletion.
export type UndoToken =
  | { kind: "remove" }
  | { kind: "rmdir" }
  | { kind: "restore"; from: string }
  | { kind: "osx"; domain: string; key: string; type: string; prior: string | null };

// Displace whatever currently sits at `dst` so a create can take its place, and return how
// to reverse it. With a backup root, move the existing file into the run's backup tree
// (recoverable); without one, remove it (the undo is just to delete what we create).
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

// Record the whole undo for a file about to be written: intent, displace whatever is there,
// then `done` — all BEFORE the write. It returns nothing on purpose. The old shape handed the
// token back and let the caller write `done` *after* the write "succeeded", which sounds
// careful and is the opposite: `displace` has already moved the prior file into the backup
// tree, so a crash between the two orphans it with no row pointing at it — unrecoverable,
// because the backup tree is only navigable through what the journal names. Undo-before-create is the invariant
// filesystem.ts:84-88 states verbatim; this is the one helper every other writer routes through.
//
// The no-journal guard lives HERE, not at the call sites: `displace` with an undefined
// backupRoot falls back to `rm(dst, { force: true })`, so a caller that skipped the guard on a
// verify or dry run would DELETE the destination. Inside the helper, "a documented no-op
// outside a mutating sync" is structurally true for every caller present and future.
// Where `displace` WILL put the file at `dst`, computed without touching the disk. Mirrors
// backupTo's `join(backupRoot, dst)` exactly — if that ever stops being a pure join, this must
// change with it, or an intent row will name a path the backup never lands at.
function plannedUndo(dst: string, backupRoot: string | undefined): UndoToken {
  return backupRoot ? { kind: "restore", from: join(backupRoot, dst) } : { kind: "remove" };
}

// `recursive` is passed through to `displace` for the callers whose conflicting destination
// may be a directory (a link/copy/mkdir landing where a real directory used to be). It mirrors
// journalRemove's parameter of the same name; without it those callers had to inline the
// sequence to reach `displace`'s third argument, which is how six of them ended up recording a
// null plan token.
export async function journalWrite(
  op: string,
  file: string,
  ctx: ReconcileCtx,
  recursive = false,
): Promise<void> {
  if (!ctx.journal) return;
  const exists = await pathExists(file);
  await ctx.journal.intent(op, file, exists ? plannedUndo(file, ctx.backupRoot) : { kind: "remove" });
  const undo: UndoToken = exists ? await displace(file, ctx.backupRoot, recursive) : { kind: "remove" };
  await ctx.journal.done(op, file, undo);
}

// The uninstall twin of journalWrite, and note the one structural difference: here the displace
// IS the mutation — nothing is written afterwards — so unlike journalWrite this must still take
// the file out of the way when no journal is open, or `uninstall` would silently stop removing
// anything. Same undo-before-mutation ordering, so a crash mid-teardown leaves every already-
// displaced original with a row that names it.
//
// Callers must gate on `!ctx.dryRun` themselves (a dry run reports and returns before reaching
// here), which is why this cannot borrow journalWrite's "guard lives in the helper" trick.
export async function journalRemove(
  op: string,
  file: string,
  ctx: ReconcileCtx,
  recursive = false,
): Promise<void> {
  if (!ctx.journal) {
    await rm(file, { recursive, force: true });
    return;
  }
  await ctx.journal.intent(op, file, plannedUndo(file, ctx.backupRoot));
  await ctx.journal.done(op, file, await displace(file, ctx.backupRoot, recursive));
}

interface DoneRecord {
  op: string;
  dst: string;
  undo: UndoToken;
}

// A non-reversible side effect (a `run` step or `hook`) — recorded so a reader of the run can
// see that undoing the file mutations does not undo everything the run did.
interface SideRecord {
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

  // `plan` is the undo token this mutation is ABOUT to become — written now, before the
  // displace, so the intent row is self-sufficient. Without it an intent recorded only "we
  // were about to touch this path": `displace` had already moved the original into the backup
  // tree, and a crash before `done` left that file with no row naming where it went, so the
  // run read back as clean with the original unrecoverable. The token is knowable in advance
  // because `backupTo`'s destination is a pure `join(backupRoot, dst)`.
  intent(op: string, dst: string, plan?: UndoToken): Promise<void> {
    this.db.run("INSERT INTO ops (run_id, t, op, dst, undo) VALUES (?, 'intent', ?, ?, ?)", [
      this.runId,
      op,
      dst,
      plan ? JSON.stringify(plan) : null,
    ]);
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
  // stays committed=0, which is exactly what a run listing reads as "interrupted /
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

// Keep the last `keep` runs; delete older runs (rows + their backup trees). Only the most
// recent run is ever read back (`--resume`), so unbounded history is pure accumulation. Runs
// are deleted oldest-first — run ids sort chronologically. Called after a clean commit.
export async function pruneRuns(env: Env, keep = 10): Promise<void> {
  const stale = withDb(env, (db) => {
    // A run carrying a `label` is exempt from the count bound entirely; nothing sets one today
    // (the column outlives the verb that wrote it — see db.ts), so in practice every run is
    // unlabelled and history is pruned oldest-first down to the kept window.
    const ids = (
      db.query("SELECT run_id FROM runs WHERE label IS NULL ORDER BY run_id").all() as { run_id: string }[]
    ).map((r) => r.run_id);
    // Pure count-bound (drop oldest beyond `keep`), committed or not — this bounds growth
    // even when a run fails every sync. The most-recent run (the only one `--resume` ever
    // reaches) is always inside the kept window, so its backups are never reaped out from
    // under it; older interrupted runs are superseded history.
    const drop = ids.slice(0, Math.max(0, ids.length - keep));
    const delRun = db.query("DELETE FROM runs WHERE run_id = ?");
    const delOps = db.query("DELETE FROM ops WHERE run_id = ?");
    const delSides = db.query("DELETE FROM sides WHERE run_id = ?");
    for (const id of drop) {
      delOps.run(id);
      delSides.run(id);
      delRun.run(id);
    }
    // Record how far history was destroyed, in the same callback that destroys it: deleting the
    // rows erases the only evidence they ever existed. No command reads `prune_horizon` today,
    // but it is the sole record that a run id older than it was pruned rather than never run,
    // and it costs one row. The conditional upsert keeps the horizon monotonic (run ids sort
    // chronologically), so a later prune of *older* rows can never walk it backwards.
    const newest = drop.at(-1);
    if (newest !== undefined)
      db.run(
        "INSERT INTO meta (key, value) VALUES ('prune_horizon', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE excluded.value > meta.value",
        [newest],
      );
    return drop;
  });
  for (const id of stale) await rm(`${backupsDir(env)}/${id}`, { recursive: true, force: true });
}

// The `meta` key under which a macOS default's true pre-boom prior is stashed. The composite
// `"<domain> <key>"` mirrors the `disp` string osx.ts journals as `ops.dst`, so both lookups
// key the same way — change that display format and BOTH break together, not silently apart.
const osxPriorKey = (domain: string, key: string): string => `osx:${domain} ${key}`;

// Stash the pre-boom prior for a macOS default, once and only once. Insert-if-absent is the
// whole point: the second time boom rewrites the same key, `undo.prior` is boom's OWN previous
// value, and overwriting the stash with it would make uninstall "restore" a value the user
// never set. Unlike an `ops` row this survives pruning, which is what makes uninstall correct
// on a machine that has synced more than `keep` times since the key was first written.
export async function stashOsxPrior(env: Env, undo: Extract<UndoToken, { kind: "osx" }>): Promise<void> {
  withDb(env, (db) =>
    db.run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", [
      osxPriorKey(undo.domain, undo.key),
      JSON.stringify(undo),
    ]),
  );
}

// What the machine had for `<domain> <key>` before boom ever wrote it, for `boom uninstall`.
// The durable `meta` stash answers first; the `ops` scan is the fallback for keys first written
// by a boom older than the stash. That fallback takes the EARLIEST row (`ops.id` is a global
// AUTOINCREMENT, so `ORDER BY id` is chronological across runs) — the latest row's `prior` is
// merely boom's own previous value. Both can legitimately come back empty (pruning kept 10
// runs and the stash postdates the write), and the caller must skip rather than guess.
export async function firstOsxUndo(
  env: Env,
  domain: string,
  key: string,
): Promise<Extract<UndoToken, { kind: "osx" }> | undefined> {
  return withDb(env, (db) => {
    const stashed = db.query("SELECT value FROM meta WHERE key = ?").get(osxPriorKey(domain, key)) as
      | { value: string }
      | undefined;
    if (stashed) return JSON.parse(stashed.value) as Extract<UndoToken, { kind: "osx" }>;
    const row = db
      .query("SELECT undo FROM ops WHERE t = 'done' AND op = 'osx' AND dst = ? ORDER BY id LIMIT 1")
      .get(`${domain} ${key}`) as { undo: string } | undefined;
    if (!row) return undefined;
    const undo = JSON.parse(row.undo) as UndoToken;
    return undo.kind === "osx" ? undo : undefined;
  });
}

// Read a run's `done` + `side` records (the most recent run if `runId` is omitted). done
// rows come back in insertion order (ORDER BY id), so a reader replaying them in reverse is correct.
export async function readRun(
  env: Env,
  runId?: string,
): Promise<
  | { runId: string; committed: boolean; done: DoneRecord[]; orphans: DoneRecord[]; sides: SideRecord[] }
  | undefined
> {
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
    // Intents with no matching `done` — the run died in the window between "original displaced
    // into the backup tree" and "row written that says where it went". These used to be
    // invisible (every reader filtered `t = 'done'`), so an interrupted run reported zero ops
    // and the displaced original was silently unaccounted for.
    //
    // The completing `done` must come AFTER the intent (`d.id > i.id`), not merely share its
    // (op, dst). Without that, a destination touched twice in one run has its second, genuinely
    // orphaned intent masked by the FIRST write's done row — the interrupted mutation then goes
    // unreported again, which is the whole bug this exists to fix. Rare (the change-gate makes
    // reconcile idempotent, and `--resume` re-skips what is already correct) but reachable: a
    // hook may call `api.journalWrite` on a path a resource already wrote.
    const orphans = (
      db
        .query(
          `SELECT op, dst, undo FROM ops i WHERE run_id = ? AND t = 'intent' AND undo IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ops d WHERE d.run_id = i.run_id AND d.t = 'done'
                             AND d.op = i.op AND d.dst = i.dst AND d.id > i.id)
           ORDER BY id`,
        )
        .all(id) as { op: string; dst: string; undo: string }[]
    ).map((r) => ({ op: r.op, dst: r.dst, undo: JSON.parse(r.undo) as UndoToken }));
    const sides = db
      .query("SELECT op, label FROM sides WHERE run_id = ? ORDER BY id")
      .all(id) as SideRecord[];
    return { runId: id, committed: runRow.committed === 1, done, orphans, sides };
  });
}

// One-line summary of a recorded run: how many reversible ops it holds, how many
// non-reversible side effects, and whether it reached a clean committed state (an
// uncommitted run was interrupted mid-sync).
interface RunSummary {
  readonly runId: string;
  readonly ops: number;
  readonly sides: number;
  readonly committed: boolean;
  readonly label?: string; // the `runs.label` column, when a run carries one
}

// Enumerate the retained runs, newest first (run ids sort chronologically).
export async function listRuns(env: Env): Promise<RunSummary[]> {
  return withDb(env, (db) => {
    const runs = db.query("SELECT run_id, committed, label FROM runs ORDER BY run_id DESC").all() as {
      run_id: string;
      committed: number;
      label: string | null;
    }[];
    // `done` rows plus recoverable orphaned intents. Counting only `done` made an interrupted
    // run — the one case a run listing exists to surface — report "0 op(s)", which reads as
    // "nothing to undo" precisely when there is something half-applied to undo.
    const opsN = db.query(
      `SELECT (SELECT COUNT(*) FROM ops WHERE run_id = ?1 AND t = 'done')
            + (SELECT COUNT(*) FROM ops i WHERE i.run_id = ?1 AND i.t = 'intent' AND i.undo IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM ops d WHERE d.run_id = i.run_id AND d.t = 'done'
                                 AND d.op = i.op AND d.dst = i.dst AND d.id > i.id)) AS n`,
    );
    const sidesN = db.query("SELECT COUNT(*) AS n FROM sides WHERE run_id = ?");
    return runs.map((r) => ({
      runId: r.run_id,
      ops: (opsN.get(r.run_id) as { n: number }).n,
      sides: (sidesN.get(r.run_id) as { n: number }).n,
      committed: r.committed === 1,
      ...(r.label ? { label: r.label } : {}),
    }));
  });
}

function latestRunId(db: Database): string | undefined {
  const row = db.query("SELECT run_id FROM runs ORDER BY run_id DESC LIMIT 1").get() as
    | { run_id: string }
    | undefined;
  return row?.run_id;
}
