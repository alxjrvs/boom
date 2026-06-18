// Section dispatch in phase order: link → copy → glob → packages → run → hook.
// Phase order (rather than file order) is the deterministic replacement for the bash
// engine's source-order execution.
import type { Section } from "../config/schema.ts";
import { reconcileCopy, reconcileGlob, reconcileLink } from "./resources/filesystem.ts";
import { reconcileHook } from "./resources/hook.ts";
import { reconcileOsxDefault } from "./resources/osx.ts";
import { reconcileBrewfile, reconcileMise } from "./resources/packages.ts";
import { reconcileRun } from "./resources/run.ts";
import type { ReconcileCtx } from "./types.ts";

export async function reconcileSection(section: Section, ctx: ReconcileCtx): Promise<void> {
  // Per-resource error boundary: an unexpected throw (EACCES, ENOSPC, a glob error)
  // becomes a reported failure and the run continues to a clean finish + commit
  // decision, instead of unwinding the whole loop with a stack trace.
  const guard = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      ctx.report.fail(`${label}: ${(e as Error).message}`);
    }
  };

  for (const e of section.link ?? []) await guard(`link ${e.dst}`, () => reconcileLink(e, ctx));
  for (const e of section.copy ?? []) await guard(`copy ${e.dst}`, () => reconcileCopy(e, ctx));
  for (const e of section.glob ?? []) await guard(`glob ${e.pattern}`, () => reconcileGlob(e, ctx));
  const brewfile = section.brewfile;
  if (brewfile) await guard("brewfile", () => reconcileBrewfile(brewfile, ctx));
  if (section.mise) await guard("mise", () => reconcileMise(ctx));
  for (const e of section.osx_default ?? [])
    await guard(`osx ${e.domain} ${e.key}`, () => reconcileOsxDefault(e, ctx));
  for (const e of section.run ?? []) await guard("run", () => reconcileRun(e, ctx));
  for (const e of section.hook ?? []) await guard(`hook ${e.name}`, () => reconcileHook(e, ctx));
}
