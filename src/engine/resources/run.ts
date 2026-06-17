// The `run` resource: an inline shell step bound to a verb. Ports engine/run's `on`
// primitive — `apply` fires on apply AND fix (fix = re-apply); `verify` on verify.

import type { Run } from "../../config/schema.ts";
import { runShell } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

export function reconcileRun(entry: Run, ctx: ReconcileCtx): void {
  const fires =
    (entry.on === "apply" && (ctx.verb === "apply" || ctx.verb === "fix")) ||
    (entry.on === "verify" && ctx.verb === "verify");
  if (!fires) return;

  if (entry.on === "apply" && ctx.dryRun) {
    ctx.report.plan(`would run: ${entry.cmd}`);
    return;
  }
  const { code } = runShell(entry.cmd, ctx.env);
  if (code !== 0) ctx.report.fail(`${entry.cmd} (exit ${code})`);
}
