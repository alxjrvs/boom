// The reconcile core: load + validate the config, run each section under a verb, reap
// orphaned links, and return the exit code (verify: 0/2/1; mutating verbs: 0/1). For
// sync/repair it opens a transaction journal (+ backups) so the run is rollback-able and
// resumable, and persists the manifest of owned destinations.
import { join } from "node:path";
import { loadConfig, loadOptionalConfigFile, NO_CONFIG_REPO_MSG, resolveConfigDir } from "../config/load.ts";
import { overlayFiles, profileContext, sectionApplies } from "../config/profile.ts";
import type { Boomfile, Section } from "../config/schema.ts";
import type { BoomContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { displayPath, filesEqual, linkTarget, pathExists } from "../lib/fs.ts";
import { acquireLock } from "../lib/lock.ts";
import { REPORT_SCHEMA_VERSION, Reporter } from "../lib/reporter.ts";
import { displace, Journal, newRunId, pruneRuns, readRun } from "./journal.ts";
import { finalizeResources, reconcileSection } from "./registry.ts";
import { backupsDir, type ManifestEntry, readManifest, writeManifest } from "./state.ts";
import { syncConfigRepo } from "./sync.ts";
import type { LinkMode, ReconcileCtx, Verb } from "./types.ts";

// Re-exported (the envelope shape lives in reporter.ts now) so existing importers of the
// reconcile module's constant keep working.
export { REPORT_SCHEMA_VERSION };

export interface ReconcileOptions {
  readonly only?: string[];
  readonly dryRun?: boolean;
  readonly linkMode?: LinkMode;
  readonly json?: boolean;
  readonly resume?: boolean;
  readonly profiles?: string[];
  // Only consulted for verb "sync"/"repair": commit local config-repo changes before
  // pulling, instead of the default autostash.
  readonly commit?: boolean;
  readonly commitMessage?: string;
  // Only consulted for verb "sync"/"repair": also upgrade outdated brewfile formulae
  // (what `boom source --upgrade` sets). Default false — plain sync reconciles declared
  // state, it doesn't force package upgrades as a side effect.
  readonly upgrade?: boolean;
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
    if (ctx.verb === "verify") ctx.report.warn(`${disp} ${why} — boom repair to reap`);
    else if (ctx.dryRun) ctx.report.note(`would reap ${disp}`);
    else {
      // Same transaction as every other mutation here: journaled with a backup, so
      // `boom rollback` can restore a reaped file instead of the deletion being a
      // silent, un-undoable side effect outside the run's safety net.
      await ctx.journal?.intent("reap", dst);
      const undo = await displace(dst, ctx.backupRoot);
      await ctx.journal?.done("reap", dst, undo);
      ctx.report.ok(`reaped orphan ${disp}`);
    }
  };

  for (const entry of prior) {
    if (declared.has(entry.dst)) continue;
    const disp = displayPath(entry.dst, ctx.env);
    if (entry.kind === "copy") {
      // A copy is a regular file with no link target; only reap it when it still
      // byte-matches the source boom wrote, so a file the user has since edited (or
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

export async function reconcile(verb: Verb, ctx: BoomContext, opts: ReconcileOptions): Promise<number> {
  const json = opts.json ?? false;
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env), json);

  const finish = (): number => {
    // The same structured envelope for every verb (verify carries a warning tier, mutating
    // verbs are 0/1), shared with doctor/validate via Reporter.finishJson.
    if (json) return report.finishJson(ctx.process.stdout, verb === "verify");
    // Human output: the shared Reporter epilogue owns the blank line + 0/2/1 mapping.
    // verify has a warning tier; the mutating verbs (sync/repair/uninstall) do not.
    return verb === "verify"
      ? report.finish({
          ok: "verify: all checks passed",
          warn: (w) => `verify: ${w} warning(s)`,
          fail: (f, w) => `verify: ${f} failure(s), ${w} warning(s)`,
        })
      : report.finish({ ok: `${verb} done`, fail: (f) => `${verb}: ${f} failure(s)` });
  };

  const repo = await resolveConfigDir(ctx.env, ctx.cwd);
  if (!repo) {
    report.fail(NO_CONFIG_REPO_MSG);
    return finish();
  }
  const dryRun = opts.dryRun ?? false;
  await syncConfigRepo(repo, ctx.env, report, verb, dryRun, {
    commit: opts.commit,
    commitMessage: opts.commitMessage,
  });
  let config: Boomfile;
  try {
    config = await loadConfig(repo);
  } catch (e) {
    report.fail((e as Error).message);
    return finish();
  }

  const mutating = (verb === "sync" || verb === "repair") && !dryRun;

  // A mutating run holds an exclusive lock: two concurrent sync/repair runs would race on
  // the same destinations and clobber each other's manifest. A live holder is a clean
  // failure; a stale lock from a crashed run is reclaimed (see lib/lock.ts).
  let releaseLock: (() => void) | undefined;
  if (mutating) {
    try {
      releaseLock = acquireLock(ctx.env);
    } catch (e) {
      report.fail((e as Error).message);
      return finish();
    }
  }

  let journal: Journal | undefined;
  try {
    let backupRoot: string | undefined;
    if (mutating) {
      let runId = newRunId();
      // --resume continues INTO the interrupted run — reuse its id and backup dir — rather
      // than opening a fresh run. A fresh run would leave the interrupted pass's displaced
      // originals attached to the OLD run's rows: invisible to `rollback` (which reads the
      // latest run) and reapable by prune. Only an uncommitted (genuinely interrupted) run
      // is resumable; a committed one has nothing to resume, so fall through to a new run.
      // Re-application itself needs no journal-based skip list: reconcile is naturally
      // idempotent (an already-correct link/copy is skipped by the reality checks in
      // filesystem.ts), so resume just re-runs and only touches what isn't already in place.
      if (opts.resume) {
        const prior = await readRun(ctx.env);
        if (prior && !prior.committed) runId = prior.runId;
      }
      journal = new Journal(ctx.env, runId);
      backupRoot = join(backupsDir(ctx.env), runId);
    }
    const priorManifest = await readManifest(ctx.env);

    const rctx: ReconcileCtx = {
      repo,
      verb,
      dryRun,
      json,
      linkMode: opts.linkMode ?? "overwrite",
      upgrade: opts.upgrade ?? false,
      env: ctx.env,
      report,
      declared: [],
      journal,
      backupRoot,
      dirty: new Set<string>(),
    };

    // Merge overlay files (boomfile.<os|host|profile>.toml) onto the base, then gate
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
      // Mark committed only when the run actually succeeded (zero failures). A run that
      // reached the end with failed items stays committed=0 so `rollback --list` flags it
      // as needing attention rather than mislabelling a half-applied run as clean.
      if (report.failures === 0) journal?.markCommitted();
      await pruneRuns(ctx.env);
      // A scoped run only knows about the sections it ran, so merge into the prior
      // manifest rather than replacing it (which would drop — and later reap — the rest).
      await writeManifest(ctx.env, only ? mergeManifest(priorManifest, rctx.declared) : rctx.declared);
    } else if (verb === "uninstall" && !dryRun) {
      await writeManifest(ctx.env, []); // uninstall clears the manifest
    }

    // End-of-run finalize hooks (each self-gates): the seam where a resource acts on its own
    // accumulated state — e.g. osx restarts Dock/Finder/SystemUIServer once, iff a default
    // actually changed — instead of the core loop reaching into a resource-specific flag.
    await finalizeResources(rctx);

    return finish();
  } finally {
    // Always release the DB handle and the lock, even on an early return (e.g. a malformed
    // overlay) — the open WAL connection used to leak for the process lifetime.
    journal?.close();
    releaseLock?.();
  }
}
