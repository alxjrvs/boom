// The reconcile verbs — thin wrappers over the one engine loop (engine/reconcile.ts),
// parameterized by verb. Exit code comes from the engine (verify: 0/2/1).
import { buildCommand } from "@stricli/core";
import type { BotuContext } from "../context.ts";
import { reconcile } from "../engine/reconcile.ts";
import type { LinkMode } from "../engine/types.ts";
import { colorEnabled } from "../lib/color.ts";
import type { GitSyncMode } from "../lib/git.ts";
import { Reporter } from "../lib/reporter.ts";

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
  force?: boolean;
  skip?: boolean;
  resume?: boolean;
  json?: boolean;
  only?: string[];
  profile?: string[];
  hard?: boolean;
  commit?: boolean;
  message?: string;
};

// overwrite is the default (and what --force explicitly asks for too) — --skip is
// the one way to opt out of clobbering a conflicting target.
function linkModeOf(flags: { skip?: boolean }): LinkMode {
  return flags.skip ? "skip" : "overwrite";
}

// pull (stash → rebase → pop) is the default; --commit and --hard are the two explicit
// alternatives, and can't both apply at once.
function gitSyncModeOf(flags: { hard?: boolean; commit?: boolean }): GitSyncMode | Error {
  if (flags.hard && flags.commit) return new Error("--hard and --commit are mutually exclusive");
  if (flags.hard) return "hard";
  if (flags.commit) return "commit";
  return "pull";
}

export const applyCommand = buildCommand<ApplyFlags, [], BotuContext>({
  docs: { brief: "Reconcile your machine from the botufile — make it so" },
  parameters: {
    flags: {
      dryRun: { kind: "boolean", optional: true, brief: "Show what would change; change nothing" },
      force: { kind: "boolean", optional: true, brief: "Overwrite conflicting targets (default)" },
      skip: { kind: "boolean", optional: true, brief: "Skip conflicting targets instead of overwriting" },
      resume: { kind: "boolean", optional: true, brief: "Continue an interrupted apply (skip done steps)" },
      hard: {
        kind: "boolean",
        optional: true,
        brief: "Discard local dotfiles-repo changes; reset --hard to remote",
      },
      commit: {
        kind: "boolean",
        optional: true,
        brief: "Commit local dotfiles-repo changes, then pull --rebase",
      },
      message: {
        kind: "parsed",
        parse: parseTag,
        optional: true,
        brief: 'Commit message for --commit (default: "botu: local changes")',
      },
      only: onlyFlag,
      profile: profileFlag,
      json: jsonFlag,
    },
    aliases: { f: "force", s: "skip", m: "message" },
  },
  async func(flags) {
    const gitSync = gitSyncModeOf(flags);
    if (gitSync instanceof Error) {
      new Reporter(this.process.stdout, this.process.stderr, colorEnabled(this.env)).fail(gitSync.message);
      this.process.exitCode = 1;
      return;
    }
    this.process.exitCode = await reconcile("apply", this, {
      only: flags.only,
      dryRun: flags.dryRun,
      resume: flags.resume,
      json: flags.json,
      profiles: flags.profile,
      linkMode: linkModeOf(flags),
      gitSync,
      commitMessage: flags.message,
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

export const fixCommand = buildCommand<OnlyFlags, [], BotuContext>({
  docs: { brief: "Repair drift (apply, overwriting conflicts)" },
  parameters: { flags: { only: onlyFlag, profile: profileFlag, json: jsonFlag } },
  async func(flags) {
    this.process.exitCode = await reconcile("fix", this, {
      only: flags.only,
      json: flags.json,
      profiles: flags.profile,
    });
  },
});

export const updateCommand = buildCommand<OnlyFlags, [], BotuContext>({
  docs: { brief: "Apply with upgrades (apply --upgrade)" },
  parameters: { flags: { only: onlyFlag, profile: profileFlag, json: jsonFlag } },
  async func(flags) {
    this.process.exitCode = await reconcile("apply", this, {
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
