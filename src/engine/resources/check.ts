// The `check` resource: verify-time content assertions on a file — every `present` regex
// must match its contents and every `absent` regex must not. The declarative form of the
// escaping-heavy `grep`-in-a-`run` guardrails; failures contribute to `boom verify`'s exit
// code and its `--json` report instead of being scraped from a shell step's stdout.
//
// Verify-only: like `run` gates on its `on` verb, a check evaluates on `verify` and is a
// no-op on sync/uninstall (there is nothing to *make so* — it only asserts).
import type { Check } from "../../config/schema.ts";
import { displayPath, expandTilde, pathExists } from "../../lib/fs.ts";
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

export async function reconcileCheck(entry: Check, ctx: ReconcileCtx): Promise<void> {
  if (ctx.verb !== "verify") return;
  const { report } = ctx;
  const file = expandTilde(entry.file, ctx.env);
  const disp = displayPath(file, ctx.env);
  const label = entry.message ? `${entry.message} (${disp})` : disp;

  if (!(await pathExists(file))) {
    switch (entry.missing_file ?? "skip") {
      case "fail":
        report.fail(`${label}: file missing`);
        return;
      case "pass":
        report.ok(`${disp} absent (allowed)`);
        return;
      default:
        report.skip(`${disp} absent — check skipped`);
        return;
    }
  }

  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch (e) {
    report.fail(`${label}: could not read — ${(e as Error).message}`);
    return;
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

  if (failures.length === 0) report.ok(`${disp} content ok`);
  else report.fail(`${label}: ${failures.join("; ")}`);
}
