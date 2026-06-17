// The reconcile verbs. In the bash engine these were ONE verb-parameterized loop
// (engine/run); the TS engine keeps that shape — M2 routes all of these through a
// single reconcile(verb, config) over the resource-type registry. For M0 they are
// stubs so the CLI wiring, help text, version, and aliases are exercisable.
//
// Stricli marks `parameters` as NoInfer and infers awkwardly through the `this`-typed
// command function, so we pass explicit type arguments to buildCommand<FLAGS>.
import { buildCommand } from "@stricli/core";
import type { BotuContext } from "../context.ts";

const parseTag = (s: string): string => s;
const onlyFlag = {
  kind: "parsed",
  parse: parseTag,
  variadic: true,
  optional: true,
  brief: "Limit to these section tags",
} as const;

type OnlyFlags = { only?: string[] };
type ApplyFlags = { dryRun?: boolean; force?: boolean; skip?: boolean; only?: string[] };

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
  func(flags) {
    this.process.stdout.write(`botu apply: not yet implemented (M2)${flags.dryRun ? " [dry-run]" : ""}\n`);
  },
});

export const verifyCommand = buildCommand<OnlyFlags, [], BotuContext>({
  docs: { brief: "Check for drift — exit 0 ok / 2 warn / 1 fail" },
  parameters: { flags: { only: onlyFlag } },
  func(_flags) {
    this.process.stdout.write("botu verify: not yet implemented (M2)\n");
  },
});

export const fixCommand = buildCommand<OnlyFlags, [], BotuContext>({
  docs: { brief: "Repair drift (apply, overwriting conflicts)" },
  parameters: { flags: { only: onlyFlag } },
  func(_flags) {
    this.process.stdout.write("botu fix: not yet implemented (M2)\n");
  },
});

export const updateCommand = buildCommand<OnlyFlags, [], BotuContext>({
  docs: { brief: "Apply with upgrades (apply --upgrade)" },
  parameters: { flags: { only: onlyFlag } },
  func(_flags) {
    this.process.stdout.write("botu update: not yet implemented (M2)\n");
  },
});

export const uninstallCommand = buildCommand<{ dryRun?: boolean }, [], BotuContext>({
  docs: { brief: "Remove everything botu installed" },
  parameters: {
    flags: {
      dryRun: { kind: "boolean", optional: true, brief: "Show what would be removed; remove nothing" },
    },
  },
  func(flags) {
    this.process.stdout.write(
      `botu uninstall: not yet implemented (M2)${flags.dryRun ? " [dry-run]" : ""}\n`,
    );
  },
});
