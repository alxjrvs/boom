// Package resources: brewfile, mise. Shell out to the stock tools (the "native over
// special" principle); absent tools are reported, not fatal — matching engine/run.
import { join } from "node:path";
import { cleanEnv, hasCommand, runArgv } from "../../lib/proc.ts";
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
  switch (ctx.verb) {
    case "apply":
    case "fix": {
      if (ctx.dryRun) {
        report.plan(`would run: brew bundle --file=${path}`);
        return;
      }
      if (runArgv(["brew", "bundle", `--file=${path}`], ctx.env, { quietStdout: ctx.json }).code === 0)
        report.ok("brew bundle satisfied");
      else report.fail("brew bundle failed");
      return;
    }
    case "verify": {
      if (
        runArgv(["brew", "bundle", "check", `--file=${path}`], ctx.env, { quietStdout: ctx.json }).code === 0
      )
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
      if (runArgv(["mise", "install"], ctx.env, { quietStdout: ctx.json }).code === 0)
        report.ok("mise tools installed");
      else report.fail("mise install failed");
      return;
    }
    case "verify": {
      // `mise install` is idempotent, so "present" told us nothing about drift. Ask
      // mise what's declared-but-not-installed: `mise ls --missing` lists those tools
      // and still exits 0, so the missing-tool signal is its stdout, not its code.
      const p = Bun.spawnSync(["mise", "ls", "--missing"], {
        env: cleanEnv(ctx.env),
        stdout: "pipe",
        stderr: "ignore",
      });
      const missing = new TextDecoder().decode(p.stdout).trim();
      if (p.exitCode === 0 && missing === "") report.ok("mise tools installed");
      else report.warn("mise tools missing — run: botu apply");
      return;
    }
    case "uninstall":
      return;
  }
}
