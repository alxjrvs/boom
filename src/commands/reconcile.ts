// The reconcile verbs — thin wrappers over the one engine loop (engine/reconcile.ts),
// parameterized by verb. Exit code comes from the engine (verify: 0/2/1).
import { buildCommand } from "@stricli/core";
import type { BotuContext } from "../context.ts";
import { reconcile } from "../engine/reconcile.ts";
import type { LinkMode } from "../engine/types.ts";

const parseTag = (s: string): string => s;
const onlyFlag = {
  kind: "parsed",
  parse: parseTag,
  variadic: true,
  optional: true,
  brief: "Limit to these section names",
} as const;
const profileFlag = {
  kind: "parsed",
  parse: parseTag,
  variadic: true,
  optional: true,
  brief: "Activate a profile (repeatable)",
} as const;
const jsonFlag = { kind: "boolean", optional: true, brief: "Emit a structured JSON report" } as const;

type OnlyFlags = { only?: string[]; json?: boolean; profile?: string[] };
type VerifyFlags = { only?: string[]; json?: boolean; profile?: string[] };
type ApplyFlags = {
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

export const applyCommand = buildCommand<ApplyFlags, [], BotuContext>({
  docs: { brief: "Reconcile your machine from the botufile — make it so" },
  parameters: {
    flags: {
      dryRun: { kind: "boolean", optional: true, brief: "Show what would change; change nothing" },
      skip: { kind: "boolean", optional: true, brief: "Skip conflicting targets instead of overwriting" },
      resume: { kind: "boolean", optional: true, brief: "Continue an interrupted apply (skip done steps)" },
      commit: {
        kind: "boolean",
        optional: true,
        brief: "Commit local config-repo changes before pulling, instead of autostashing them",
      },
      message: {
        kind: "parsed",
        parse: parseTag,
        optional: true,
        brief: 'Commit message for --commit (default: "botu: local changes")',
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
    this.process.exitCode = await reconcile("apply", this, {
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

export const verifyCommand = buildCommand<VerifyFlags, [], BotuContext>({
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

export const repairCommand = buildCommand<OnlyFlags, [], BotuContext>({
  docs: { brief: "Repair drift (apply, overwriting conflicts)" },
  parameters: { flags: { only: onlyFlag, profile: profileFlag, json: jsonFlag } },
  async func(flags) {
    this.process.exitCode = await reconcile("repair", this, {
      only: flags.only,
      json: flags.json,
      profiles: flags.profile,
    });
  },
});

export const uninstallCommand = buildCommand<{ dryRun?: boolean; json?: boolean }, [], BotuContext>({
  docs: { brief: "Remove everything botu installed" },
  parameters: {
    flags: {
      dryRun: { kind: "boolean", optional: true, brief: "Show what would be removed; remove nothing" },
      json: jsonFlag,
    },
  },
  async func(flags) {
    this.process.exitCode = await reconcile("uninstall", this, { dryRun: flags.dryRun, json: flags.json });
  },
});
