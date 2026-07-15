// The `run` resource: an inline shell step bound to one or more verbs. Ports engine/run's
// `on` primitive — `sync` fires on the sync verb (bare or `--fix`); `verify` on verify;
// `uninstall` on uninstall (the teardown direction, symmetric with hooks). `on` accepts a
// list, so a step that fires on both sync and uninstall is one entry, not a duplicated pair.
import type { Run } from "../../config/schema.ts";
import { runShell } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

export async function reconcileRun(entry: Run, ctx: ReconcileCtx): Promise<void> {
  const on = Array.isArray(entry.on) ? entry.on : [entry.on];
  if (!on.includes(ctx.verb)) return;

  if ((ctx.verb === "sync" || ctx.verb === "uninstall") && ctx.dryRun) {
    ctx.report.plan(`would run: ${entry.cmd}`);
    return;
  }
  // Journal the shell step as a non-reversible side effect so rollback can warn that
  // re-running it won't be undone. Only a mutating sync carries a journal.
  if (ctx.verb === "sync") await ctx.journal?.side("run", entry.cmd);
  // Run from the dotfiles repo, not the invocation cwd, so sync is cwd-independent:
  // a step like `lefthook install` targets the repo's `.git`, not whatever directory
  // `boom` was called from. Steps that name absolute / `~`-anchored paths are unaffected.
  const { code, timedOut } = runShell(entry.cmd, ctx.env, {
    quietStdout: ctx.json,
    cwd: ctx.repo,
    timeoutMs: entry.timeout ? entry.timeout * 1000 : undefined,
  });
  if (timedOut) ctx.report.fail(`${entry.cmd} (timed out after ${entry.timeout}s)`);
  else if (code !== 0) ctx.report.fail(`${entry.cmd} (exit ${code})`);
}
