import type { Reporter } from "../lib/reporter.ts";

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
  // Destinations botu owns this run — populated as handlers run (orphan reaping +
  // the uninstall manifest build on this in M3).
  readonly declared: string[];
}
