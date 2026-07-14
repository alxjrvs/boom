import type { Reporter } from "../lib/reporter.ts";
import type { Journal } from "./journal.ts";
import type { ManifestEntry } from "./state.ts";

export type Verb = "sync" | "verify" | "fix" | "uninstall";
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
  // Gates brewfile's `--no-upgrade`: sync/fix reconcile declared state only,
  // `boom source --upgrade` opts into upgrading outdated formulae too. Casks are unaffected
  // either way — Homebrew Bundle only upgrades a cask when its Brewfile entry sets
  // `greedy: true`, regardless of this flag.
  readonly upgrade: boolean;
  readonly env: Record<string, string | undefined>;
  readonly report: Reporter;
  // Destinations boom owns this run — populated as handlers run (drives orphan
  // reaping + the persisted manifest).
  readonly declared: ManifestEntry[];
  // Transaction state (present for mutating sync/fix runs):
  readonly journal?: Journal;
  readonly backupRoot?: string;
  // Resources mark themselves here when they make a change that needs an end-of-run
  // finalize (e.g. osx adds "osx" after a `defaults write`, so finalizeOsx knows to
  // restart the UI). Generic so no single resource's state leaks into the shared ctx.
  readonly dirty: Set<string>;
}
