// The reconcile core: load + validate the config, run each section under a verb, reap
// orphaned links, and return the exit code (verify: 0/2/1; mutating verbs: 0/1). For
// sync it opens a transaction journal (+ backups) so the run is recoverable and
// resumable, and persists the manifest of owned destinations.
import { join } from "node:path";
import { type Composition, composeConfig } from "../config/compose.ts";
import { loadConfig, NO_CONFIG_REPO_MSG, resolveConfigDir } from "../config/load.ts";
import { profileContext, sectionApplies } from "../config/profile.ts";
import type { Boomfile } from "../config/schema.ts";
import type { BoomContext } from "../context.ts";
import { displayPath, filesEqual, linkTarget, pathExists } from "../lib/fs.ts";
import { acquireLock } from "../lib/lock.ts";
import { backupsDir } from "../lib/paths.ts";
import { bandsReporter } from "../lib/reporter.ts";
import { Journal, journalRemove, newRunId, pruneRuns, readRun } from "./journal.ts";
import { finalizeResources, reconcileSection } from "./registry.ts";
import { applyBoomSettings } from "./settings.ts";
import { byDst, type ManifestEntry, readManifest, writeManifest } from "./state.ts";
import { syncConfigRepo } from "./sync.ts";
import type { LinkMode, ReconcileCtx, Verb } from "./types.ts";

// The grey opening band, per verb — the bombastic "we're getting to work" splash the cosmic-bands
// output opens on (high-energy, no comic-lore proper nouns). Keyed by verb; the verdict band's
// label comes from the command name instead (SOURCE/VERIFY/…).
const SETUP_COPY: Record<Verb, string> = {
  sync: "PREPARING FOR THE WORLD THAT'S COMING…",
  verify: "SCANNING THE MACHINE FOR DRIFT…",
  uninstall: "UNMAKING WHAT WAS MADE…",
};

interface ReconcileOptions {
  readonly only?: string[];
  readonly dryRun?: boolean;
  readonly linkMode?: LinkMode;
  readonly json?: boolean;
  readonly resume?: boolean;
  readonly profiles?: string[];
  // Show every line, including the `skip` no-ops and empty-section headers quiet mode holds
  // back (what `boom source --verbose` sets). Default false — quiet, the legible steady-state
  // output. Independent of `json`, which suppresses all human output regardless.
  readonly verbose?: boolean;
  // The command name the verdict band echoes (`SOURCE...COMPLETE!`) — the user-facing spelling
  // of the invocation, which can differ from the verb (`boom source` runs the sync verb).
  // Every CLI caller passes it; the engine tests lean on the verb.
  readonly command?: string;
  // Only consulted for verb "sync": commit local config-repo changes before
  // pulling, instead of the default autostash.
  readonly commit?: boolean;
  readonly commitMessage?: string;
}

// Merge a partial run's declared set into the prior manifest (union by dst, declared
// wins). Used whenever `declared` is known to be incomplete — --only scoped the run to some
// sections, or a hook couldn't be loaded to state what it owns — so the un-redeclared
// ownership is preserved rather than dropped (and silently reaped on a later run).
function mergeManifest(prior: readonly ManifestEntry[], declared: readonly ManifestEntry[]): ManifestEntry[] {
  return byDst([...prior, ...declared]);
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
    if (ctx.verb === "verify") ctx.report.warn(`${disp} ${why} — boom source reaps it`);
    else if (ctx.dryRun) ctx.report.plan(`would reap ${disp}`);
    else {
      // Same transaction as every other mutation here: journaled with a backup, so a reaped
      // file lands in the run's backup tree with a row naming it, instead of the deletion
      // being a silent, un-undoable side effect outside the run's safety net.
      await journalRemove("reap", dst, ctx);
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
    if (target === undefined) continue; // not a symlink — nothing to reap
    // Match against the exact source the manifest recorded — never a `startsWith(repo)` test,
    // which would claim any symlink into the repo, including ones boom did not place.
    if (target !== entry.src) continue;
    await reap(entry.dst, disp, `→ ${target} (no longer declared)`);
  }
}

export async function reconcile(verb: Verb, ctx: BoomContext, opts: ReconcileOptions): Promise<number> {
  const json = opts.json ?? false;
  const verbose = opts.verbose ?? false;
  // Human runs get the cosmic-bands surface; --json stays on the structured envelope. `category`
  // groups the dense default by distinct category (DOTFILES/PACKAGES/…) instead of one band per
  // section — it only diverges when quiet, so --verbose keeps the per-section firehose.
  const report = bandsReporter(ctx.process, ctx.env, opts.command ?? verb, {
    json,
    verbose,
    surface: "category",
  });
  // Every line until a section resource (or a later phase) sets its own category lands under
  // CONFIG — including the config-repo sync below and any early bail-out failure.
  report.category = "CONFIG";

  const finish = (): number => {
    // The same structured envelope for every verb (verify carries a warning tier, mutating
    // verbs are 0/1), shared with doctor/validate via Reporter.finishJson.
    if (json) return report.finishJson(ctx.process.stdout, verb === "verify");
    // Human output: the shared Reporter epilogue owns the blank line + 0/2/1 mapping + elapsed.
    // verify has a warning tier; the mutating verbs (sync/uninstall) do not.
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
  // Open on the grey setup band (bands mode only; a no-op in --json), before any section.
  report.setup(SETUP_COPY[verb]);
  const dryRun = opts.dryRun ?? false;

  // `mutating` is narrower than "changes the machine": it also gates the journal, the backup
  // tree, none of which any verb but sync opens. The LOCK is a different
  // question — who writes — so it gets its own predicate. An unlocked `uninstall` racing a
  // scheduled sync removes destinations that sync is re-creating, and both call `writeManifest`,
  // which is a full DELETE+reinsert: exactly the ownership-losing race lib/lock.ts's header
  // describes, reachable today by a launchd sync overlapping a manual teardown.
  const mutating = verb === "sync" && !dryRun;
  const writes = !dryRun && verb !== "verify";

  // Taken BEFORE syncConfigRepo, which is itself a mutation of shared state: the sync verb's
  // `git pull --rebase --autostash` rewrites the managed clone's working tree and, on failure,
  // runs `git rebase --abort`. Two unserialized runs — the daily scheduled sync overlapping a
  // manual one — meant the second process's abort could tear down the FIRST one's in-flight
  // rebase and pop its autostash. The lock used to start after this call, so the one git
  // operation that rewrites the config repo was the one thing it did not cover.
  // A live holder is a clean failure; a stale lock from a crashed run is reclaimed
  // (see lib/lock.ts).
  let releaseLock: (() => void) | undefined;
  if (writes) {
    try {
      releaseLock = acquireLock(ctx.env);
    } catch (e) {
      report.fail((e as Error).message);
      return finish();
    }
  }

  let journal: Journal | undefined;
  try {
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
    let backupRoot: string | undefined;
    // `writes`, not `mutating`: uninstall is the most destructive verb boom has, so it gets the
    // journal and the backup tree too — every removal is recorded and recoverable, not permanent.
    // Nothing about the machinery is sync-specific.
    if (writes) {
      let runId = newRunId();
      // --resume continues INTO the interrupted run — reuse its id and backup dir — rather
      // than opening a fresh run. A fresh run would leave the interrupted pass's displaced
      // originals attached to the OLD run's rows: invisible to every reader that takes the
      // latest run, and reapable by prune. Only an uncommitted (genuinely interrupted) run
      // is resumable; a committed one has nothing to resume, so fall through to a new run.
      // Re-application itself needs no journal-based skip list: reconcile is naturally
      // idempotent (an already-correct link/copy is skipped by the reality checks in
      // filesystem.ts), so resume just re-runs and only touches what isn't already in place.
      // Sync only: `--resume` continues an interrupted *sync*. An uninstall must never adopt a
      // prior sync's run id, or its removals would be appended to that run's rows, leaving one
      // run that claims to have both created and destroyed the same destinations.
      if (opts.resume && verb === "sync") {
        const prior = await readRun(ctx.env);
        if (prior && !prior.committed) runId = prior.runId;
      }
      journal = new Journal(ctx.env, runId);
      // Derived here, CREATED lazily by backupTo (lib/fs.ts) on the first displace — which is
      // also where its 0700 mode is set. Deliberately nothing eager here: most runs displace
      // nothing and would be left with an empty directory, and re-permissioning a path that
      // does not exist yet throws ENOENT inside a try/finally that has no catch, taking every
      // mutating sync down with it. Create-then-own or nothing — so if you ever do add an eager
      // mkdir here it must carry `{ recursive: true, mode: 0o700 }`; the tree can hold a
      // displaced 0600 file.
      backupRoot = join(backupsDir(ctx.env), runId);
    }
    const priorManifest = await readManifest(ctx.env);

    // Compose the base boomfile + the overlay files that match this machine into ONE ordered,
    // source-stamped section list plus the merged `[vars]`/`[boom]` tables. Above the rctx
    // literal deliberately: it reads from the composition, so `vars` carries the overlay's
    // per-machine values.
    const pc = profileContext(ctx.env, opts.profiles ?? []);
    let composition: Composition;
    try {
      composition = await composeConfig(ctx.env, repo, config, pc, report);
    } catch (e) {
      report.fail((e as Error).message);
      return finish();
    }

    // `[boom].sudo_askpass` is retired but still parses, so a boomfile carrying it keeps
    // loading rather than failing over a key whose replacement is an environment variable. Say
    // so on a mutating run, which is the only kind that could have escalated: silently doing
    // nothing here would turn a configured machine's unattended sync into an invisible hang at a
    // sudo prompt, which is the exact failure the key existed to prevent.
    if (composition.boom?.sudo_askpass && mutating) {
      report.warn(
        "[boom].sudo_askpass is retired and ignored — boom no longer resolves a sudo password " +
          "from the vault. Export SUDO_ASKPASS yourself if this run must escalate unattended; " +
          "boom still honours an inherited one. Remove the key to silence this.",
      );
    }

    // `secret` is retired but still parses, for the same reason and with the same shape. Warned
    // on EVERY verb, not just a mutating one: a declaration that no longer renders means the
    // file at `dst` is now whatever it was before boom stopped touching it, and a `verify` that
    // reported "all clear" while silently ignoring a declared secret would be the more dangerous
    // half. Counted rather than listed — a `dst` is a path, and paths to secret material are
    // exactly what should not be echoed into a transcript.
    const retiredSecrets = composition.sections.reduce((n, sec) => n + (sec.secret?.length ?? 0), 0);
    if (retiredSecrets > 0) {
      report.warn(
        `${retiredSecrets} \`secret\` declaration(s) are retired and ignored — boom no longer ` +
          "renders a vault value to a file. Resolve it at point of use instead (`op run " +
          "--env-file=F -- CMD`), or render it with a `run` step you own. See CHANGELOG.md#0370.",
      );
    }

    const rctx: ReconcileCtx = {
      repo,
      verb,
      dryRun,
      json,
      // Safe by default: never clobber a file boom doesn't own. `boom source --fix` sets
      // "overwrite" to repair drift; `boom source set` (no linkMode) inherits this skip.
      linkMode: opts.linkMode ?? "skip",
      verbose,
      env: ctx.env,
      vars: composition.vars,
      // The same `pc` the section gate below keys on — carried, not recomputed, so a resource
      // never has to re-derive the run's os/host/profiles (and lose --profile doing it).
      profile: pc,
      report,
      declared: [],
      ownershipIncomplete: false,
      journal,
      backupRoot,
      dirty: new Set<string>(),
    };

    // Eager: a dry run's plan lines all read "would …", but the run-level banner still states
    // outright that nothing changed — print it even when quiet mode holds section headers back.
    if (dryRun) report.header(`${verb} — dry run (no changes)`, true);
    const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : undefined;
    // Composed order is precedence order (base → overlays); each section still gates on its own
    // `when` (host/OS/profile) and the --only filter.
    for (const section of composition.sections) {
      if (!sectionApplies(section, pc)) continue;
      if (only && !only.has(section.name)) continue;
      report.header(section.name);
      await reconcileSection(section, rctx);
    }

    // Reaping compares the *whole* prior manifest against what this run declared. Under
    // --only just the named sections re-declared, so every other section would look
    // orphaned — skip reaping entirely for a scoped run. `ownershipIncomplete` is the same
    // fact arrived at the hard way (a hook that couldn't be loaded never declared), and it
    // gets the same treatment: reaping on a partial `declared` deletes the files of whatever
    // failed, which is the one thing an error must never do. Say so out loud — a silently
    // skipped reap is indistinguishable from having nothing to reap.
    if (verb !== "uninstall" && !only) {
      report.category = "ORPHANS";
      if (rctx.ownershipIncomplete)
        report.note("orphan reaping skipped — a resource above could not report what it owns");
      else await reapOrphans(rctx, priorManifest);
    }

    if (mutating) {
      await pruneRuns(ctx.env);
      // A scoped run only knows about the sections it ran, so merge into the prior
      // manifest rather than replacing it (which would drop — and later reap — the rest).
      // A run with an unloadable hook is in the same position: replacing the manifest there
      // would drop the hook's entries and hand the deletion to the NEXT run instead of this one.
      const partial = Boolean(only) || rctx.ownershipIncomplete;
      await writeManifest(ctx.env, partial ? mergeManifest(priorManifest, rctx.declared) : rctx.declared);
    } else if (verb === "uninstall" && !dryRun) {
      await writeManifest(ctx.env, []); // uninstall clears the manifest
    }

    // The top-level `[boom]` table: machine-global self-wiring (skill refresh, release check,
    // drift notify) folded into the reconcile. Skipped for a `--only` scoped run —
    // it targets named sections, and these global behaviors aren't a section. Guarded like a
    // resource: an unexpected throw becomes a reported failure, never an unwound run.
    if (!only) {
      report.category = "SELF-WIRING";
      try {
        await applyBoomSettings(composition.boom, rctx);
      } catch (e) {
        report.fail(`boom settings: ${(e as Error).message}`);
      }
    }

    // End-of-run finalize hooks (each self-gates): the seam where a resource acts on its own
    // accumulated state — e.g. osx restarts Dock/Finder/SystemUIServer once, iff a default
    // actually changed — instead of the core loop reaching into a resource-specific flag.
    await finalizeResources(rctx);

    // Mark committed only when the run actually succeeded (zero failures) — and only HERE, past
    // the last phase that can still report one. `applyBoomSettings` and `finalizeResources` both
    // can; deciding above them journals a run whose self-wiring failed as clean, which is the
    // precise mislabelling `committed` exists to prevent, and it is also what `--resume`
    // reads to find an interrupted run.
    if (writes && report.failures === 0) journal?.markCommitted();

    return finish();
  } finally {
    // Always release the DB handle and the lock, even on an early return (e.g. a malformed
    // overlay) — the open WAL connection used to leak for the process lifetime.
    journal?.close();
    releaseLock?.();
  }
}
