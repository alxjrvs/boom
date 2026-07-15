// The resource registry: a data-driven, phase-ordered table of resource types — the
// executable form of the phase order (link → copy → dir → pkg → osx_default → launchd →
// run → check → hook) that used to live only in a comment above a hand-written dispatch
// sequence. Adding a resource is one table entry, not an edit to the section loop.
//
// Each resource declares how to turn a Section into labelled work units (so the per-item
// error boundary can name what failed) and, optionally, a `finalize` hook that runs once at
// end-of-run — the seam that lets osx own its own "restart the UI" side effect instead of
// the core loop reaching into an osx-specific ctx flag.
import type { Section } from "../config/schema.ts";
import { reconcileCheck } from "./resources/check.ts";
import { reconcileDir } from "./resources/dir.ts";
import { reconcileCopy, reconcileLink } from "./resources/filesystem.ts";
import { reconcileHook } from "./resources/hook.ts";
import { reconcileLaunchd } from "./resources/launchd.ts";
import { finalizeOsx, reconcileOsxDefault } from "./resources/osx.ts";
import { reconcilePkg } from "./resources/packages.ts";
import { reconcileRun } from "./resources/run.ts";
import type { ReconcileCtx } from "./types.ts";

// One unit of work + the label the error boundary reports it under.
export interface WorkItem {
  readonly label: string;
  run(ctx: ReconcileCtx): void | Promise<void>;
}

// Run a list of work items under the per-item error boundary: an unexpected throw (EACCES,
// ENOSPC, a glob error) becomes a reported failure and the run continues to a clean finish +
// commit decision, instead of unwinding the whole loop with a stack trace. Shared by the
// section resources and the `[boom]` self-wiring, so both go through the same loop.
export async function runWorkItems(items: readonly WorkItem[], ctx: ReconcileCtx): Promise<void> {
  for (const item of items) {
    try {
      await item.run(ctx);
    } catch (e) {
      ctx.report.fail(`${item.label}: ${(e as Error).message}`);
    }
  }
}

// A resource type: its work for a section, plus an optional once-per-run finalize.
interface ResourceType {
  items(section: Section): WorkItem[];
  finalize?(ctx: ReconcileCtx): void | Promise<void>;
}

// Phase order is table order — the loop below runs resources top to bottom.
const RESOURCES: readonly ResourceType[] = [
  {
    items: (s) =>
      (s.link ?? []).map((e) => ({ label: `link ${e.dst}`, run: (ctx) => reconcileLink(e, ctx) })),
  },
  {
    items: (s) =>
      (s.copy ?? []).map((e) => ({ label: `copy ${e.dst}`, run: (ctx) => reconcileCopy(e, ctx) })),
  },
  {
    items: (s) => (s.dir ?? []).map((e) => ({ label: `dir ${e.path}`, run: (ctx) => reconcileDir(e, ctx) })),
  },
  {
    items: (s) =>
      (s.pkg ?? []).map((e) => ({ label: `pkg ${e.manager}`, run: (ctx) => reconcilePkg(e, ctx) })),
  },
  {
    items: (s) =>
      (s.osx_default ?? []).map((e) => ({
        label: `osx ${e.domain} ${e.key}`,
        run: (ctx) => reconcileOsxDefault(e, ctx),
      })),
    finalize: finalizeOsx,
  },
  {
    items: (s) =>
      (s.launchd ?? []).map((e) => ({ label: `launchd ${e.src}`, run: (ctx) => reconcileLaunchd(e, ctx) })),
  },
  { items: (s) => (s.run ?? []).map((e) => ({ label: "run", run: (ctx) => reconcileRun(e, ctx) })) },
  {
    items: (s) =>
      (s.check ?? []).map((e) => ({ label: `check ${e.path}`, run: (ctx) => reconcileCheck(e, ctx) })),
  },
  {
    items: (s) =>
      (s.hook ?? []).map((e) => ({ label: `hook ${e.name}`, run: (ctx) => reconcileHook(e, ctx) })),
  },
];

export async function reconcileSection(section: Section, ctx: ReconcileCtx): Promise<void> {
  for (const res of RESOURCES) await runWorkItems(res.items(section), ctx);
}

// Run every resource's end-of-run finalize once, after all sections and reaping. Each
// finalize self-gates (osx only restarts the UI when a default actually changed), so this
// is safe to call unconditionally for any verb.
export async function finalizeResources(ctx: ReconcileCtx): Promise<void> {
  for (const res of RESOURCES) if (res.finalize) await res.finalize(ctx);
}
