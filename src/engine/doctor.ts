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
import { agentKeychainItem, agentTokenPresent } from "../lib/keychain.ts";
import { boomStateDir } from "../lib/paths.ts";
import { hasCommand } from "../lib/proc.ts";
import { bandsReporter, type Reporter } from "../lib/reporter.ts";
import { VERSION } from "../lib/version.ts";
import { getBackend } from "./secrets/backends.ts";
import { skillDoc, skillInstallPath } from "./skill.ts";
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

// `configOnly` (the `--config` flag) is the folded-in `boom validate`: parse + schema-check
// the boomfile and overlays alone, as a read-only CI gate — no tools/keychain/state checks,
// pass/fail 0/1 (no warning tier), and a missing config repo is a *failure*, not a warning.
// The boom Claude skill, checked and (under --fix) installed by doctor.
async function checkSkill(ctx: BoomContext, report: Reporter, fix: boolean): Promise<void> {
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

// How many declared secrets resolve through 1Password — the `op` backend is either stated
// outright or inferred from an `op://` ref, matching how backends.ts picks one. Returns 0 for an
// unreadable boomfile: the keychain check this gates is a nicety, and a config error is already
// being reported by validateConfigFiles above.
async function countOpSecrets(repo: string): Promise<number> {
  try {
    const config = await loadConfig(repo);
    return config.section
      .flatMap((s) => s.secret ?? [])
      .filter((s) => s.backend === "op" || (!s.backend && (s.ref ?? "").startsWith("op://"))).length;
  } catch {
    return 0;
  }
}

// `secretsOnly` (the `--secrets` flag): audit every secret reference the boomfile declares —
// does each still resolve? — so a stale/renamed/missing ref surfaces here rather than mid-sync.
// Every backend, not just 1Password: the audit routes through the same `getBackend` seam the
// `secret` resource does, so what it reports is what a sync would actually attempt. The resolved
// plaintext is NEVER logged. Warning tier like verify: an unresolvable ref is "attention"
// (exit 2), not a hard failure. `template` secrets are noted, not resolved — checking one means
// running the backend's injector, out of scope for an audit.
async function auditSecrets(ctx: BoomContext, report: Reporter): Promise<void> {
  const repo = await resolveConfigDir(ctx.env, ctx.cwd);
  if (!repo) {
    report.warn(NO_CONFIG_REPO_MSG);
    return;
  }
  const config = await loadConfig(repo);
  const secrets = config.section.flatMap((s) => s.secret ?? []);

  report.header("Secrets");
  const refs = secrets.filter((s) => s.ref);
  const templates = secrets.filter((s) => s.template);
  if (refs.length === 0 && templates.length === 0) {
    report.ok("no secret references declared");
    return;
  }
  for (const s of refs) {
    const ref = s.ref as string;
    // Dispatch through the same seam the `secret` resource uses, so the audit agrees with what
    // a sync would actually do. This used to shell `op read` at EVERY ref regardless of scheme,
    // which reported a perfectly good `env:`/`pass:`/age/sops secret as unresolvable — and
    // returned early when `op` was absent, so a machine with no 1Password audited nothing while
    // claiming to. `getBackend` honours an explicit `backend =` and otherwise infers from the
    // scheme; `resolveRef` is not used here because it discards that explicit field.
    const backend = getBackend(s);
    if (!backend.available(ctx.env)) {
      report.warn(`${ref} — ${backend.tool} not installed, cannot audit`);
      continue;
    }
    // A read may be a network round-trip (op) → run it under the spinner. Only `ok`/`err` are
    // inspected: the resolved plaintext is never bound, logged, or reported. It exists in memory
    // for the life of the call, exactly as it does for the askpass helper, and goes nowhere.
    const r = await report.spin(`${backend.name} read ${ref}`, () => backend.read(s, { env: ctx.env, repo }));
    if (r.ok) report.ok(`${ref} resolves (${backend.name})`);
    else report.warn(`${ref} — unresolvable (${r.err})`);
  }
  // A template's refs live inside a file rendered by the backend's injector (`op inject` and
  // friends); auditing them means running the injection (out of scope), so we only surface that
  // the template exists — and which backend would render it.
  for (const s of templates) {
    report.note(`${s.template} — template (${getBackend(s).name}); resolvability not audited`);
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

  // `--secrets` narrows doctor to just the secret-ref audit — a single warning-tier job (0/2/1),
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

  // Only when the config actually declares an `op`-backed secret. This used to run on every
  // macOS machine, so a brand-new user's first `boom doctor` — the command whose whole job is
  // "is boom set up to do its job" — warned about a 1Password service-account item they had
  // never heard of, and told them to run `op-agent provision`, which boom neither ships nor
  // installs. A false positive on first run with an unactionable remedy.
  if (detectOs(ctx.env) === "darwin") {
    const item = agentKeychainItem(ctx.env);
    // Two independent reasons to report, because `secret` resources are not the only way to use
    // this token. It is equally the backing for `headersHelper`, `*_COMMAND` resolvers and hook
    // scripts that shell out to `op` — none of which appear in the boomfile as a `secret`.
    //
    // Gating solely on declared secrets (as this did) silenced the check completely for a config
    // that resolves every credential at runtime and declares zero — which is the setup most
    // likely to depend on the item, and exactly the case that regressed. Presence is the honest
    // second signal: if the item is there, something put it there, so confirm it.
    const present = agentTokenPresent(ctx.env);
    const opSecrets = repo ? await countOpSecrets(repo) : 0;
    if (present || opSecrets > 0) {
      report.header("1Password agent");
      if (present) report.ok(`${item} service-account token present in keychain`);
      else
        report.warn(
          `${item} keychain item missing — ${opSecrets} op:// secret(s) declared. Add the ` +
            `service-account token to the login keychain under that name, or set ` +
            `BOOM_OP_KEYCHAIN_ITEM to the item you use.`,
        );
    }
    // Neither present nor needed → stay silent. That is the case this gate was narrowed for:
    // a new user on macOS with no op-backed anything should not be told to provision a
    // 1Password service account they have never heard of.
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
