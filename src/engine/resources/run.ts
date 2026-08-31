// The `run` resource: an inline shell step bound to one or more verbs. Ports engine/run's
// `on` primitive — `sync` fires on the sync verb (bare or `--fix`); `verify` on verify;
// `uninstall` on uninstall (the teardown direction, symmetric with hooks). `on` accepts a
// list, so a step that fires on both sync and uninstall is one entry, not a duplicated pair.
//
// Guard contract: `creates` (a path) and `unless` (a shell predicate) make a step idempotent
// declaratively. Either one satisfied skips the step; they gate every verb the step binds to.
// `creates` is a stat, so it is evaluated even in a dry run; `unless` is user shell, so a dry
// run never executes it and says so instead.
import { isAbsolute, join } from "node:path";
import type { Run } from "../../config/schema.ts";
import { displayPath, expandTilde, pathExists } from "../../lib/fs.ts";
import { failureDetail, runShellAsync, toolIo } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

// A compact spinner label for a shell step: the first line, clipped, so the active-work line
// reads `  ✸ lefthook install…` rather than echoing a multi-line command.
function stepLabel(cmd: string): string {
  const first = cmd.split("\n")[0]?.trim() ?? cmd;
  return first.length > 48 ? `${first.slice(0, 47)}…` : first;
}

// The two guards are separate helpers because they differ in *cost and side-effect risk*, not
// just in shape — one is a stat, the other spawns arbitrary user shell — and that difference is
// the whole reason the dry-run branch below treats them differently.

// Read-only: a stat. Safe in any mode. Gotcha: a relative `creates` resolves against ctx.repo,
// matching the `cwd: ctx.repo` the step itself runs under — not the invocation cwd, which would
// make the guard's verdict depend on where `boom` was typed while the step's own didn't.
async function createsSatisfied(entry: Run, ctx: ReconcileCtx): Promise<string | undefined> {
  if (!entry.creates) return undefined;
  const p = expandTilde(entry.creates, ctx.env);
  const abs = isAbsolute(p) ? p : join(ctx.repo, p);
  return (await pathExists(abs)) ? `creates ${displayPath(abs, ctx.env)} exists` : undefined;
}

// Spawns arbitrary user shell — NEVER call this under ctx.dryRun. `silent` so a probe's own
// chatter never lands in the report: the exit code is the entire signal.
async function unlessSatisfied(entry: Run, ctx: ReconcileCtx): Promise<string | undefined> {
  if (!entry.unless) return undefined;
  const { code } = await runShellAsync(entry.unless, ctx.env, {
    silent: true,
    cwd: ctx.repo,
    timeoutMs: entry.timeout ? entry.timeout * 1000 : undefined,
  });
  return code === 0 ? `unless succeeded: ${entry.unless}` : undefined;
}

export async function reconcileRun(entry: Run, ctx: ReconcileCtx): Promise<void> {
  const on = Array.isArray(entry.on) ? entry.on : [entry.on];
  if (!on.includes(ctx.verb)) return;

  // `creates` is evaluated in every mode, dry runs included: it is a read-only predicate, and a
  // preview that announces "would run" for a step it would actually skip is a lying preview.
  const createsSkip = await createsSatisfied(entry, ctx);
  if (createsSkip) {
    ctx.report.skip(`${stepLabel(entry.cmd)} — skipped (${createsSkip})`);
    return;
  }

  if ((ctx.verb === "sync" || ctx.verb === "uninstall") && ctx.dryRun) {
    // `unless` is arbitrary user shell, so a preview must never be the first thing that runs
    // it — same refusal check.ts makes for `repair`. Report the uncertainty rather than either
    // lying about the verdict or mutating to find it out.
    ctx.report.plan(
      entry.unless
        ? `would run: ${entry.cmd} (unless \`${entry.unless}\` — not evaluated in a dry run)`
        : `would run: ${entry.cmd}`,
    );
    return;
  }

  const unlessSkip = await unlessSatisfied(entry, ctx);
  if (unlessSkip) {
    ctx.report.skip(`${stepLabel(entry.cmd)} — skipped (${unlessSkip})`);
    return;
  }
  // Journal the shell step as a non-reversible side effect, so the run's record shows what
  // undoing its file mutations would NOT undo. Only a mutating sync carries a journal — and only the
  // mutation: a guard that skipped the step is a condition, not a side effect, so it records
  // nothing (both guards return above this line).
  if (ctx.verb === "sync") await ctx.journal?.side("run", entry.cmd);
  // Run from the dotfiles repo, not the invocation cwd, so sync is cwd-independent:
  // a step like `lefthook install` targets the repo's `.git`, not whatever directory
  // `boom` was called from. Steps that name absolute / `~`-anchored paths are unaffected.
  const { code, timedOut, stderr, stdout } = await ctx.report.spin(stepLabel(entry.cmd), () =>
    runShellAsync(entry.cmd, ctx.env, {
      ...toolIo(ctx.json, ctx.verbose),
      // A run step is somebody's own command and may explain itself on either channel, so keep
      // both: under `silent` stdout is otherwise discarded and a step that reports there fails
      // with a bare "(exit N)" and no reason.
      captureStdout: true,
      cwd: ctx.repo,
      timeoutMs: entry.timeout ? entry.timeout * 1000 : undefined,
    }),
  );
  if (timedOut) ctx.report.fail(`${entry.cmd} (timed out after ${entry.timeout}s)`);
  else if (code !== 0) ctx.report.fail(`${entry.cmd} (exit ${code})${failureDetail(stderr, stdout)}`);
}
