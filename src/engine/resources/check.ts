// The `check` resource: content assertions on a file — every `present` regex must match its
// contents and every `absent` regex must not. The declarative form of the escaping-heavy
// `grep`-in-a-`run` guardrails; failures contribute to `boom verify`'s exit code and its
// `--json` report instead of being scraped from a shell step's stdout.
//
// On `verify` a check reports. On `sync`, a check with a `repair` command *converges*: when
// the assertion currently fails, the command runs to make it so — so `check` is no longer the
// one resource whose drift `boom source` can detect but not repair. Without `repair`, sync is
// a no-op (there is nothing to make so). `uninstall` is always a no-op.
import type { Check } from "../../config/schema.ts";
import { displayPath, expandTilde, pathExists } from "../../lib/fs.ts";
import { runShell } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

// Compile a pattern, or return the error text so a bad regex fails the check legibly instead
// of throwing out of the section loop.
function compile(pattern: string): { re: RegExp } | { err: string } {
  try {
    return { re: new RegExp(pattern) };
  } catch (e) {
    return { err: `invalid regex /${pattern}/: ${(e as Error).message}` };
  }
}

// The assertion's current state: the file is missing, satisfied, or has concrete failures.
type Assessment = { missing: true } | { ok: true } | { failures: string[] };

async function assess(entry: Check, ctx: ReconcileCtx): Promise<Assessment> {
  const file = expandTilde(entry.path, ctx.env);
  if (!(await pathExists(file))) return { missing: true };
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch (e) {
    return { failures: [`could not read — ${(e as Error).message}`] };
  }
  const failures: string[] = [];
  for (const pattern of entry.present ?? []) {
    const c = compile(pattern);
    if ("err" in c) failures.push(c.err);
    else if (!c.re.test(text)) failures.push(`missing required /${pattern}/`);
  }
  for (const pattern of entry.absent ?? []) {
    const c = compile(pattern);
    if ("err" in c) failures.push(c.err);
    else if (c.re.test(text)) failures.push(`forbidden /${pattern}/ present`);
  }
  return failures.length === 0 ? { ok: true } : { failures };
}

export async function reconcileCheck(entry: Check, ctx: ReconcileCtx): Promise<void> {
  if (ctx.verb === "uninstall") return;
  const { report } = ctx;
  const file = expandTilde(entry.path, ctx.env);
  const disp = displayPath(file, ctx.env);
  const label = entry.message ? `${entry.message} (${disp})` : disp;
  // Default `fail`: a guardrail that silently stops guarding when its file disappears is worse
  // than useless — the missing file is exactly the regression it exists to catch.
  const missing = entry.missing_file ?? "fail";
  const result = await assess(entry, ctx);

  if (ctx.verb === "verify") {
    if ("missing" in result) {
      if (missing === "fail") report.fail(`${label}: file missing`);
      else if (missing === "pass") report.skip(`${disp} absent (allowed)`);
      else report.skip(`${disp} absent — check skipped`);
    } else if ("ok" in result) {
      report.skip(`${disp} content ok`);
    } else {
      report.fail(`${label}: ${result.failures.join("; ")}`);
    }
    return;
  }

  // sync: only a declared `repair` gives sync anything to do — otherwise a check is inert here.
  if (!entry.repair) return;

  // Already satisfied (content ok, or legitimately-absent under `pass`) → nothing to repair.
  if ("ok" in result || ("missing" in result && missing === "pass")) {
    report.skip(`${disp} ok — no repair needed`);
    return;
  }
  // A file absent under `skip` isn't drift to converge — leave it.
  if ("missing" in result && missing === "skip") {
    report.skip(`${disp} absent — check skipped`);
    return;
  }
  if (ctx.dryRun) {
    report.plan(`would repair ${disp}: ${entry.repair}`);
    return;
  }
  // A repair is arbitrary shell — journal it as a non-reversible side effect (mutating sync
  // only), like `run`/`hook`, so rollback can warn that replaying it can't be undone. Run from
  // the repo so a repair command is cwd-independent, matching the `run` resource.
  await ctx.journal?.side("check-repair", entry.repair);
  const { code, timedOut } = runShell(entry.repair, ctx.env, { quietStdout: ctx.json, cwd: ctx.repo });
  if (timedOut || code !== 0) {
    report.fail(`${label}: repair failed (${entry.repair})`);
    return;
  }
  // Converged? Re-assess so a repair that ran but didn't actually satisfy the assertion is
  // surfaced, not assumed fixed.
  const after = await assess(entry, ctx);
  if ("ok" in after || ("missing" in after && missing === "pass")) report.ok(`${disp} repaired`);
  else report.warn(`${label}: repair ran but assertion still fails`);
}
