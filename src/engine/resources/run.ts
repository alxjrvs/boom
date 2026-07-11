// The `run` resource: an inline shell step bound to a verb. Ports engine/run's `on`
// primitive — `apply` fires on apply AND repair (repair = re-apply); `verify` on verify;
// `uninstall` on uninstall (the teardown direction, symmetric with hooks).
import type { Run } from "../../config/schema.ts";
import { runShell } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

export async function reconcileRun(entry: Run, ctx: ReconcileCtx): Promise<void> {
  const fires =
    (entry.on === "apply" && (ctx.verb === "apply" || ctx.verb === "repair")) ||
    (entry.on === "verify" && ctx.verb === "verify") ||
    (entry.on === "uninstall" && ctx.verb === "uninstall");
  if (!fires) return;

  if ((entry.on === "apply" || entry.on === "uninstall") && ctx.dryRun) {
    ctx.report.plan(`would run: ${entry.cmd}`);
    return;
  }
  // Journal the shell step as a non-reversible side effect so rollback can warn that
  // re-applying it won't be undone. Only mutating apply/repair carry a journal.
  if (ctx.verb === "apply" || ctx.verb === "repair") await ctx.journal?.side("run", entry.cmd);
  // Run from the dotfiles repo, not the invocation cwd, so apply is cwd-independent:
  // a step like `lefthook install` targets the repo's `.git`, not whatever directory
  // `boom` was called from. Steps that name absolute / `~`-anchored paths are unaffected.
  const { code } = runShell(entry.cmd, ctx.env, { quietStdout: ctx.json, cwd: ctx.repo });
  if (code !== 0) ctx.report.fail(`${entry.cmd} (exit ${code})`);
}
