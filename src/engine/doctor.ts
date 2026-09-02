// `boom doctor` — check boom's own preconditions, distinct from `verify` (which checks
// the machine against the config). doctor answers "is boom set up to do its job": is a
// config resolvable and parseable, are the external tools its resources shell out to on
// PATH, is the agent's 1Password token in the keychain, is the state dir writable.
// Exit code mirrors verify: 0 ok / 2 warnings / 1 failures.
import { mkdir } from "node:fs/promises";
import { NO_CONFIG_REPO_MSG, readConfigBreadcrumb, resolveConfigDir } from "../config/load.ts";
import { detectOs } from "../config/profile.ts";
import type { BoomContext } from "../context.ts";
import { displayPath } from "../lib/fs.ts";
import { remoteReachableAsync } from "../lib/git.ts";
import { agentKeychainItem, agentTokenPresent } from "../lib/keychain.ts";
import { boomStateDir } from "../lib/paths.ts";
import { hasCommand } from "../lib/proc.ts";
import { bandsReporter, type Reporter } from "../lib/reporter.ts";
import { VERSION } from "../lib/version.ts";
import { installSkill, skillState, skillStatusLabel } from "./skill.ts";
import { validateConfigFiles } from "./validate.ts";

// The external tools boom's resources shell out to, and what needs each. None are required for
// boom itself to run (it's a self-contained binary), so a missing tool is a warning, not a
// failure — it only bites if a boomfile uses that resource. (git is the one exception:
// repo-only config means it's load-bearing the moment a remote config is linked — the Config
// repo section below fails on that specifically.)
const TOOLS: ReadonlyArray<{ cmd: string; why: string }> = [
  { cmd: "git", why: "config repo sync" },
  { cmd: "brew", why: "pkg resource (brew)" },
  { cmd: "mise", why: "pkg resource (mise)" },
  { cmd: "gh", why: "pkg resource (gh extensions)" },
];

// The boom Claude skill, checked and (under --fix) installed by doctor.
async function checkSkill(ctx: BoomContext, report: Reporter, fix: boolean): Promise<void> {
  const state = await skillState(ctx.env);
  if (!state) {
    report.skip("can't resolve the Claude config dir (HOME unset)");
    return;
  }
  if (state.status === "current") {
    report.ok(`boom skill installed + current (v${VERSION})`);
    return;
  }
  if (!fix) {
    report.warn(
      `boom skill ${skillStatusLabel(state.status)} — run \`boom skill --install\` (or \`boom doctor --fix\`)`,
    );
    return;
  }
  await installSkill(state);
  report.ok(`installed boom skill → ${state.file} (v${VERSION})`);
}

// `configOnly` (the `--config` flag): parse + schema-check the boomfile and overlays alone, as
// a read-only CI gate — no tools/keychain/state checks, pass/fail 0/1 (no warning tier), and a
// missing config repo is a *failure*, not a warning.
export async function doctor(
  ctx: BoomContext,
  json = false,
  configOnly = false,
  fix = false,
): Promise<number> {
  const report = bandsReporter(ctx.process, ctx.env, "doctor", {
    json,
    setup: fix ? "MENDING WHAT WE CAN…" : "TAKING THE MACHINE'S PULSE…",
  });

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
  } else if (
    !(await report.spin(`checking ${breadcrumb.remote.url}`, () =>
      remoteReachableAsync(breadcrumb.remote.url, ctx.env),
    ))
  ) {
    report.warn(`cannot reach ${breadcrumb.remote.url} — sync will be skipped until it's reachable`);
  } else {
    report.ok(`${breadcrumb.remote.url} reachable`);
  }
  // The clone's path is what `git -C <dir> …` needs: boom does not wrap git, so this is the
  // handle it hands over.
  if (breadcrumb) report.note(`clone: ${displayPath(breadcrumb.path, ctx.env)}`);

  report.header("Tools on PATH");
  for (const { cmd, why } of TOOLS) {
    if (cmd === "git" && gitRequiredAndMissing) continue;
    if (hasCommand(cmd, ctx.env)) report.ok(`${cmd} found`);
    else report.warn(`${cmd} not on PATH — needed for ${why}`);
  }

  // PRESENCE IS THE WHOLE SIGNAL. The token backs `headersHelper`, `*_COMMAND` resolvers and
  // any hook shelling out to `op`, none of which appear in a boomfile, so nothing in the config
  // can say whether a machine needs it: if the item is there, something put it there. Absent →
  // stay silent: a new user on macOS with no op-backed anything must not be told to provision a
  // 1Password service account they have never heard of (a false positive on first run, with an
  // unactionable remedy).
  if (detectOs(ctx.env) === "darwin" && agentTokenPresent(ctx.env)) {
    report.header("1Password agent");
    report.ok(`${agentKeychainItem(ctx.env)} service-account token present in keychain`);
  }

  report.header("State");
  const stateDir = boomStateDir(ctx.env);
  try {
    // mkdir doubles as the fix: --fix or not, ensuring the dir is the safe, idempotent action.
    await mkdir(stateDir, { recursive: true });
    report.ok(`state dir ${fix ? "ensured" : "writable"}: ${stateDir}`);
  } catch (e) {
    report.fail(`state dir not writable (${stateDir}): ${(e as Error).message}`);
  }

  // The boom Claude skill — checked always, installed when --fix. One of the two things doctor
  // can safely converge itself (the state dir is the other); the rest (link a config repo,
  // provision the 1Password agent, install a missing tool) stay manual, reported above.
  report.header("Claude skill");
  await checkSkill(ctx, report, fix);

  if (json) return report.finishJson(ctx.process.stdout, true);
  return report.finish({
    ok: "doctor: all checks passed",
    warn: (w) => `doctor: ${w} warning(s)`,
    fail: (f, w) => `doctor: ${f} failure(s), ${w} warning(s)`,
  });
}
