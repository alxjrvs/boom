// Roll back a previous apply by replaying its journal's `done` records in reverse:
// remove what boom created, restore what an overwrite displaced.
import { rm } from "node:fs/promises";
import type { BoomContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { displayPath, restoreFrom } from "../lib/fs.ts";
import { Reporter } from "../lib/reporter.ts";
import { readRun } from "./journal.ts";

export async function rollback(ctx: BoomContext, runId?: string): Promise<number> {
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env));
  const run = await readRun(ctx.env, runId);
  if (!run) {
    report.fail(runId ? `no run ${runId} to roll back` : "no run to roll back");
    return 1;
  }

  report.header(`rollback ${run.runId}`);
  for (const rec of [...run.done].reverse()) {
    const disp = displayPath(rec.dst, ctx.env);
    try {
      if (rec.undo.kind === "remove") {
        await rm(rec.dst, { recursive: true, force: true });
        report.ok(`removed ${disp}`);
      } else {
        await restoreFrom(rec.undo.from, rec.dst);
        report.ok(`restored ${disp}`);
      }
    } catch (e) {
      report.fail(`${disp}: ${(e as Error).message}`);
    }
  }

  // Links/copies are reversed above; `run`/`hook` side effects can't be, so surface
  // them so the operator knows what state rollback did NOT restore.
  if (run.sides.length > 0) {
    report.header("Not reversible (ran during apply)");
    for (const s of run.sides) report.warn(`${s.op}: ${s.label}`);
  }

  ctx.process.stdout.write("\n");
  if (report.failures > 0) {
    report.fail(`rollback: ${report.failures} failure(s)`);
    return 1;
  }
  report.ok("rollback done");
  return 0;
}
