// Roll back a previous sync by replaying its journal's `done` records in reverse:
// remove what boom created, restore what an overwrite displaced.
import { rm } from "node:fs/promises";
import { detectOs } from "../config/profile.ts";
import type { BoomContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { displayPath, restoreFrom } from "../lib/fs.ts";
import { cleanEnv } from "../lib/proc.ts";
import { Reporter } from "../lib/reporter.ts";
import { listRuns, readRun, type UndoToken } from "./journal.ts";
import { removeManifestEntries } from "./state.ts";

// One-line preview of what reversing a record would do (for --dry-run).
function undoPreview(undo: UndoToken, disp: string): string {
  if (undo.kind === "remove") return `would remove ${disp}`;
  if (undo.kind === "osx") return `would ${undo.prior === null ? "delete" : "restore"} default ${disp}`;
  return `would restore ${disp}`;
}

// Re-apply a macOS default's prior value (or delete a key boom introduced). Non-darwin is a
// reported no-op — the journal could have been carried to another host.
function restoreOsx(undo: Extract<UndoToken, { kind: "osx" }>, ctx: BoomContext, report: Reporter): void {
  if (detectOs(ctx.env) !== "darwin") {
    report.warn(`skipped osx restore ${undo.domain} ${undo.key} (not darwin)`);
    return;
  }
  const env = cleanEnv(ctx.env);
  const argv =
    undo.prior === null
      ? ["defaults", "delete", undo.domain, undo.key]
      : ["defaults", "write", undo.domain, undo.key, `-${undo.type}`, undo.prior];
  Bun.spawnSync(argv, { env, stdout: "ignore", stderr: "ignore" });
  report.ok(`${undo.prior === null ? "deleted" : "restored"} default ${undo.domain} ${undo.key}`);
}

// `boom rollback --list` — enumerate the retained runs so the ids `--run-id` accepts are
// discoverable, instead of forcing a hand `ls` of the state dir. Exit 0 always; it reads.
export async function listRollbacks(ctx: BoomContext): Promise<number> {
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env));
  report.header("Rollback history");
  const runs = await listRuns(ctx.env);
  if (runs.length === 0) {
    report.note("no runs recorded yet");
  } else {
    for (const r of runs) {
      const side = r.sides > 0 ? `, ${r.sides} side-effect(s)` : "";
      const state = r.committed ? "" : "  (interrupted — never committed)";
      report.ok(`${r.runId}  —  ${r.ops} op(s)${side}${state}`);
    }
    report.note("roll one back with: boom rollback --run-id <id>");
  }
  ctx.process.stdout.write("\n");
  return 0;
}

export async function rollback(ctx: BoomContext, runId?: string, dryRun = false): Promise<number> {
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env));
  const run = await readRun(ctx.env, runId);
  if (!run) {
    report.fail(runId ? `no run ${runId} to roll back` : "no run to roll back");
    return 1;
  }

  report.header(`rollback ${run.runId}${dryRun ? " — dry run (no changes)" : ""}`);
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
      if (rec.undo.kind === "remove") {
        await rm(rec.dst, { recursive: true, force: true });
        report.ok(`removed ${disp}`);
      } else if (rec.undo.kind === "osx") {
        restoreOsx(rec.undo, ctx, report);
      } else {
        await restoreFrom(rec.undo.from, rec.dst);
        report.ok(`restored ${disp}`);
      }
      reversed.push(rec.dst);
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
    report.header("Not reversible (ran during sync)");
    for (const s of run.sides) report.warn(`${s.op}: ${s.label}`);
  }

  return report.finish({
    ok: "rollback done",
    fail: (f) => `rollback: ${f} failure(s)`,
  });
}
