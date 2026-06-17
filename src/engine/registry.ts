// Section dispatch in phase order: link → copy → glob → packages → run → hook.
// Phase order (rather than file order) is the deterministic replacement for the bash
// engine's source-order execution.
import type { Section } from "../config/schema.ts";
import { reconcileCopy, reconcileGlob, reconcileLink } from "./resources/filesystem.ts";
import { reconcileHook } from "./resources/hook.ts";
import { reconcileBrewfile, reconcileMise } from "./resources/packages.ts";
import { reconcileRun } from "./resources/run.ts";
import type { ReconcileCtx } from "./types.ts";

export async function reconcileSection(section: Section, ctx: ReconcileCtx): Promise<void> {
  for (const e of section.link ?? []) await reconcileLink(e, ctx);
  for (const e of section.copy ?? []) await reconcileCopy(e, ctx);
  for (const e of section.glob ?? []) await reconcileGlob(e, ctx);
  if (section.brewfile) reconcileBrewfile(section.brewfile, ctx);
  if (section.mise) reconcileMise(ctx);
  for (const e of section.run ?? []) reconcileRun(e, ctx);
  for (const e of section.hook ?? []) await reconcileHook(e, ctx);
}
