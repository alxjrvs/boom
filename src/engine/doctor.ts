// `boom doctor` — check boom's own preconditions, distinct from `verify` (which checks
// the machine against the config). doctor answers "is boom set up to do its job": is a
// config resolvable and parseable, are the external tools its resources shell out to on
// PATH, is the agent's 1Password token in the keychain, is the state dir writable.
// Exit code mirrors verify: 0 ok / 2 warnings / 1 failures.
import { mkdir } from "node:fs/promises";
import { readConfigBreadcrumb, resolveConfigDir } from "../config/load.ts";
import { detectOs } from "../config/profile.ts";
import type { BoomContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { remoteReachable } from "../lib/git.ts";
import { hasCommand } from "../lib/proc.ts";
import { Reporter } from "../lib/reporter.ts";
import { boomStateDir } from "./state.ts";
import { validateConfigFiles } from "./validate.ts";

// The external tools boom's resources / commands shell out to, and what needs each.
// None are required for boom itself to run (it's a self-contained binary), so a missing
// tool is a warning, not a failure — it only bites if a boomfile uses that resource.
// (git is the one exception: repo-only config means it's load-bearing the moment a
// remote config is linked — the Config repo section below fails on that specifically.)
const TOOLS: ReadonlyArray<{ cmd: string; why: string }> = [
  { cmd: "git", why: "config repo sync, code crawl + agent git" },
  { cmd: "brew", why: "brewfile resource" },
  { cmd: "mise", why: "mise resource" },
  { cmd: "op", why: "1Password secrets (hooks/mcp)" },
  { cmd: "claude", why: "code + mcp commands" },
];

const KEYCHAIN_ITEM = "op-claude-agent";

export async function doctor(ctx: BoomContext): Promise<number> {
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env));

  report.header("Config");
  const repo = await resolveConfigDir(ctx.env, ctx.cwd);
  if (!repo) {
    report.warn("no dotfiles repo found — run `boom source set <owner/repo>`");
  } else {
    // Same parse `boom validate` runs (base boomfile + every overlay), shared so the two
    // commands can't disagree; here it's one section among doctor's broader preconditions.
    await validateConfigFiles(repo, report);
  }

  report.header("Config repo");
  const breadcrumb = await readConfigBreadcrumb(ctx.env);
  // Tracked so the Tools section below doesn't also warn on the same missing git —
  // one fact, one report, at the severity that actually applies here.
  let gitRequiredAndMissing = false;
  if (!breadcrumb) {
    report.warn("no remote config linked — run `boom source set <owner/repo>`");
  } else if (!hasCommand("git", ctx.env)) {
    gitRequiredAndMissing = true;
    report.fail("git not on PATH — required to sync the config repo (repo-only config)");
  } else if (!remoteReachable(breadcrumb.remote.url, ctx.env)) {
    report.warn(`cannot reach ${breadcrumb.remote.url} — sync will be skipped until it's reachable`);
  } else {
    report.ok(`${breadcrumb.remote.url} reachable`);
  }

  report.header("Tools on PATH");
  for (const { cmd, why } of TOOLS) {
    if (cmd === "git" && gitRequiredAndMissing) continue;
    if (hasCommand(cmd, ctx.env)) report.ok(`${cmd} found`);
    else report.warn(`${cmd} not on PATH — needed for ${why}`);
  }

  if (detectOs(ctx.env) === "darwin") {
    report.header("1Password agent");
    const p = Bun.spawnSync(["security", "find-generic-password", "-s", KEYCHAIN_ITEM, "-w"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (p.exitCode === 0) report.ok(`${KEYCHAIN_ITEM} service-account token present in keychain`);
    else report.warn(`${KEYCHAIN_ITEM} keychain item missing — provision it (op-agent provision)`);
  }

  report.header("State");
  const stateDir = boomStateDir(ctx.env);
  try {
    await mkdir(stateDir, { recursive: true });
    report.ok(`state dir writable: ${stateDir}`);
  } catch (e) {
    report.fail(`state dir not writable (${stateDir}): ${(e as Error).message}`);
  }

  ctx.process.stdout.write("\n");
  if (report.failures > 0) {
    report.fail(`doctor: ${report.failures} failure(s), ${report.warnings} warning(s)`);
    return 1;
  }
  if (report.warnings > 0) {
    report.warn(`doctor: ${report.warnings} warning(s)`);
    return 2;
  }
  report.ok("doctor: all checks passed");
  return 0;
}
