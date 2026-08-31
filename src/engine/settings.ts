// The `[boom]` table: machine-global, self-wiring behaviors folded into the reconcile boom
// already runs, so a consumer stops hand-rolling `run`/plist boilerplate for boom invoking
// boom. Modelled as work items run through the *same* guarded loop as section resources
// (`runWorkItems`), verb-aware:
//   sync    → install/refresh (regenerate the skill, check/auto-upgrade)
//   verify  → report drift (skill stale) and notify on it
// Each field is opt-in; an absent/empty `[boom]` table emits nothing. Skill writes are
// journaled like any file mutation, so `boom rollback` reverses them.
//
// `schedule` lived here too, generating and reaping `com.boomtube.*` launchd timers. It was
// removed once its last consumer went; the `launchd` RESOURCE, which links and drives a
// user-authored plist, is unaffected and lives in engine/resources/launchd.ts.
import { basename, join } from "node:path";
import type { BoomSettings } from "../config/schema.ts";
import { displayPath, mkdir, pathExists } from "../lib/fs.ts";
import { notify } from "../lib/notify.ts";
import { runArgv } from "../lib/proc.ts";
import { fetchLatestVersion } from "../lib/release.ts";
import { compareVersions, VERSION } from "../lib/version.ts";
import { journalWrite } from "./journal.ts";
import { runWorkItems, type WorkItem } from "./registry.ts";
import { skillDoc, skillInstallPath } from "./skill.ts";
import type { ReconcileCtx } from "./types.ts";

// Any field configured? Gates the header so an absent or all-off `[boom]` table stays silent.
function anyConfigured(s: BoomSettings): boolean {
  return Boolean(s.skill_on_sync || s.upgrade_on_sync || s.notify);
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
  if (settings.upgrade_on_sync) items.push({ label: "upgrade", run: (ctx) => applyUpgrade(settings, ctx) });
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

// #59 — fold an upgrade check (and optional auto-upgrade) into sync. Both are best-effort and
// offline-safe: a network hiccup surfaces nothing and never fails the sync. Sync-only.
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
