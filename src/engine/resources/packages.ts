// Package resources: brewfile, mise. Shell out to the stock tools (the "native over
// special" principle); absent tools are reported, not fatal — matching engine/run.
import { join } from "node:path";
import { hasCommand, runShell } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

export function reconcileBrewfile(file: string, ctx: ReconcileCtx): void {
  const { report } = ctx;
  if (!hasCommand("brew", ctx.env)) {
    report.fail("brew not installed");
    return;
  }
  const path = join(ctx.repo, file);
  switch (ctx.verb) {
    case "apply":
    case "fix": {
      if (ctx.dryRun) {
        report.plan(`would run: brew bundle --file=${path}`);
        return;
      }
      if (runShell(`brew bundle --file='${path}'`, ctx.env).code === 0) report.ok("brew bundle satisfied");
      else report.fail("brew bundle failed");
      return;
    }
    case "verify": {
      if (runShell(`brew bundle check --file='${path}'`, ctx.env).code === 0)
        report.ok("brew bundle satisfied");
      else report.warn("brew bundle missing deps — run: botu apply");
      return;
    }
    case "uninstall":
      return; // brew packages survive uninstall (matches the bash engine)
  }
}

export function reconcileMise(ctx: ReconcileCtx): void {
  const { report } = ctx;
  if (!hasCommand("mise", ctx.env)) return;
  switch (ctx.verb) {
    case "apply":
    case "fix": {
      if (ctx.dryRun) {
        report.plan("would run: mise install");
        return;
      }
      if (runShell("mise install", ctx.env).code === 0) report.ok("mise tools installed");
      else report.fail("mise install failed");
      return;
    }
    case "verify":
      report.ok("mise present");
      return;
    case "uninstall":
      return;
  }
}
