// The reconcile verbs — thin wrappers over the one engine loop (engine/reconcile.ts),
// parameterized by verb. Exit code comes from the engine (verify: 0/2/1).
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

type OnlyFlags = { only?: string[]; json?: boolean; profile?: string[] };
type VerifyFlags = { only?: string[]; json?: boolean; profile?: string[] };
type SyncFlags = {
  dryRun?: boolean;
  skip?: boolean;
  resume?: boolean;
  json?: boolean;
  only?: string[];
  profile?: string[];
  commit?: boolean;
  message?: string;
  upgrade?: boolean;
};

// overwrite is the default — --skip is the one way to opt out of clobbering a
// conflicting target.
function linkModeOf(flags: { skip?: boolean }): LinkMode {
  return flags.skip ? "skip" : "overwrite";
}

export const syncCommand = buildCommand<SyncFlags, [], BoomContext>({
  docs: { brief: "Reconcile your machine from the boomfile — make it so" },
  parameters: {
    flags: {
      dryRun: { kind: "boolean", optional: true, brief: "Show what would change; change nothing" },
      skip: { kind: "boolean", optional: true, brief: "Skip conflicting targets instead of overwriting" },
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
      upgrade: {
        kind: "boolean",
        optional: true,
        brief: "Also upgrade outdated brewfile formulae, not just reconcile declared state",
      },
      only: onlyFlag,
      profile: profileFlag,
      json: jsonFlag,
    },
    aliases: { s: "skip", m: "message" },
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
      upgrade: flags.upgrade,
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

export const repairCommand = buildCommand<OnlyFlags & { dryRun?: boolean }, [], BoomContext>({
  docs: { brief: "Repair drift (sync, overwriting conflicts)" },
  parameters: {
    flags: {
      dryRun: { kind: "boolean", optional: true, brief: "Show what would be repaired; change nothing" },
      only: onlyFlag,
      profile: profileFlag,
      json: jsonFlag,
    },
  },
  async func(flags) {
    this.process.exitCode = await reconcile("repair", this, {
      only: flags.only,
      dryRun: flags.dryRun,
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
