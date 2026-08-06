// The `[boom]` table: machine-global, self-wiring behaviors folded into the reconcile boom
// already runs, so a consumer stops hand-rolling `run`/plist boilerplate for boom invoking
// boom. Modelled as work items run through the *same* guarded loop as section resources
// (`runWorkItems`), verb-aware:
//   sync    → install/refresh (regenerate the skill, (re)load + reap timers, check/auto-upgrade)
//   verify  → report drift (skill stale, timer not loaded)
//   uninstall → tear down what boom installed (unload + remove every timer; the skill is left)
// Each field is opt-in; an absent/empty `[boom]` table emits nothing. Skill + timer writes are
// journaled like any file mutation, so `boom rollback` reverses them.
// `skillDoc`/`skillInstallPath`/`fetchLatestVersion` live in `commands/*`, which transitively
// import the `cli.ts` route map — a static import here would form an engine→commands→cli
// cycle and read those exports in their temporal dead zone (same hazard catalog.ts documents).
// They're pulled in via a call-time dynamic import inside the handlers below, past the cycle.
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { detectOs } from "../config/profile.ts";
import type { BoomSettings, Schedule } from "../config/schema.ts";
import { displayPath, mkdir, pathExists } from "../lib/fs.ts";
import {
  agentLoaded,
  launchAgentsDir,
  parseInterval,
  reloadAgent,
  renderAgentPlist,
  unloadAgent,
} from "../lib/launchd.ts";
import { notify } from "../lib/notify.ts";
import { runArgv } from "../lib/proc.ts";
import { VERSION } from "../lib/version.ts";
import { machineSummary, writeMachineSummary } from "./fleet.ts";
import { displace, journalWrite } from "./journal.ts";
import { runWorkItems, type WorkItem } from "./registry.ts";
import { boomStateDir } from "./state.ts";
import type { ReconcileCtx } from "./types.ts";

// Every boom-owned timer plist is labelled `com.boomtube.<cmd-slug>` — the shared prefix lets
// reaping recognize (and remove) a timer whose `schedule` entry was deleted without a state
// file. A cmd of "verify" → com.boomtube.verify and "code fetch" → com.boomtube.code-fetch,
// so the historical fixed labels reproduce exactly and an upgrade doesn't churn live timers.
const TIMER_PREFIX = "com.boomtube.";
function timerLabel(cmd: string): string {
  return TIMER_PREFIX + cmd.trim().split(/\s+/).join("-");
}
function timerArgs(cmd: string, self: string): string[] {
  return [self, ...cmd.trim().split(/\s+/)];
}

// Is `latest` a strictly greater semver than `current`? Both are dot-numeric release strings
// (no pre-release suffixes ship), so a component-wise numeric compare suffices.
export function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

// Any field configured? Gates the header so an absent or all-off `[boom]` table stays silent.
function anyConfigured(s: BoomSettings): boolean {
  return Boolean(
    s.skill_on_sync || s.upgrade_on_sync || (s.schedule && s.schedule.length > 0) || s.fleet || s.notify,
  );
}

// The running boom binary — the ProgramArguments a timer invokes, and the guard against
// wiring a timer to `bun` during `bun run src/index.ts` dev (execPath is bun there).
function boomSelf(): string | undefined {
  const self = process.execPath;
  return basename(self) === "boom" ? self : undefined;
}

// The self-wiring as work items, so it runs through the same guarded loop as resources — each
// with its own error boundary, journaling, and dry-run handling. Built at call time (settings
// captured in the closures) because they don't live on the Section the section loop walks.
function boomWorkItems(settings: BoomSettings): WorkItem[] {
  const items: WorkItem[] = [];
  if (settings.skill_on_sync) items.push({ label: "skill", run: applySkill });
  for (const s of settings.schedule ?? []) {
    items.push({ label: `schedule ${s.cmd}`, run: (ctx) => applyTimer(ctx, s) });
  }
  if (settings.schedule) {
    items.push({ label: "reap timers", run: (ctx) => reapUndeclaredTimers(settings, ctx) });
  }
  if (settings.upgrade_on_sync) items.push({ label: "upgrade", run: (ctx) => applyUpgrade(settings, ctx) });
  if (settings.fleet) items.push({ label: "fleet", run: applyFleet });
  // Notify runs LAST, so its drift tally also counts any drift the earlier self-wiring items
  // surfaced (a stale skill, an unloaded timer), not just section drift.
  if (settings.notify) items.push({ label: "notify", run: applyNotify });
  return items;
}

// Drift monitor: on a (typically scheduled) `verify` that finds drift, raise a desktop
// notification so the signal doesn't die in a timer log. verify-only — a sync repairs drift
// rather than reporting it, and a notification there would be noise. Best-effort: no notifier
// on the platform is a silent no-op (see lib/notify.ts).
function applyNotify(ctx: ReconcileCtx): void {
  if (ctx.verb !== "verify") return;
  const { report } = ctx;
  const drift = report.failures + report.warnings;
  if (drift === 0) {
    report.skip("no drift — no notification");
    return;
  }
  const host = ctx.env.BOOM_HOST ?? Bun.env.HOSTNAME ?? "this machine";
  const fired = notify(
    ctx.env,
    "boom: drift detected",
    `${host}: ${report.failures} failure(s), ${report.warnings} warning(s) — run \`boom source\``,
  );
  if (fired) report.ok(`notified: ${drift} drift item(s)`);
  else report.skip("drift found but no desktop notifier available");
}

// Record this machine's summary into the config repo after a sync, so `boom fleet` can show a
// cross-machine view (see engine/fleet.ts). Only on sync — a verify/uninstall isn't a checkpoint
// worth recording — and only when the summary actually changed, so a repeat same-day sync leaves
// the repo clean. The verdict is read from the run's tally at this point (post-sections).
async function applyFleet(ctx: ReconcileCtx): Promise<void> {
  if (ctx.verb !== "sync") return;
  const { report } = ctx;
  if (ctx.dryRun) {
    report.plan("would record this machine's fleet summary");
    return;
  }
  const verdict = report.failures > 0 ? "fail" : report.warnings > 0 ? "warn" : "ok";
  const summary = machineSummary(ctx.env, verdict);
  if (await writeMachineSummary(ctx.repo, summary))
    report.ok(`recorded fleet summary → .boom/machines/${summary.host}.json (push to share)`);
  else report.skip("fleet summary unchanged");
}

export async function applyBoomSettings(
  settings: BoomSettings | undefined,
  ctx: ReconcileCtx,
): Promise<void> {
  if (!settings || !anyConfigured(settings)) return;
  ctx.report.header("boom self-wiring");
  await runWorkItems(boomWorkItems(settings), ctx);
}

// #55 — (re)install the self-describing skill from the running binary, so it can't lag a
// `boom upgrade`. Sync regenerates (journaled); verify reports staleness; uninstall leaves it
// (it lives under the user's ~/.claude, not something boom should reclaim).
async function applySkill(ctx: ReconcileCtx): Promise<void> {
  if (ctx.verb === "uninstall") return;
  const { report } = ctx;
  // commands/skill → catalog → cli → commands/skill is a load cycle that only resolves when
  // `cli.ts` is the entry (as in production via index.ts). Reached from the engine, skill.ts
  // can become the entry and read `skillCommand` in its TDZ — so initialize cli.ts first, then
  // the fully-loaded skill module is safe to pull. (catalog reads `routes` lazily by design.)
  await import("../cli.ts");
  const { skillDoc, skillInstallPath } = await import("../commands/skill.ts");
  const file = skillInstallPath(ctx.env);
  if (!file) {
    report.skip("skill_on_sync — can't resolve the Claude config dir (HOME unset)");
    return;
  }
  const disp = displayPath(file, ctx.env);
  const doc = skillDoc(VERSION);

  if (ctx.verb === "verify") {
    const current = (await pathExists(file)) ? await Bun.file(file).text() : undefined;
    if (current === doc) report.skip(`skill current (v${VERSION})`);
    else report.warn(`skill ${current === undefined ? "not installed" : "stale"} — sync refreshes it`);
    return;
  }
  // sync
  if (ctx.dryRun) {
    report.plan(`would refresh skill → ${disp}`);
    return;
  }
  if ((await pathExists(file)) && (await Bun.file(file).text()) === doc) {
    report.skip(`skill current (v${VERSION})`);
    return;
  }
  // Journal the write in full before touching disk: displace a prior skill into the backup tree
  // (rollback restores it), or record a plain remove for a fresh install. The `done` row used to
  // land after `Bun.write`, so a failure in between — the `mkdir` throwing ENOTDIR is enough —
  // left the displaced original in the backup tree with nothing naming it.
  await journalWrite("skill", file, ctx);
  await mkdir(join(file, ".."), { recursive: true });
  await Bun.write(file, doc);
  report.ok(`refreshed skill → ${disp} (v${VERSION})`);
}

// #57/#58 — own a launchd timer that runs `boom <cmd>` on an interval (macOS only). The
// generated plist is deterministic, so an unchanged interval re-renders byte-identical and
// sync only reloads/rewrites when it actually changed. Uninstall is handled by the reap item.
async function applyTimer(ctx: ReconcileCtx, sched: Schedule): Promise<void> {
  if (ctx.verb === "uninstall") return; // reapUndeclaredTimers(keep=∅) removes them all
  const { report } = ctx;
  const label = timerLabel(sched.cmd);
  const what = sched.cmd;
  const agents = launchAgentsDir(ctx.env);
  if (!agents) return;
  const plistPath = join(agents, `${label}.plist`);

  if (detectOs(ctx.env) !== "darwin") {
    report.skip(`${what} — scheduled timers are macOS-only`);
    return;
  }
  if (ctx.dryRun) {
    report.plan(`would schedule ${what} every ${sched.every}`);
    return;
  }
  const self = boomSelf();
  if (!self) {
    report.skip(`${what} — not a compiled boom binary (dev run); skipping timer`);
    return;
  }

  const logDir = join(boomStateDir(ctx.env), "logs");
  const log = join(logDir, `${label}.log`);
  const plist = renderAgentPlist({
    label,
    programArgs: timerArgs(sched.cmd, self),
    startInterval: parseInterval(sched.every),
    stdoutPath: log,
    stderrPath: log,
  });

  if (ctx.verb === "verify") {
    const current = (await pathExists(plistPath)) ? await Bun.file(plistPath).text() : undefined;
    if (current !== plist) report.warn(`${what} timer missing/outdated — sync installs it`);
    else if (!agentLoaded(label, ctx.env)) report.warn(`${what} timer installed but not loaded`);
    else report.skip(`${what} every ${sched.every}`);
    return;
  }
  // sync (non-dry)
  if ((await pathExists(plistPath)) && (await Bun.file(plistPath).text()) === plist) {
    // Byte-identical plist already in place; still ensure it's loaded (a reboot or manual
    // unload could have dropped it) but don't rewrite.
    if (agentLoaded(label, ctx.env)) report.skip(`${what} every ${sched.every} (unchanged)`);
    else if (reloadAgent(plistPath, ctx.env)) report.ok(`reloaded ${what} timer`);
    else report.fail(`${what} timer present but launchctl load failed`);
    return;
  }
  // Same undo-before-create discipline as the skill write above.
  await journalWrite("timer", plistPath, ctx);
  await mkdir(logDir, { recursive: true });
  await Bun.write(plistPath, plist);
  if (reloadAgent(plistPath, ctx.env)) report.ok(`scheduled ${what} every ${sched.every}`);
  else report.fail(`wrote ${what} plist but launchctl load failed`);
}

// Remove boom-owned timers (com.boomtube.*) whose schedule entry is gone: on sync keep the
// declared set, on uninstall keep nothing (tear them all down). Journaled (rollback restores
// them) and dry-run aware; a no-op on verify and where no LaunchAgents dir resolves.
async function reapUndeclaredTimers(settings: BoomSettings, ctx: ReconcileCtx): Promise<void> {
  if (ctx.verb === "verify") return;
  const keep =
    ctx.verb === "uninstall"
      ? new Set<string>()
      : new Set((settings.schedule ?? []).map((s) => timerLabel(s.cmd)));
  const { report } = ctx;
  const agents = launchAgentsDir(ctx.env);
  if (!agents || !(await pathExists(agents))) return;
  let names: string[];
  try {
    names = await readdir(agents);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TIMER_PREFIX) || !name.endsWith(".plist")) continue;
    const label = name.slice(0, -".plist".length);
    if (keep.has(label)) continue;
    const plistPath = join(agents, name);
    if (ctx.dryRun) {
      report.note(`would unload + remove ${label} timer`);
      continue;
    }
    // Unload before displacing the plist (unload reads the file), then journal the removal as
    // a displaced-original restore so rollback can put the timer back.
    if (detectOs(ctx.env) === "darwin") unloadAgent(plistPath, ctx.env);
    await ctx.journal?.intent("reap-timer", plistPath);
    const undo = await displace(plistPath, ctx.backupRoot);
    await ctx.journal?.done("reap-timer", plistPath, undo);
    report.ok(`removed ${label} timer`);
  }
}

// #59 — fold an upgrade check (and optional auto-upgrade) into sync. Both are best-effort and
// offline-safe: a network hiccup surfaces nothing and never fails the sync. Sync-only.
async function applyUpgrade(settings: BoomSettings, ctx: ReconcileCtx): Promise<void> {
  const { report } = ctx;
  if (ctx.verb !== "sync") return;
  if (ctx.dryRun) {
    report.plan("would check for a newer boom release");
    return;
  }
  const { fetchLatestVersion } = await import("../commands/upgrade.ts");
  const latest = await fetchLatestVersion();
  if (!latest) {
    report.skip("upgrade check skipped (couldn't reach GitHub)");
    return;
  }
  if (!isNewer(latest, VERSION)) {
    report.skip(`boom is current (v${VERSION})`);
    return;
  }
  if (settings.upgrade_on_sync === "auto") {
    const self = boomSelf();
    if (!self) {
      report.note(`newer boom v${latest} available — run \`boom upgrade\` (dev run can't self-upgrade)`);
      return;
    }
    report.plan(`upgrading boom v${VERSION} → v${latest}`);
    const { code } = runArgv([self, "upgrade"], ctx.env, { quietStdout: ctx.json });
    if (code === 0) report.ok(`upgraded to v${latest}`);
    else report.warn(`auto-upgrade to v${latest} failed — run \`boom upgrade\` manually`);
    return;
  }
  report.warn(`newer boom v${latest} available (you have v${VERSION}) — run \`boom upgrade\``);
}
