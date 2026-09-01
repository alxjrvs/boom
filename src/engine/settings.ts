// The `[boom]` table: machine-global, self-wiring behaviors folded into the reconcile boom
// already runs, so a consumer stops hand-rolling `run`/plist boilerplate for boom invoking
// boom. Modelled as work items run through the *same* guarded loop as section resources
// (`runWorkItems`), verb-aware:
//   sync    → install/refresh (regenerate the skill, check for a newer release)
//   verify  → report drift (skill stale) and notify on it
// Each field is opt-in; an absent/empty `[boom]` table emits nothing. Skill writes are
// journaled like any file mutation, so a skill they overwrite is displaced, not destroyed.
import type { BoomSettings } from "../config/schema.ts";
import { displayPath } from "../lib/fs.ts";
import { notify } from "../lib/notify.ts";
import { fetchLatestVersion } from "../lib/release.ts";
import { compareVersions, VERSION } from "../lib/version.ts";
import { journalWrite } from "./journal.ts";
import { runWorkItems, type WorkItem } from "./registry.ts";
import { installSkill, skillState } from "./skill.ts";
import type { ReconcileCtx } from "./types.ts";

// Any field configured? Gates the header so an absent or all-off `[boom]` table stays silent.
function anyConfigured(s: BoomSettings): boolean {
  return Boolean(s.skill_on_sync || s.upgrade_on_sync || s.notify);
}

// The self-wiring as work items, so it runs through the same guarded loop as resources — each
// with its own error boundary, journaling, and dry-run handling. Built at call time (settings
// captured in the closures) because they don't live on the Section the section loop walks.
function boomWorkItems(settings: BoomSettings): WorkItem[] {
  const items: WorkItem[] = [];
  if (settings.skill_on_sync) items.push({ label: "skill", run: applySkill });
  if (settings.upgrade_on_sync) items.push({ label: "upgrade", run: (ctx) => applyUpgrade(settings, ctx) });
  // Notify runs LAST, so its drift tally also counts any drift the earlier self-wiring items
  // surfaced (a stale skill), not just section drift.
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
  const fired = notify(
    ctx.env,
    "boom: drift detected",
    `${ctx.profile.host}: ${report.failures} failure(s), ${report.warnings} warning(s) — run \`boom source\``,
  );
  if (fired) report.ok(`notified: ${drift} drift item(s)`);
  else report.skip("drift found but no desktop notifier available");
}

export async function applyBoomSettings(
  settings: BoomSettings | undefined,
  ctx: ReconcileCtx,
): Promise<void> {
  if (!settings || !anyConfigured(settings)) return;
  ctx.report.header("boom self-wiring");
  await runWorkItems(boomWorkItems(settings), ctx);
}

// (Re)install the self-describing skill from the running binary, so it can't lag an upgrade of
// that binary. Sync regenerates (journaled); verify reports staleness; uninstall leaves it (it
// lives under the user's ~/.claude, not something boom should reclaim).
async function applySkill(ctx: ReconcileCtx): Promise<void> {
  if (ctx.verb === "uninstall") return;
  const { report } = ctx;
  const state = await skillState(ctx.env);
  if (!state) {
    report.skip("skill_on_sync — can't resolve the Claude config dir (HOME unset)");
    return;
  }
  const disp = displayPath(state.file, ctx.env);

  if (ctx.verb === "verify") {
    if (state.status === "current") report.skip(`skill current (v${VERSION})`);
    else report.warn(`skill ${state.status === "missing" ? "not installed" : "stale"} — sync refreshes it`);
    return;
  }
  // sync
  if (ctx.dryRun) {
    report.plan(`would refresh skill → ${disp}`);
    return;
  }
  if (state.status === "current") {
    report.skip(`skill current (v${VERSION})`);
    return;
  }
  // Journal the write in full before touching disk: displace a prior skill into the backup tree
  // (recoverable), or record a plain remove for a fresh install. The `done` row lands BEFORE the
  // write on purpose — a failure in between (the parent path existing as a regular file is
  // enough) would otherwise leave the displaced original in the backup tree with nothing naming it.
  await journalWrite("skill", state.file, ctx);
  await installSkill(state);
  report.ok(`refreshed skill → ${disp} (v${VERSION})`);
}

// Fold a release check into sync. Best-effort and offline-safe: a network hiccup surfaces
// nothing and never fails the sync. Sync-only.
async function applyUpgrade(settings: BoomSettings, ctx: ReconcileCtx): Promise<void> {
  const { report } = ctx;
  if (ctx.verb !== "sync") return;
  if (ctx.dryRun) {
    report.plan("would check for a newer boom release");
    return;
  }
  const latest = await fetchLatestVersion();
  if (!latest) {
    report.skip("upgrade check skipped (couldn't reach GitHub)");
    return;
  }
  if (compareVersions(latest, VERSION) <= 0) {
    report.skip(`boom is current (v${VERSION})`);
    return;
  }
  // `auto` used to call `boom upgrade`, which rewrote the binary in place. That verb is gone
  // (0.36): boom is installed by a package manager, and a binary that overwrites itself under
  // a managed prefix desynchronises that manager's manifest from what is on disk — the next
  // `brew upgrade` silently reverts it. Accepted, degraded to `check`, and said out loud so a
  // boomfile still carrying it is not quietly doing something other than what it asks for.
  if (settings.upgrade_on_sync === "auto") {
    report.note('`upgrade_on_sync = "auto"` is retired — treating it as "check" (see CHANGELOG.md#0360)');
  }
  report.warn(
    `newer boom v${latest} available (you have v${VERSION}) — upgrade it the way you installed it ` +
      "(`brew upgrade alxjrvs/boom/boom`, or re-run install.sh)",
  );
}
