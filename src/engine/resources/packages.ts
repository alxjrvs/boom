// Package resources: brewfile, mise. Shell out to the stock tools (the "native over
// special" principle); absent tools are reported, not fatal — matching engine/run.
import { join } from "node:path";
import { captureArgv, hasCommand, runArgv } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

export function reconcileBrewfile(file: string, ctx: ReconcileCtx): void {
  const { report } = ctx;
  if (!hasCommand("brew", ctx.env)) {
    report.fail("brew not installed");
    return;
  }
  // argv array, not a shell string: a repo path with a space or quote is just an
  // argument here, never re-parsed by sh.
  const path = join(ctx.repo, file);
  // Homebrew Bundle upgrades outdated formulae by default — `sync` should only
  // reconcile declared state, not silently upgrade packages as a side effect, so it
  // opts out unless the caller asked for it (`boom source --update`). Casks are
  // unaffected by this flag: Bundle only upgrades a cask when its Brewfile entry
  // sets `greedy: true`, update or not.
  const noUpgrade = ctx.update ? [] : ["--no-upgrade"];
  switch (ctx.verb) {
    case "sync": {
      if (ctx.dryRun) {
        report.plan(`would run: brew bundle --file=${path}${ctx.update ? "" : " --no-upgrade"}`);
        return;
      }
      if (
        runArgv(["brew", "bundle", `--file=${path}`, ...noUpgrade], ctx.env, { quietStdout: ctx.json })
          .code === 0
      )
        report.ok("brew bundle satisfied");
      else report.fail("brew bundle failed");
      return;
    }
    case "verify": {
      // Mirrors sync's --no-upgrade gate: otherwise a plain `verify` would flag
      // merely-outdated (but still declared) formulae as drift that `boom source`
      // then won't reconcile, since sync itself no longer upgrades by default.
      if (
        runArgv(["brew", "bundle", "check", `--file=${path}`, ...noUpgrade], ctx.env, {
          quietStdout: ctx.json,
        }).code === 0
      )
        report.ok("brew bundle satisfied");
      else report.warn("brew bundle missing deps — run: boom source");
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
    case "sync": {
      if (ctx.dryRun) {
        report.plan("would run: mise install");
        return;
      }
      // Run from the repo (cwd-independent sync), so mise resolves the repo's
      // `mise.toml` instead of whatever project tree `boom` was invoked from.
      if (runArgv(["mise", "install"], ctx.env, { quietStdout: ctx.json, cwd: ctx.repo }).code === 0)
        report.ok("mise tools installed");
      else report.fail("mise install failed");
      return;
    }
    case "verify": {
      // `mise install` is idempotent, so "present" told us nothing about drift. Ask
      // mise what's declared-but-not-installed: `mise ls --missing` lists those tools
      // and still exits 0, so the missing-tool signal is its stdout, not its code.
      // captureArgv (not a raw Bun.spawnSync) keeps the trim + throw-safety in one place.
      const r = captureArgv(["mise", "ls", "--missing"], ctx.env, { cwd: ctx.repo });
      if (r.code === 0 && r.stdout === "") report.ok("mise tools installed");
      else report.warn("mise tools missing — run: boom source");
      return;
    }
    case "uninstall":
      return;
  }
}
