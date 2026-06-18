import type { Reporter } from "../lib/reporter.ts";
import type { Journal } from "./journal.ts";
import type { ManifestEntry } from "./state.ts";

export type Verb = "apply" | "verify" | "fix" | "uninstall";
export type LinkMode = "interactive" | "overwrite" | "skip";

// Shared state threaded through every resource handler for one reconcile run.
export interface ReconcileCtx {
  readonly repo: string;
  readonly verb: Verb;
  readonly dryRun: boolean;
  readonly linkMode: LinkMode;
  readonly env: Record<string, string | undefined>;
  readonly report: Reporter;
  // Destinations botu owns this run — populated as handlers run (drives orphan
  // reaping + the persisted manifest).
  readonly declared: ManifestEntry[];
  // Transaction state (present for mutating apply/fix runs):
  readonly journal?: Journal;
  readonly backupRoot?: string;
  readonly resumeDone?: ReadonlySet<string>;
  // Mutable cell: set when any osx_default changed, so apply can restart the UI.
  readonly osx: { changed: boolean };
}
