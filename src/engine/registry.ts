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
import { reconcileSecret } from "./resources/secret.ts";
import { reconcileSystemd } from "./resources/systemd.ts";
import { reconcileTmpl } from "./resources/template.ts";
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

// A resource type: the dense-default output category it feeds (DOTFILES/PACKAGES/…), its work
// for a section, plus an optional once-per-run finalize.
interface ResourceType {
  category: string;
  items(section: Section): WorkItem[];
  finalize?(ctx: ReconcileCtx): void | Promise<void>;
}

// Phase order is table order — the loop below runs resources top to bottom. Each row also names
// the output category its lines land under, so the dense default groups by resource kind (all
// dotfiles across all sections under DOTFILES) rather than by boomfile section.
const RESOURCES: readonly ResourceType[] = [
  {
    category: "DOTFILES",
    items: (s) =>
      (s.link ?? []).map((e) => ({ label: `link ${e.dst}`, run: (ctx) => reconcileLink(e, ctx) })),
  },
  {
    category: "DOTFILES",
    items: (s) =>
      (s.copy ?? []).map((e) => ({ label: `copy ${e.dst}`, run: (ctx) => reconcileCopy(e, ctx) })),
  },
  {
    category: "DOTFILES",
    items: (s) =>
      (s.tmpl ?? []).map((e) => ({ label: `tmpl ${e.dst}`, run: (ctx) => reconcileTmpl(e, ctx) })),
  },
  {
    category: "SECRETS",
    items: (s) =>
      (s.secret ?? []).map((e) => ({ label: `secret ${e.dst}`, run: (ctx) => reconcileSecret(e, ctx) })),
  },
  {
    category: "DIRECTORIES",
    items: (s) => (s.dir ?? []).map((e) => ({ label: `dir ${e.path}`, run: (ctx) => reconcileDir(e, ctx) })),
  },
  {
    category: "PACKAGES",
    items: (s) =>
      (s.pkg ?? []).map((e) => ({ label: `pkg ${e.manager}`, run: (ctx) => reconcilePkg(e, ctx) })),
  },
  {
    category: "MACOS",
    items: (s) =>
      (s.osx_default ?? []).map((e) => ({
        label: `osx ${e.domain} ${e.key}`,
        run: (ctx) => reconcileOsxDefault(e, ctx),
      })),
    finalize: finalizeOsx,
  },
  {
    category: "SERVICES",
    items: (s) =>
      (s.launchd ?? []).map((e) => ({ label: `launchd ${e.src}`, run: (ctx) => reconcileLaunchd(e, ctx) })),
  },
  {
    category: "SERVICES",
    items: (s) =>
      (s.systemd ?? []).map((e) => ({ label: `systemd ${e.name}`, run: (ctx) => reconcileSystemd(e, ctx) })),
  },
  {
    category: "COMMANDS",
    items: (s) => (s.run ?? []).map((e) => ({ label: "run", run: (ctx) => reconcileRun(e, ctx) })),
  },
  {
    category: "CHECKS",
    items: (s) =>
      (s.check ?? []).map((e) => ({ label: `check ${e.path}`, run: (ctx) => reconcileCheck(e, ctx) })),
  },
  {
    category: "HOOKS",
    items: (s) =>
      (s.hook ?? []).map((e) => ({ label: `hook ${e.name}`, run: (ctx) => reconcileHook(e, ctx) })),
  },
];

export async function reconcileSection(section: Section, ctx: ReconcileCtx): Promise<void> {
  for (const res of RESOURCES) {
    // Stamp the category before running the resource's items so every line they emit is grouped
    // under the right band in the dense default (a no-op on the classic/verbose surfaces).
    ctx.report.category = res.category;
    await runWorkItems(res.items(section), ctx);
  }
}

// Run every resource's end-of-run finalize once, after all sections and reaping. Each
// finalize self-gates (osx only restarts the UI when a default actually changed), so this
// is safe to call unconditionally for any verb.
export async function finalizeResources(ctx: ReconcileCtx): Promise<void> {
  for (const res of RESOURCES)
    if (res.finalize) {
      ctx.report.category = res.category;
      await res.finalize(ctx);
    }
}
