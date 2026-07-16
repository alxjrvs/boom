// `boom status` — the one-screen machine dashboard. Where `verify` walks the whole machine
// against the config and `boom source status` reports just the config-repo git drift, this is
// the glance that composes the cheap health signals every other command already owns: is a
// config resolvable, how does the clone stand against origin, was the last sync clean (and what
// checkpoints exist), what does the fleet look like, is a lockfile present, are secrets wired up.
//
// Pure composition — it introduces **no new state**. Every line is read from a store another
// command writes (the journal, the config repo's fleet/lock files, the breadcrumb), so a
// dashboard line can never disagree with the command that owns that fact. Deliberately *read-only
// and fast*: it never runs brew/mise or a full resource walk (that's `verify`), so it stays a
// glance. Warning-tier exit (0/2/1), like verify/doctor/fleet.
import { loadConfig, NO_CONFIG_REPO_MSG, readConfigBreadcrumb, resolveConfigDir } from "../config/load.ts";
import { detectOs } from "../config/profile.ts";
import type { Boomfile } from "../config/schema.ts";
import type { BoomContext } from "../context.ts";
import { hasCommand } from "../lib/proc.ts";
import { bandsReporter } from "../lib/reporter.ts";
import { VERSION } from "../lib/version.ts";
import { fleetHost, readMachines } from "./fleet.ts";
import { listRuns } from "./journal.ts";
import { readLock } from "./lock.ts";
import { reportRepoDrift } from "./status.ts";

// The macOS keychain item the 1Password service-account path resolves secrets through — the same
// one `boom doctor` checks. A missing token only bites a machine that actually declares secrets,
// so status surfaces it as a note in the Secrets section rather than a standalone check.
const KEYCHAIN_ITEM = "op-claude-agent";

export async function boomStatus(ctx: BoomContext, json = false): Promise<number> {
  const report = bandsReporter(ctx.process, ctx.env, "status", { json, setup: "SURVEYING THE MACHINE…" });
  const finish = (): number =>
    json
      ? report.finishJson(ctx.process.stdout, true)
      : report.finish({
          ok: "status: all clear",
          warn: (w) => `status: ${w} thing(s) need attention`,
          fail: (f) => `status: ${f} failure(s)`,
        });

  // ── Config ────────────────────────────────────────────────────────────────────────────
  report.header("Config");
  const repo = await resolveConfigDir(ctx.env, ctx.cwd);
  if (!repo) {
    // No config is the one thing that stops the dashboard cold — there's nothing else to read.
    report.warn(NO_CONFIG_REPO_MSG);
    return finish();
  }
  let config: Boomfile | undefined;
  try {
    config = await loadConfig(repo);
    report.ok(`boom v${VERSION} · ${config.section.length} section(s) · ${repo}`);
  } catch (e) {
    // A malformed boomfile is a real failure, but the machine-state sections below (journal,
    // fleet, lock) don't depend on the config, so keep going and report what we still can.
    report.fail((e as Error).message);
  }

  // ── Config repo (git drift vs origin) ───────────────────────────────────────────────────
  // Only when boom is driving a linked clone (a breadcrumb) and git is available — a config
  // resolved straight from $BOOM_CONFIG/cwd has no origin to be "behind".
  const breadcrumb = await readConfigBreadcrumb(ctx.env);
  if (breadcrumb && hasCommand("git", ctx.env)) {
    report.header("Config repo");
    report.note(`${breadcrumb.remote.url} → ${breadcrumb.path}`);
    await reportRepoDrift(report, breadcrumb.path, breadcrumb.remote, ctx.env);
  }

  // ── Last sync + checkpoints ─────────────────────────────────────────────────────────────
  report.header("Last sync");
  const runs = await listRuns(ctx.env);
  const latest = runs[0];
  if (!latest) {
    report.warn("no sync recorded yet — run `boom source` to reconcile this machine");
  } else if (latest.committed) {
    report.ok(`last sync clean — ${latest.ops} change(s) journaled`);
  } else {
    report.warn("last sync did not commit cleanly — `boom rollback` to review/undo");
  }
  const checkpoints = runs.filter((r) => r.label);
  if (checkpoints.length > 0) {
    report.note(`checkpoint(s): ${checkpoints.map((r) => r.label).join(", ")}`);
  }

  // ── Fleet ───────────────────────────────────────────────────────────────────────────────
  // Shown when recording is enabled or any machine summary already exists — otherwise it's just
  // noise on a machine that never opted in.
  const machines = await readMachines(repo);
  if (config?.boom?.fleet || machines.length > 0) {
    report.header("Fleet");
    if (machines.length === 0) {
      report.note("fleet recording on — sync + `boom source push` to record this machine");
    } else {
      report.ok(`${machines.length} machine(s) recorded`);
      const self = machines.find((m) => m.host === fleetHost(ctx.env));
      if (self) report.note(`this machine: v${self.boom}, ${self.os}, synced ${self.date} (${self.verdict})`);
    }
  }

  // ── Lock ────────────────────────────────────────────────────────────────────────────────
  // Only relevant once packages are declared; reading the lockfile is cheap, auditing it (which
  // shells out to brew/mise) is not — so status reports presence and defers the audit to `lock`.
  if (config?.section.some((s) => (s.pkg?.length ?? 0) > 0)) {
    report.header("Lock");
    const lock = await readLock(repo).catch(() => undefined);
    if (lock) {
      const pinned = Object.keys(lock.brew).length + Object.keys(lock.mise).length;
      report.ok(`boom.lock present — ${pinned} package(s) pinned (\`boom lock --check\` to audit)`);
    } else {
      report.note("no boom.lock — `boom lock` to pin resolved versions");
    }
  }

  // ── Secrets ─────────────────────────────────────────────────────────────────────────────
  const secretCount = config?.section.reduce((n, s) => n + (s.secret?.length ?? 0), 0) ?? 0;
  if (secretCount > 0) {
    report.header("Secrets");
    if (hasCommand("op", ctx.env)) report.ok(`${secretCount} secret(s) declared · op (1Password) on PATH`);
    else report.warn(`${secretCount} secret(s) declared but op (1Password) not on PATH`);
    // The agent secret path (service-account token in the keychain) is macOS-only; a missing
    // token is a note, not a warning — an interactive `op` session may still resolve refs.
    if (detectOs(ctx.env) === "darwin") {
      const p = Bun.spawnSync(["security", "find-generic-password", "-s", KEYCHAIN_ITEM, "-w"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if (p.exitCode !== 0) report.note(`${KEYCHAIN_ITEM} keychain token missing (agent secret path)`);
    }
  }

  return finish();
}
