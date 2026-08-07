import type { ProfileContext } from "../config/profile.ts";
import type { Reporter } from "../lib/reporter.ts";
import type { Journal } from "./journal.ts";
import type { ManifestEntry } from "./state.ts";

export type Verb = "sync" | "verify" | "uninstall";
export type LinkMode = "overwrite" | "skip";

// Shared state threaded through every resource handler for one reconcile run.
export interface ReconcileCtx {
  readonly repo: string;
  readonly verb: Verb;
  readonly dryRun: boolean;
  // JSON output mode: resources keep their child-process stdout off the parent's
  // stdout so the only thing there is the structured envelope.
  readonly json: boolean;
  readonly linkMode: LinkMode;
  // Gates brewfile's `--no-upgrade`: sync reconciles declared state only,
  // `boom source --update` opts into upgrading outdated formulae too — and outdated *casks*,
  // `greedy` or not (see resources/packages.ts; a cask upgrade is the arm that needs sudo).
  readonly update: boolean;
  // Verbose run: a spawned tool's chatter streams straight to the terminal. Quiet (the default)
  // silences it under the section band, so noisy resources (brew/mise, `run` steps) branch on it.
  readonly verbose: boolean;
  readonly env: Record<string, string | undefined>;
  // The boomfile's top-level `[vars]` table — the substitution source for the `tmpl` resource.
  // Empty when the boomfile declares none.
  readonly vars: Record<string, string>;
  // The run's os/host/profile gate, computed once for section gating and carried rather than
  // re-derived. A resource (or a hook) that reached for `process.platform` instead would silently
  // lose the `--profile` list — it lives only in the CLI opts — and ignore the BOOM_OS/BOOM_HOST
  // overrides that are what make profiles testable at all.
  readonly profile: ProfileContext;
  readonly report: Reporter;
  // Destinations boom owns this run — populated as handlers run (drives orphan
  // reaping + the persisted manifest).
  readonly declared: ManifestEntry[];
  // Set by a handler that could not enumerate everything it owns — today only `hook`, when the
  // module is missing or won't load. Reaping deletes whatever the prior manifest holds and
  // `declared` doesn't, so a run with a hole in `declared` would reap the missing hook's files:
  // an error path turned into a deletion path. Reconcile treats this exactly like `--only`
  // (skip the reap, merge into the prior manifest instead of replacing it), because it is the
  // same fact — this run does not know the full ownership set. Mutable by design; every handler
  // may raise it, nothing lowers it.
  ownershipIncomplete: boolean;
  // Transaction state (present for a mutating sync run):
  readonly journal?: Journal;
  readonly backupRoot?: string;
  // Resources mark themselves here when they make a change that needs an end-of-run
  // finalize (e.g. osx adds "osx" after a `defaults write`, so finalizeOsx knows to
  // restart the UI). Generic so no single resource's state leaks into the shared ctx.
  readonly dirty: Set<string>;
}
