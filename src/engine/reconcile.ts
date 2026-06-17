// The reconcile core: load + validate the config, then run each section under a verb,
// and return the process exit code (verify: 0 ok / 2 warn / 1 fail; mutating verbs:
// 0 or 1). This is the single loop all reconcile verbs share.
import { loadConfig, resolveConfigDir } from "../config/load.ts";
import type { Botufile } from "../config/schema.ts";
import type { BotuContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { Reporter } from "../lib/reporter.ts";
import { reconcileSection } from "./registry.ts";
import type { LinkMode, ReconcileCtx, Verb } from "./types.ts";

export interface ReconcileOptions {
  readonly only?: string[];
  readonly dryRun?: boolean;
  readonly linkMode?: LinkMode;
}

export async function reconcile(verb: Verb, ctx: BotuContext, opts: ReconcileOptions): Promise<number> {
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env));

  const repo = await resolveConfigDir(ctx.env, ctx.cwd);
  if (!repo) {
    report.fail("no dotfiles repo found — run `botu init`");
    return 1;
  }

  let config: Botufile;
  try {
    config = await loadConfig(repo);
  } catch (e) {
    report.fail((e as Error).message);
    return 1;
  }

  const rctx: ReconcileCtx = {
    repo,
    verb,
    dryRun: opts.dryRun ?? false,
    linkMode: opts.linkMode ?? "interactive",
    env: ctx.env,
    report,
    declared: [],
  };

  if (rctx.dryRun) report.header(`${verb} — dry run (no changes)`);
  const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : undefined;
  for (const section of config.section) {
    if (only && !only.has(section.name)) continue;
    report.header(section.name);
    await reconcileSection(section, rctx);
  }

  ctx.process.stdout.write("\n");
  if (verb === "verify") {
    if (report.failures > 0) {
      report.fail(`verify: ${report.failures} failure(s), ${report.warnings} warning(s)`);
      return 1;
    }
    if (report.warnings > 0) {
      report.warn(`verify: ${report.warnings} warning(s)`);
      return 2;
    }
    report.ok("verify: all checks passed");
    return 0;
  }
  if (report.failures > 0) {
    report.fail(`${verb}: ${report.failures} failure(s)`);
    return 1;
  }
  report.ok(`${verb} done`);
  return 0;
}
