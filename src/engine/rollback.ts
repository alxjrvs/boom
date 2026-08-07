// Roll back a previous sync by replaying its journal's `done` records in reverse:
// remove what boom created, restore what an overwrite displaced.
import { rm, rmdir } from "node:fs/promises";
import { detectOs } from "../config/profile.ts";
import type { BoomContext } from "../context.ts";
import { displayPath, restoreFrom } from "../lib/fs.ts";
import { captureArgv, cleanEnv } from "../lib/proc.ts";
import { bandsReporter, type Reporter } from "../lib/reporter.ts";
import { findRunByLabel, listRuns, pruneHorizon, readRun, setRunLabel, type UndoToken } from "./journal.ts";
import { removeManifestEntries } from "./state.ts";

// One-line preview of what reversing a record would do (for --dry-run). An exhaustive switch
// with a `never` default, not an if/else chain: adding a fifth UndoToken kind must be a compile
// error here, because the old chain's fall-through silently previewed it as "would restore".
function undoPreview(undo: UndoToken, disp: string): string {
  switch (undo.kind) {
    case "remove":
      return `would remove ${disp}`;
    case "rmdir":
      return `would remove ${disp} (only if still empty)`;
    case "osx":
      return `would ${undo.prior === null ? "delete" : "restore"} default ${disp}`;
    case "restore":
      return `would restore ${disp}`;
    default: {
      const _never: never = undo;
      return _never;
    }
  }
}

// Re-apply a macOS default's prior value (or delete a key boom introduced). Non-darwin is a
// reported no-op — the journal could have been carried to another host. Returns whether the
// prior was actually re-applied: the caller must not mark a record reversed on the strength
// of a spawn nobody checked.
function restoreOsx(undo: Extract<UndoToken, { kind: "osx" }>, ctx: BoomContext, report: Reporter): boolean {
  if (detectOs(ctx.env) !== "darwin") {
    report.warn(`skipped osx restore ${undo.domain} ${undo.key} (not darwin)`);
    return false;
  }
  const env = cleanEnv(ctx.env);
  const argv =
    undo.prior === null
      ? ["defaults", "delete", undo.domain, undo.key]
      : ["defaults", "write", undo.domain, undo.key, `-${undo.type}`, undo.prior];
  // Every other spawn in the engine reads its exit code; an unchecked one here turns a failed
  // restore into a green rollback — the worst lie this command can tell, since the operator
  // walks away believing the machine is back to a known state.
  const r = Bun.spawnSync(argv, { env, stdout: "ignore", stderr: "ignore" });
  if (r.exitCode !== 0) {
    // …but `defaults delete` exits 1 when the key (or its whole domain) is already absent, so
    // the exit code alone can't tell "couldn't delete it" from "there was nothing to delete".
    // Ask, and treat absent as reversed — the same call undoMkdir's ENOENT arm makes, for the
    // same reason: rolling one run back twice, or a user who tidied the key away first, must
    // not flip a previously-clean `boom rollback` to exit 1.
    if (undo.prior === null && captureArgv(["defaults", "read", undo.domain, undo.key], ctx.env).code !== 0) {
      report.ok(`default ${undo.domain} ${undo.key} already gone`);
      return true;
    }
    report.fail(
      `${undo.prior === null ? "delete" : "restore"} of default ${undo.domain} ${undo.key} failed (defaults exit ${r.exitCode})`,
    );
    return false;
  }
  report.ok(`${undo.prior === null ? "deleted" : "restored"} default ${undo.domain} ${undo.key}`);
  return true;
}

// `boom rollback --list` — enumerate the retained runs so the ids `--run-id` accepts are
// discoverable, instead of forcing a hand `ls` of the state dir. Exit 0 always; it reads.
export async function listRollbacks(ctx: BoomContext): Promise<number> {
  const report = bandsReporter(ctx.process, ctx.env, "rollback", { setup: "READING THE JOURNAL…" });
  report.header("Rollback history");
  const runs = await listRuns(ctx.env);
  if (runs.length === 0) {
    report.note("no runs recorded yet");
  } else {
    for (const r of runs) {
      const side = r.sides > 0 ? `, ${r.sides} side-effect(s)` : "";
      const state = r.committed ? "" : "  (interrupted — never committed)";
      const tag = r.label ? `  [checkpoint: ${r.label}]` : "";
      report.ok(`${r.runId}  —  ${r.ops} op(s)${side}${state}${tag}`);
    }
    report.note("roll one back with: boom rollback --run-id <id> (or --to <checkpoint>)");
  }
  return report.finish({ ok: "history shown" });
}

// `boom checkpoint <name>` — label the most recent run as a named, prune-exempt known-good
// state that `boom rollback --to <name>` can return to. A name already pointing at a different
// run is refused (rather than silently moved), so a checkpoint means one fixed point in time.
export async function checkpoint(ctx: BoomContext, name: string): Promise<number> {
  const report = bandsReporter(ctx.process, ctx.env, "checkpoint", { setup: "MARKING A KNOWN-GOOD STATE…" });
  const run = await readRun(ctx.env);
  if (!run) {
    report.fail("no run to checkpoint — sync at least once first");
    return report.finish({ ok: "checkpoint done", fail: (f) => `checkpoint: ${f} failure(s)` });
  }
  const existing = await findRunByLabel(ctx.env, name);
  if (existing && existing !== run.runId) {
    report.fail(`checkpoint '${name}' already marks run ${existing} — pick another name`);
    return report.finish({ ok: "checkpoint done", fail: (f) => `checkpoint: ${f} failure(s)` });
  }
  await setRunLabel(ctx.env, run.runId, name);
  report.header("Checkpoint");
  report.ok(`'${name}' → ${run.runId}`);
  report.note(`return to it with: boom rollback --to ${name}`);
  return report.finish({ ok: `checkpoint '${name}' set`, fail: (f) => `checkpoint: ${f} failure(s)` });
}

// Reverse a `mkdir` with rmdir(2), never `rm -rf`: the directory boom created may have been
// filled by the user since, and a recursive remove would take their data with it. Returns
// whether the directory is actually gone (i.e. whether the record was reversed).
async function undoMkdir(dst: string, disp: string, report: Reporter): Promise<boolean> {
  try {
    await rmdir(dst);
    report.ok(`removed ${disp}`);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // The whole point of rmdir: a non-empty directory is a report, not a deletion. macOS/BSD
    // returns EEXIST where Linux returns ENOTEMPTY for the identical condition.
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      report.warn(`${disp} left in place — not empty`);
      return false;
    }
    // Already in the post-rollback state (the user removed it themselves). Reversed, not
    // failed — the `remove` arm's `force: true` treats a missing path the same way, and
    // without this a tidy user flips a previously-clean `boom rollback` to exit 1.
    if (code === "ENOENT") {
      report.ok(`${disp} already gone`);
      return true;
    }
    throw e; // anything else (EACCES, ENOTDIR) is a real failure for the caller's catch
  }
}

// The non-undefined shape readRun returns — the unit reverseRun operates on.
type Run = NonNullable<Awaited<ReturnType<typeof readRun>>>;

// Reverse one run's mutations (newest→oldest within the run), drop the manifest ownership of
// what was actually undone, and surface the run's non-reversible side effects. Shared by a
// single-run rollback and the multi-run `--to <checkpoint>` rewind, so both undo identically.
async function reverseRun(ctx: BoomContext, run: Run, report: Reporter, dryRun: boolean): Promise<void> {
  const reversed: string[] = [];
  for (const rec of [...run.done].reverse()) {
    const disp = displayPath(rec.dst, ctx.env);
    // A destructive replay — preview it under --dry-run so an operator can see exactly what
    // would be removed vs restored before committing to it.
    if (dryRun) {
      report.plan(undoPreview(rec.undo, disp));
      continue;
    }
    try {
      switch (rec.undo.kind) {
        case "remove":
          await rm(rec.dst, { recursive: true, force: true });
          report.ok(`removed ${disp}`);
          reversed.push(rec.dst);
          break;
        case "rmdir":
          if (await undoMkdir(rec.dst, disp, report)) reversed.push(rec.dst);
          break;
        case "osx":
          if (restoreOsx(rec.undo, ctx, report)) reversed.push(rec.dst);
          break;
        case "restore":
          await restoreFrom(rec.undo.from, rec.dst);
          report.ok(`restored ${disp}`);
          reversed.push(rec.dst);
          break;
      }
    } catch (e) {
      report.fail(`${disp}: ${(e as Error).message}`);
    }
  }

  // Drop from the manifest only the destinations we ACTUALLY reversed — they're no longer
  // boom-owned (removed, or restored to a foreign file), so state matches disk. A dst whose
  // reversal threw is deliberately left owned: the boom-created file is still there, so
  // keeping the ownership record means the next sync can still reap it rather than orphaning
  // an untracked, un-reapable file. (No manifest change on --dry-run — nothing moved.)
  if (!dryRun) await removeManifestEntries(ctx.env, reversed);

  // Links/copies are reversed above; `run`/`hook` side effects can't be, so surface
  // them so the operator knows what state rollback did NOT restore.
  if (run.sides.length > 0) {
    report.header(`Not reversible (ran during ${run.runId})`);
    for (const s of run.sides) report.warn(`${s.op}: ${s.label}`);
  }
}

export async function rollback(ctx: BoomContext, runId?: string, dryRun = false): Promise<number> {
  const report = bandsReporter(ctx.process, ctx.env, "rollback", { setup: "REWINDING THE TIMELINE…" });
  const run = await readRun(ctx.env, runId);
  if (!run) {
    report.fail(runId ? `no run ${runId} to roll back` : "no run to roll back");
    return report.finish({ ok: "rollback done", fail: (f) => `rollback: ${f} failure(s)` });
  }
  report.header(`rollback ${run.runId}${dryRun ? " — dry run (no changes)" : ""}`);
  await reverseRun(ctx, run, report, dryRun);
  return report.finish({ ok: "rollback done", fail: (f) => `rollback: ${f} failure(s)` });
}

// `boom rollback --to <checkpoint>` — return the machine to a checkpoint's state by reversing
// every run made AFTER it, newest-first. The checkpoint run itself is deliberately NOT reversed
// (that's the state we're returning to). Run ids sort chronologically, so "made after" is a
// plain id comparison, and listRuns' newest-first order is exactly the reverse-replay order.
// Best-effort across retained history — but *reported* best-effort: a post-checkpoint run whose
// journal was pruned can no longer be reversed, and this command used to skip it and still exit
// 0, which reads as "you are back at the checkpoint" when you are not. It now carries a warning
// tier (exit 2) and names the prune horizon, so keeping checkpoints inside the retained window
// is an instruction the tool gives rather than one the operator has to already know.
export async function rollbackTo(ctx: BoomContext, name: string, dryRun = false): Promise<number> {
  const report = bandsReporter(ctx.process, ctx.env, "rollback", { setup: "REWINDING TO A CHECKPOINT…" });
  const target = await findRunByLabel(ctx.env, name);
  if (!target) {
    report.fail(`no checkpoint named '${name}' — see \`boom rollback --list\``);
    return report.finish({ ok: "rollback done", fail: (f) => `rollback: ${f} failure(s)` });
  }
  const newer = (await listRuns(ctx.env)).filter((r) => r.runId > target); // listRuns: newest first
  report.header(`rollback to '${name}' (${target})${dryRun ? " — dry run (no changes)" : ""}`);
  if (newer.length === 0) {
    report.note(`already at checkpoint '${name}' — no later runs to undo`);
    return report.finish({
      ok: `at checkpoint '${name}'`,
      fail: (f) => `rollback: ${f} failure(s)`,
      warn: (w) => `rollback: ${w} warning(s)`,
    });
  }
  // A horizon at or past the checkpoint means runs between them were deleted, so `newer` is a
  // subset of what actually happened after it — the difference between a partial rewind and a
  // complete one, which only the journal's own destruction record can tell us.
  const horizon = await pruneHorizon(ctx.env);
  if (horizon !== undefined && horizon > target)
    report.warn(
      `history was pruned past '${name}' — run(s) made after it are no longer reversible (journal pruned up to ${horizon}); rewound only the ${newer.length} retained run(s)`,
    );
  for (const summary of newer) {
    const run = await readRun(ctx.env, summary.runId);
    if (run) await reverseRun(ctx, run, report, dryRun);
  }
  return report.finish({
    ok: `rolled back to '${name}'`,
    fail: (f) => `rollback: ${f} failure(s)`,
    warn: (w) => `rollback: ${w} warning(s)`,
  });
}
