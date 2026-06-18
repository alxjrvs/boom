// The `run` resource: an inline shell step bound to a verb. Ports engine/run's `on`
// primitive — `apply` fires on apply AND fix (fix = re-apply); `verify` on verify;
// `uninstall` on uninstall (the teardown direction, symmetric with hooks).
import type { Run } from "../../config/schema.ts";
import { runShell } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

export async function reconcileRun(entry: Run, ctx: ReconcileCtx): Promise<void> {
  const fires =
    (entry.on === "apply" && (ctx.verb === "apply" || ctx.verb === "fix")) ||
    (entry.on === "verify" && ctx.verb === "verify") ||
    (entry.on === "uninstall" && ctx.verb === "uninstall");
  if (!fires) return;

  if ((entry.on === "apply" || entry.on === "uninstall") && ctx.dryRun) {
    ctx.report.plan(`would run: ${entry.cmd}`);
    return;
  }
  // Journal the shell step as a non-reversible side effect so rollback can warn that
  // re-applying it won't be undone. Only mutating apply/fix carry a journal.
  if (ctx.verb === "apply" || ctx.verb === "fix") await ctx.journal?.side("run", entry.cmd);
  const { code } = runShell(entry.cmd, ctx.env);
  if (code !== 0) ctx.report.fail(`${entry.cmd} (exit ${code})`);
}
