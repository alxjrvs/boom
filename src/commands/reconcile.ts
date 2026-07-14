// The reconcile verbs — thin wrappers over the one engine loop (engine/reconcile.ts),
// parameterized by verb. Exit code comes from the engine (verify: 0/2/1). There is no
// separate `fix`/`repair` verb: repairing drift is `boom source --fix`, the flag that
// forces overwrite instead of sync's safe skip-by-default.
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { reconcile } from "../engine/reconcile.ts";
import type { LinkMode } from "../engine/types.ts";
import { confirm } from "../lib/confirm.ts";
import { str } from "./flags.ts";

const onlyFlag = {
  kind: "parsed",
  parse: str,
  variadic: true,
  optional: true,
  brief: "Limit to these section names",
} as const;
const profileFlag = {
  kind: "parsed",
  parse: str,
  variadic: true,
  optional: true,
  brief: "Activate a profile (repeatable)",
} as const;
const jsonFlag = { kind: "boolean", optional: true, brief: "Emit a structured JSON report" } as const;

type VerifyFlags = { only?: string[]; json?: boolean; profile?: string[] };
type SyncFlags = {
  dryRun?: boolean;
  fix?: boolean;
  resume?: boolean;
  json?: boolean;
  only?: string[];
  profile?: string[];
  commit?: boolean;
  message?: string;
  update?: boolean;
};

// skip is the default — sync never clobbers a file boom doesn't own. --fix opts into
// overwriting conflicting targets (the drift-repair that used to be `boom fix`).
function linkModeOf(flags: { fix?: boolean }): LinkMode {
  return flags.fix ? "overwrite" : "skip";
}

export const syncCommand = buildCommand<SyncFlags, [], BoomContext>({
  docs: { brief: "Reconcile your machine from the boomfile — make it so" },
  parameters: {
    flags: {
      dryRun: { kind: "boolean", optional: true, brief: "Show what would change; change nothing" },
      fix: {
        kind: "boolean",
        optional: true,
        brief: "Repair drift: overwrite conflicting targets instead of skipping them",
      },
      resume: { kind: "boolean", optional: true, brief: "Continue an interrupted sync (skip done steps)" },
      commit: {
        kind: "boolean",
        optional: true,
        brief: "Commit local config-repo changes before pulling, instead of autostashing them",
      },
      message: {
        kind: "parsed",
        parse: str,
        optional: true,
        brief: 'Commit message for --commit (default: "boom: local changes")',
      },
      update: {
        kind: "boolean",
        optional: true,
        brief: "Also update outdated brewfile formulae, not just reconcile declared state",
      },
      only: onlyFlag,
      profile: profileFlag,
      json: jsonFlag,
    },
    aliases: { m: "message" },
  },
  async func(flags) {
    this.process.exitCode = await reconcile("sync", this, {
      only: flags.only,
      dryRun: flags.dryRun,
      resume: flags.resume,
      json: flags.json,
      profiles: flags.profile,
      linkMode: linkModeOf(flags),
      commit: flags.commit,
      commitMessage: flags.message,
      update: flags.update,
    });
  },
});

export const verifyCommand = buildCommand<VerifyFlags, [], BoomContext>({
  docs: { brief: "Check for drift — exit 0 ok / 2 warn / 1 fail" },
  parameters: {
    flags: {
      only: onlyFlag,
      profile: profileFlag,
      json: { kind: "boolean", optional: true, brief: "Emit a structured JSON drift report" },
    },
  },
  async func(flags) {
    this.process.exitCode = await reconcile("verify", this, {
      only: flags.only,
      json: flags.json,
      profiles: flags.profile,
    });
  },
});

export const uninstallCommand = buildCommand<
  { dryRun?: boolean; json?: boolean; yes?: boolean },
  [],
  BoomContext
>({
  docs: { brief: "Remove everything boom installed" },
  parameters: {
    flags: {
      dryRun: { kind: "boolean", optional: true, brief: "Show what would be removed; remove nothing" },
      yes: { kind: "boolean", optional: true, brief: "Skip the confirmation prompt (for scripts/CI)" },
      json: jsonFlag,
    },
    aliases: { y: "yes" },
  },
  async func(flags) {
    // Confirm before the real teardown (never for a dry run — it changes nothing). An
    // interactive terminal is prompted; a non-TTY without --yes now REFUSES rather than
    // silently tearing down (see lib/confirm.ts), so `echo | boom uninstall` can't wipe
    // state by accident. A --json run is machine-driven, so treat it as already-consented.
    if (
      !flags.dryRun &&
      !flags.json &&
      !confirm("boom uninstall removes everything boom installed.", { yes: flags.yes })
    ) {
      this.process.stderr.write(
        "boom: uninstall aborted — pass --yes to confirm in a non-interactive shell\n",
      );
      this.process.exitCode = 1;
      return;
    }
    this.process.exitCode = await reconcile("uninstall", this, { dryRun: flags.dryRun, json: flags.json });
  },
});
