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

type OnlyFlags = { only?: string[] };
type ApplyFlags = { dryRun?: boolean; force?: boolean; skip?: boolean; only?: string[] };

function linkModeOf(flags: { force?: boolean; skip?: boolean }): LinkMode {
  if (flags.force) return "overwrite";
  if (flags.skip) return "skip";
  return "interactive";
}

export const applyCommand = buildCommand<ApplyFlags, [], BotuContext>({
  docs: { brief: "Reconcile your machine from the botufile — make it so" },
  parameters: {
    flags: {
      dryRun: { kind: "boolean", optional: true, brief: "Show what would change; change nothing" },
      force: { kind: "boolean", optional: true, brief: "Overwrite conflicting targets" },
      skip: { kind: "boolean", optional: true, brief: "Skip conflicting targets" },
      only: onlyFlag,
    },
    aliases: { f: "force", s: "skip" },
  },
  async func(flags) {
    this.process.exitCode = await reconcile("apply", this, {
      only: flags.only,
      dryRun: flags.dryRun,
      linkMode: linkModeOf(flags),
    });
  },
});

export const verifyCommand = buildCommand<OnlyFlags, [], BotuContext>({
  docs: { brief: "Check for drift — exit 0 ok / 2 warn / 1 fail" },
  parameters: { flags: { only: onlyFlag } },
  async func(flags) {
    this.process.exitCode = await reconcile("verify", this, { only: flags.only });
  },
});

export const fixCommand = buildCommand<OnlyFlags, [], BotuContext>({
  docs: { brief: "Repair drift (apply, overwriting conflicts)" },
  parameters: { flags: { only: onlyFlag } },
  async func(flags) {
    this.process.exitCode = await reconcile("fix", this, { only: flags.only });
  },
});

export const updateCommand = buildCommand<OnlyFlags, [], BotuContext>({
  docs: { brief: "Apply with upgrades (apply --upgrade)" },
  parameters: { flags: { only: onlyFlag } },
  async func(flags) {
    this.process.exitCode = await reconcile("apply", this, { only: flags.only });
  },
});

export const uninstallCommand = buildCommand<{ dryRun?: boolean }, [], BotuContext>({
  docs: { brief: "Remove everything botu installed" },
  parameters: {
    flags: {
      dryRun: { kind: "boolean", optional: true, brief: "Show what would be removed; remove nothing" },
    },
  },
  async func(flags) {
    this.process.exitCode = await reconcile("uninstall", this, { dryRun: flags.dryRun });
  },
});
