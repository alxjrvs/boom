// `boom doctor` — check boom's own preconditions, distinct from `verify` (which checks
// the machine against the config). doctor answers "is boom set up to do its job": is a
// config resolvable and parseable, are the external tools its resources shell out to on
// PATH, is the agent's 1Password token in the keychain, is the state dir writable.
// Exit code mirrors verify: 0 ok / 2 warnings / 1 failures.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig, NO_CONFIG_REPO_MSG, readConfigBreadcrumb, resolveConfigDir } from "../config/load.ts";
import { detectOs } from "../config/profile.ts";
import type { BoomContext } from "../context.ts";
import { pathExists } from "../lib/fs.ts";
import { remoteReachableAsync } from "../lib/git.ts";
import { captureArgvAsync, hasCommand, lastLine } from "../lib/proc.ts";
import { bandsReporter, type Reporter } from "../lib/reporter.ts";
import { VERSION } from "../lib/version.ts";
import { boomStateDir } from "./state.ts";
import { validateConfigFiles } from "./validate.ts";

// The external tools boom's resources / commands shell out to, and what needs each.
// None are required for boom itself to run (it's a self-contained binary), so a missing
// tool is a warning, not a failure — it only bites if a boomfile uses that resource.
// (git is the one exception: repo-only config means it's load-bearing the moment a
// remote config is linked — the Config repo section below fails on that specifically.)
const TOOLS: ReadonlyArray<{ cmd: string; why: string }> = [
  { cmd: "git", why: "config repo sync, code crawl + agent git" },
  { cmd: "brew", why: "pkg resource (brew)" },
  { cmd: "mise", why: "pkg resource (mise)" },
  { cmd: "op", why: "1Password secrets (hooks/mcp)" },
  { cmd: "claude", why: "code + mcp commands" },
];

const KEYCHAIN_ITEM = "op-claude-agent";

// `configOnly` (the `--config` flag) is the folded-in `boom validate`: parse + schema-check
// the boomfile and overlays alone, as a read-only CI gate — no tools/keychain/state checks,
// pass/fail 0/1 (no warning tier), and a missing config repo is a *failure*, not a warning.
// The boom Claude skill, checked and (under --fix) installed by doctor. Loaded lazily to sidestep
// the commands/skill → catalog → cli → commands/doctor cycle (initialize cli.ts first, exactly as
// engine/settings.ts documents), so reaching it from the engine can't read skillCommand in its TDZ.
async function checkSkill(ctx: BoomContext, report: Reporter, fix: boolean): Promise<void> {
  await import("../cli.ts");
  const { skillDoc, skillInstallPath } = await import("../commands/skill.ts");
  const file = skillInstallPath(ctx.env);
  if (!file) {
    report.skip("can't resolve the Claude config dir (HOME unset)");
    return;
  }
  const doc = skillDoc(VERSION);
  const current = (await pathExists(file)) ? await Bun.file(file).text() : undefined;
  if (current === doc) {
    report.ok(`boom skill installed + current (v${VERSION})`);
    return;
  }
  const state = current === undefined ? "not installed" : "stale";
  if (!fix) {
    report.warn(`boom skill ${state} — run \`boom skill --install\` (or \`boom doctor --fix\`)`);
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, doc);
  report.ok(`installed boom skill → ${file} (v${VERSION})`);
}

// `secretsOnly` (the `--secrets` flag): audit every `op://` reference the boomfile declares —
// does each still resolve? — so a stale/renamed/missing ref surfaces here rather than mid-sync.
// Only the exit code of `op read` is inspected; the resolved plaintext is NEVER logged. Warning
// tier like verify: an unresolvable ref is "attention" (exit 2), not a hard failure. `template`
// secrets are noted, not resolved — checking one needs `op inject`, out of scope for an audit.
async function auditSecrets(ctx: BoomContext, report: Reporter): Promise<void> {
  const repo = await resolveConfigDir(ctx.env, ctx.cwd);
  if (!repo) {
    report.warn(NO_CONFIG_REPO_MSG);
    return;
  }
  const config = await loadConfig(repo);
  const secrets = config.section.flatMap((s) => s.secret ?? []);

  report.header("Secrets");
  if (!hasCommand("op", ctx.env)) {
    report.warn("op (1Password CLI) not on PATH — cannot audit refs");
    return;
  }
  const refs = secrets.filter((s) => s.ref);
  const templates = secrets.filter((s) => s.template);
  if (refs.length === 0 && templates.length === 0) {
    report.ok("no secret references declared");
    return;
  }
  for (const s of refs) {
    const ref = s.ref as string;
    // An `op read` is a network round-trip → run it under the spinner. Check only the exit code:
    // stdout is the secret and is never read here, so no value can leak into the report.
    const r = await report.spin(`op read ${ref}`, () =>
      captureArgvAsync(["op", "read", "--no-newline", ref], ctx.env),
    );
    if (r.code === 0) report.ok(`${ref} resolves`);
    else report.warn(`${ref} — unresolvable (${lastLine(r.stderr) || "op read failed"})`);
  }
  // A template's op:// refs live inside a file rendered by `op inject`; auditing them means
  // running the injection (out of scope), so we only surface that the template exists.
  for (const s of templates) {
    report.note(`${s.template} — template (op inject); resolvability not audited`);
  }
}

export async function doctor(
  ctx: BoomContext,
  json = false,
  configOnly = false,
  fix = false,
  secretsOnly = false,
): Promise<number> {
  const report = bandsReporter(ctx.process, ctx.env, "doctor", {
    json,
    setup: fix ? "MENDING WHAT WE CAN…" : "TAKING THE MACHINE'S PULSE…",
  });

  // `--secrets` narrows doctor to just the op:// audit — a single warning-tier job (0/2/1),
  // fully independent of the rest, exactly as `--config` narrows it to the boomfile parse.
  if (secretsOnly) {
    await auditSecrets(ctx, report);
    if (json) return report.finishJson(ctx.process.stdout, true);
    return report.finish({
      ok: "doctor: all secret refs resolve",
      warn: (w) => `doctor: ${w} secret warning(s)`,
      fail: (f, w) => `doctor: ${f} failure(s), ${w} warning(s)`,
    });
  }

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
