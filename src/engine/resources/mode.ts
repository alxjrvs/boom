// The mode tails `copy` and `tmpl` share. A content-current file still has to have its declared
// mode enforced, or permissions that drifted looser (a prior umask, a manual chmod) are never
// repaired: each resource's change-gate returns before its write-time chmod, so without this
// `--fix` is a no-op and `verify` is blind — a copied `~/.ssh/config` left 0777 stays 0777.
import { chmod } from "node:fs/promises";
import { fmtMode, modeOf } from "../../lib/fs.ts";
import type { ReconcileCtx } from "../types.ts";

// Sync's tail for a content-current file: plan or apply the chmod when the mode drifted, and
// report it as a change. Returns true when it reported, so the caller prints its own
// "already up to date" skip only when nothing at all changed.
export async function enforceMode(
  dst: string,
  disp: string,
  want: number,
  ctx: ReconcileCtx,
): Promise<boolean> {
  if ((await modeOf(dst)) === want) return false;
  if (ctx.dryRun) {
    ctx.report.plan(`${disp} mode would be set to 0${fmtMode(want)}`);
  } else {
    await chmod(dst, want);
    ctx.report.ok(`${disp} mode set to 0${fmtMode(want)}`);
  }
  return true;
}

// Verify's tail for a content-current file: mode drift is a warning (the tier sync repairs), and
// a correct mode is the caller's steady-state skip line.
export async function verifyMode(
  dst: string,
  disp: string,
  want: number,
  ctx: ReconcileCtx,
  okLabel: string,
): Promise<void> {
  const have = await modeOf(dst);
  if (have !== undefined && have !== want)
    ctx.report.warn(`${disp} mode ${fmtMode(have)}, expected ${fmtMode(want)}`);
  else ctx.report.skip(okLabel);
}
