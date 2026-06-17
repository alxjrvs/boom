// The reconcile core: load + validate the config, run each section under a verb, reap
// orphaned links, and return the exit code (verify: 0/2/1; mutating verbs: 0/1). For
// apply/fix it opens a transaction journal (+ backups) so the run is rollback-able and
// resumable, and persists the manifest of owned destinations.
import { join } from "node:path";
import { loadConfig, resolveConfigDir } from "../config/load.ts";
import type { Botufile } from "../config/schema.ts";
import type { BotuContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { displayPath, linkTarget, rm } from "../lib/fs.ts";
import { Reporter } from "../lib/reporter.ts";
import { Journal, newRunId, readRun } from "./journal.ts";
import { reconcileSection } from "./registry.ts";
import { backupsDir, readManifest, writeManifest } from "./state.ts";
import type { LinkMode, ReconcileCtx, Verb } from "./types.ts";

export interface ReconcileOptions {
  readonly only?: string[];
  readonly dryRun?: boolean;
  readonly linkMode?: LinkMode;
  readonly json?: boolean;
  readonly resume?: boolean;
}

async function reapOrphans(ctx: ReconcileCtx, prior: readonly string[]): Promise<void> {
  const declared = new Set(ctx.declared);
  let shown = false;
  for (const dst of prior) {
    if (declared.has(dst)) continue;
    const target = await linkTarget(dst);
    if (!target?.startsWith(`${ctx.repo}/`)) continue; // only links into our repo
    if (!shown) {
      ctx.report.header("Orphans");
      shown = true;
    }
    const disp = displayPath(dst, ctx.env);
    if (ctx.verb === "verify") ctx.report.warn(`${disp} → ${target} (no longer declared — botu fix to reap)`);
    else if (ctx.dryRun) ctx.report.note(`would reap ${disp}`);
    else {
      await rm(dst, { force: true });
      ctx.report.ok(`reaped orphan ${disp}`);
    }
  }
}

export async function reconcile(verb: Verb, ctx: BotuContext, opts: ReconcileOptions): Promise<number> {
  const json = opts.json ?? false;
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env), json);

  const finish = (): number => {
    if (verb === "verify") {
      if (json) {
        ctx.process.stdout.write(
          `${JSON.stringify({
            ok: report.failures === 0,
            warnings: report.warnings,
            failures: report.failures,
            records: report.records,
          })}\n`,
        );
      } else {
        ctx.process.stdout.write("\n");
        if (report.failures > 0)
          report.fail(`verify: ${report.failures} failure(s), ${report.warnings} warning(s)`);
        else if (report.warnings > 0) report.warn(`verify: ${report.warnings} warning(s)`);
        else report.ok("verify: all checks passed");
      }
      return report.failures > 0 ? 1 : report.warnings > 0 ? 2 : 0;
    }
    ctx.process.stdout.write("\n");
    if (report.failures > 0) {
      report.fail(`${verb}: ${report.failures} failure(s)`);
      return 1;
    }
    report.ok(`${verb} done`);
    return 0;
  };

  const repo = await resolveConfigDir(ctx.env, ctx.cwd);
  if (!repo) {
    report.fail("no dotfiles repo found — run `botu init`");
    return finish();
  }
  let config: Botufile;
  try {
    config = await loadConfig(repo);
  } catch (e) {
    report.fail((e as Error).message);
    return finish();
  }

  const dryRun = opts.dryRun ?? false;
  const mutating = (verb === "apply" || verb === "fix") && !dryRun;
  let journal: Journal | undefined;
  let backupRoot: string | undefined;
  let resumeDone: ReadonlySet<string> | undefined;
  if (mutating) {
    const runId = newRunId();
    journal = new Journal(ctx.env, runId);
    backupRoot = join(backupsDir(ctx.env), runId);
    if (opts.resume) {
      const prior = await readRun(ctx.env);
      if (prior) resumeDone = new Set(prior.done.map((d) => d.dst));
    }
  }
  const priorManifest = await readManifest(ctx.env);

  const rctx: ReconcileCtx = {
    repo,
    verb,
    dryRun,
    linkMode: opts.linkMode ?? "interactive",
    env: ctx.env,
    report,
    declared: [],
    journal,
    backupRoot,
    resumeDone,
  };

  if (dryRun) report.header(`${verb} — dry run (no changes)`);
  const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : undefined;
  for (const section of config.section) {
    if (only && !only.has(section.name)) continue;
    report.header(section.name);
    await reconcileSection(section, rctx);
  }

  if (verb !== "uninstall") await reapOrphans(rctx, priorManifest);

  if (mutating) {
    await journal?.commit();
    await writeManifest(ctx.env, rctx.declared);
  } else if (verb === "uninstall" && !dryRun) {
    await writeManifest(ctx.env, []); // uninstall clears the manifest
  }

  return finish();
}
