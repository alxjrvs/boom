// `boom plan` — a read-only preview of what a sync would change, as a first-class verb rather
// than a flag on `source`. It runs the *same* reconcile walk in dry-run (so it can never drift
// from what a real sync does), projected as `~ would …` plan lines grouped by category. `--fix`
// previews the drift-repair sync instead — surfacing the exact set of conflicting, non-boom-owned
// files that an overwrite would replace, which the default safe plan reports only as "skipped".
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { reconcile } from "../engine/reconcile.ts";
import { jsonFlag, onlyFlag, profileFlag, verboseFlag } from "./flags.ts";

export const planCommand = buildCommand<
  { fix?: boolean; only?: string[]; profile?: string[]; json?: boolean; verbose?: boolean },
  [],
  BoomContext
>({
  docs: { brief: "Preview what a sync would change — a read-only plan (--fix previews drift repair)" },
  parameters: {
    flags: {
      fix: {
        kind: "boolean",
        optional: true,
        brief: "Preview a drift-repair sync: show which conflicting files an overwrite would replace",
      },
      only: onlyFlag,
      profile: profileFlag,
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  async func(flags) {
    // Dry-run sync == the plan: mutating=false, so no lock/journal/writes — just the projection.
    // linkMode "overwrite" under --fix makes conflicts read as "would overwrite" instead of
    // "would be skipped", which is precisely the drift-repair preview.
    this.process.exitCode = await reconcile("sync", this, {
      dryRun: true,
      linkMode: flags.fix ? "overwrite" : "skip",
      only: flags.only,
      profiles: flags.profile,
      json: flags.json,
      verbose: flags.verbose,
      command: "plan",
    });
  },
});
