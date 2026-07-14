// `boom doctor` — check boom's own preconditions, distinct from `verify` (which checks
// the machine against the config). doctor answers "is boom set up to do its job": is a
// config resolvable and parseable, are the external tools its resources shell out to on
// PATH, is the agent's 1Password token in the keychain, is the state dir writable.
// Exit code mirrors verify: 0 ok / 2 warnings / 1 failures.
import { mkdir } from "node:fs/promises";
import { NO_CONFIG_REPO_MSG, readConfigBreadcrumb, resolveConfigDir } from "../config/load.ts";
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

// `configOnly` (the `--config` flag) is the folded-in `boom validate`: parse + schema-check
// the boomfile and overlays alone, as a read-only CI gate — no tools/keychain/state checks,
// pass/fail 0/1 (no warning tier), and a missing config repo is a *failure*, not a warning.
export async function doctor(ctx: BoomContext, json = false, configOnly = false): Promise<number> {
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env), json);

  report.header("Config");
  const repo = await resolveConfigDir(ctx.env, ctx.cwd);
  if (!repo) {
    // Strict for a CI gate, lenient for a health check: without a config repo `--config`
    // fails (there's nothing to validate) while full doctor warns (boom can still run).
    if (configOnly) report.fail(NO_CONFIG_REPO_MSG);
    else report.warn(NO_CONFIG_REPO_MSG);
  } else {
    // The base boomfile + every overlay; here it's one section among doctor's broader
    // preconditions, or the whole job under `--config`.
    await validateConfigFiles(repo, report);
  }

  if (configOnly) {
    if (json) return report.finishJson(ctx.process.stdout, false);
    return report.finish({
      ok: "doctor: config OK",
      fail: (f) => `doctor: ${f} invalid file(s)`,
    });
  }

  report.header("Config repo");
  const breadcrumb = await readConfigBreadcrumb(ctx.env);
  // Tracked so the Tools section below doesn't also warn on the same missing git —
  // one fact, one report, at the severity that actually applies here.
  let gitRequiredAndMissing = false;
  if (!breadcrumb) {
    report.warn(NO_CONFIG_REPO_MSG);
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

  if (json) return report.finishJson(ctx.process.stdout, true);
  return report.finish({
    ok: "doctor: all checks passed",
    warn: (w) => `doctor: ${w} warning(s)`,
    fail: (f, w) => `doctor: ${f} failure(s), ${w} warning(s)`,
  });
}
