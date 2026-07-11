import type { Reporter } from "../lib/reporter.ts";
import type { Journal } from "./journal.ts";
import type { ManifestEntry } from "./state.ts";

export type Verb = "apply" | "verify" | "repair" | "uninstall";
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
  // Gates brewfile's `--no-upgrade`: apply/repair reconcile declared state only,
  // `apply --upgrade` opts into upgrading outdated formulae too. Casks are unaffected
  // either way — Homebrew Bundle only upgrades a cask when its Brewfile entry sets
  // `greedy: true`, regardless of this flag.
  readonly upgrade: boolean;
  readonly env: Record<string, string | undefined>;
  readonly report: Reporter;
  // Destinations boom owns this run — populated as handlers run (drives orphan
  // reaping + the persisted manifest).
  readonly declared: ManifestEntry[];
  // Transaction state (present for mutating apply/repair runs):
  readonly journal?: Journal;
  readonly backupRoot?: string;
  readonly resumeDone?: ReadonlySet<string>;
  // Mutable cell: set when any osx_default changed, so apply can restart the UI.
  readonly osx: { changed: boolean };
}
