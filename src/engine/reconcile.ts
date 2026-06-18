// The reconcile core: load + validate the config, run each section under a verb, reap
// orphaned links, and return the exit code (verify: 0/2/1; mutating verbs: 0/1). For
// apply/fix it opens a transaction journal (+ backups) so the run is rollback-able and
// resumable, and persists the manifest of owned destinations.
import { join } from "node:path";
import { loadConfig, loadOptionalConfigFile, resolveConfigDir } from "../config/load.ts";
import { overlayFiles, profileContext, sectionApplies } from "../config/profile.ts";
import type { Botufile, Section } from "../config/schema.ts";
import type { BotuContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { displayPath, filesEqual, linkTarget, pathExists, rm } from "../lib/fs.ts";
import { Reporter } from "../lib/reporter.ts";
import { Journal, newRunId, pruneRuns, readRun } from "./journal.ts";
import { reconcileSection } from "./registry.ts";
import { backupsDir, type ManifestEntry, readManifest, writeManifest } from "./state.ts";
import type { LinkMode, ReconcileCtx, Verb } from "./types.ts";

export interface ReconcileOptions {
  readonly only?: string[];
  readonly dryRun?: boolean;
  readonly linkMode?: LinkMode;
  readonly json?: boolean;
  readonly resume?: boolean;
  readonly profiles?: string[];
}

// Merge a partial run's declared set into the prior manifest (union by dst, declared
// wins). Used when --only scoped the run: only the named sections re-declared, so the
// other sections' ownership must be preserved rather than dropped.
function mergeManifest(prior: readonly ManifestEntry[], declared: readonly ManifestEntry[]): ManifestEntry[] {
  const byDst = new Map<string, ManifestEntry>();
  for (const e of prior) byDst.set(e.dst, e);
  for (const e of declared) byDst.set(e.dst, e);
  return [...byDst.values()];
}

async function reapOrphans(ctx: ReconcileCtx, prior: readonly ManifestEntry[]): Promise<void> {
  const declared = new Set(ctx.declared.map((e) => e.dst));
  let shown = false;
  const head = (): void => {
    if (!shown) {
      ctx.report.header("Orphans");
      shown = true;
    }
  };
  const reap = async (dst: string, disp: string, why: string): Promise<void> => {
    head();
    if (ctx.verb === "verify") ctx.report.warn(`${disp} ${why} — botu fix to reap`);
    else if (ctx.dryRun) ctx.report.note(`would reap ${disp}`);
    else {
      await rm(dst, { force: true });
      ctx.report.ok(`reaped orphan ${disp}`);
    }
  };

  for (const entry of prior) {
    if (declared.has(entry.dst)) continue;
    const disp = displayPath(entry.dst, ctx.env);
    if (entry.kind === "copy") {
      // A copy is a regular file with no link target; only reap it when it still
      // byte-matches the source botu wrote, so a file the user has since edited (or
      // whose source is gone) is left in place rather than silently deleted.
      if (!(await pathExists(entry.dst))) continue;
      if (entry.src && (await filesEqual(entry.dst, entry.src))) {
        await reap(entry.dst, disp, "(copy no longer declared)");
      } else {
        head();
        ctx.report.warn(`${disp} (copy no longer declared but modified/source gone — left in place)`);
      }
      continue;
    }
    const target = await linkTarget(entry.dst);
    if (!target?.startsWith(`${ctx.repo}/`)) continue; // only links into our repo
    await reap(entry.dst, disp, `→ ${target} (no longer declared)`);
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
    // Mutating verbs (apply/fix/update/uninstall): same structured envelope as verify,
    // so every reconcile verb is scriptable, not just the read-only one.
    if (json) {
      ctx.process.stdout.write(
        `${JSON.stringify({
          ok: report.failures === 0,
          warnings: report.warnings,
          failures: report.failures,
          records: report.records,
        })}\n`,
      );
      return report.failures > 0 ? 1 : 0;
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
    osx: { changed: false },
  };

  // Merge overlay files (botufile.<os|host|profile>.toml) onto the base, then gate
  // each section by its `when` (host/OS/profile) and the --only filter.
  const pc = profileContext(ctx.env, opts.profiles ?? []);
  const sections: Section[] = [...config.section];
  try {
    for (const name of overlayFiles(pc)) {
      const overlay = await loadOptionalConfigFile(join(repo, name));
      if (overlay) sections.push(...overlay.section);
    }
  } catch (e) {
    report.fail((e as Error).message);
    return finish();
  }

  if (dryRun) report.header(`${verb} — dry run (no changes)`);
  const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : undefined;
  for (const section of sections) {
    if (!sectionApplies(section, pc)) continue;
    if (only && !only.has(section.name)) continue;
    report.header(section.name);
    await reconcileSection(section, rctx);
  }

  // Reaping compares the *whole* prior manifest against what this run declared. Under
  // --only just the named sections re-declared, so every other section would look
  // orphaned — skip reaping entirely for a scoped run.
  if (verb !== "uninstall" && !only) await reapOrphans(rctx, priorManifest);

  if (mutating) {
    await journal?.commit();
    await pruneRuns(ctx.env);
    // A scoped run only knows about the sections it ran, so merge into the prior
    // manifest rather than replacing it (which would drop — and later reap — the rest).
    await writeManifest(ctx.env, only ? mergeManifest(priorManifest, rctx.declared) : rctx.declared);
  } else if (verb === "uninstall" && !dryRun) {
    await writeManifest(ctx.env, []); // uninstall clears the manifest
  }

  // Applied macOS defaults don't take effect until the owning apps restart — a
  // universal consequence of osx_default, so the engine does it (not the config).
  if (mutating && rctx.osx.changed && pc.os === "darwin") {
    report.header("macOS finalize");
    Bun.spawnSync(["killall", "Dock", "Finder", "SystemUIServer"], { stdout: "ignore", stderr: "ignore" });
    report.ok("restarted Dock/Finder/SystemUIServer (defaults changed)");
  }

  return finish();
}
