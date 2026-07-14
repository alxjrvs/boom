// The `[boom]` table: machine-global, self-wiring behaviors folded into the reconcile boom
// already runs, so a consumer stops hand-rolling `run`/plist boilerplate for boom invoking
// boom. Applied once per run, after the sections, verb-aware:
//   sync    → install/refresh (regenerate the skill, (re)load timers, check/auto-upgrade)
//   verify  → report drift (skill stale, timer not loaded)
//   uninstall → tear down what boom installed (unload + remove timers; the skill is left)
// Each field is opt-in; an absent/empty `[boom]` table emits nothing.
// `skillDoc`/`skillInstallPath`/`fetchLatestVersion` live in `commands/*`, which transitively
// import the `cli.ts` route map — a static import here would form an engine→commands→cli
// cycle and read those exports in their temporal dead zone (same hazard catalog.ts documents).
// They're pulled in via a call-time dynamic import inside the async handlers below, past the
// cycle, instead.
import { basename, join } from "node:path";
import { detectOs } from "../config/profile.ts";
import type { BoomSettings } from "../config/schema.ts";
import { displayPath, mkdir, pathExists, rm } from "../lib/fs.ts";
import {
  agentLoaded,
  launchAgentsDir,
  parseInterval,
  reloadAgent,
  renderAgentPlist,
  unloadAgent,
} from "../lib/launchd.ts";
import { runArgv } from "../lib/proc.ts";
import { VERSION } from "../lib/version.ts";
import { boomStateDir } from "./state.ts";
import type { ReconcileCtx } from "./types.ts";

// Fixed labels for the boom-owned timers, so refresh/verify/uninstall find them
// deterministically without a state file.
const VERIFY_LABEL = "com.boomtube.verify";
const CODE_FETCH_LABEL = "com.boomtube.code-fetch";

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

// Any field configured (a non-false, non-undefined value)? Gates the header so an absent or
// all-off `[boom]` table stays silent.
function anyConfigured(s: BoomSettings): boolean {
  return Boolean(
    s.skill_on_sync ||
      s.upgrade_check_on_sync ||
      s.upgrade_auto_on_sync ||
      s.verify_schedule ||
      s.code_fetch_schedule,
  );
}

// The running boom binary — the ProgramArguments a timer invokes, and the guard against
// wiring a timer to `bun` during `bun run src/index.ts` dev (execPath is bun there).
function boomSelf(): string | undefined {
  const self = process.execPath;
  return basename(self) === "boom" ? self : undefined;
}

export async function applyBoomSettings(
  settings: BoomSettings | undefined,
  ctx: ReconcileCtx,
): Promise<void> {
  if (!settings || !anyConfigured(settings)) return;
  ctx.report.header("boom self-wiring");
  await applySkill(settings, ctx);
  await applyTimer(ctx, {
    on: Boolean(settings.verify_schedule),
    label: VERIFY_LABEL,
    interval: settings.verify_schedule,
    args: (self) => [self, "verify"],
    what: "scheduled verify",
  });
  await applyTimer(ctx, {
    on: Boolean(settings.code_fetch_schedule),
    label: CODE_FETCH_LABEL,
    interval: settings.code_fetch_schedule,
    args: (self) => [self, "code", "fetch"],
    what: "code fetch",
  });
  await applyUpgrade(settings, ctx);
}

// #55 — (re)install the self-describing skill from the running binary, so it can't lag a
// `boom upgrade`. Sync regenerates; verify reports staleness; uninstall leaves it (it lives
// under the user's ~/.claude, not something boom should reclaim).
async function applySkill(settings: BoomSettings, ctx: ReconcileCtx): Promise<void> {
  if (!settings.skill_on_sync) return;
  // The skill lives under the user's ~/.claude — boom refreshes it but never reclaims it, so
  // uninstall is a no-op (and skips the doc-gen import cost below entirely).
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
    if (current === doc) report.ok(`skill current (v${VERSION})`);
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
  await mkdir(join(file, ".."), { recursive: true });
  await Bun.write(file, doc);
  report.ok(`refreshed skill → ${disp} (v${VERSION})`);
}

interface TimerSpec {
  readonly on: boolean;
  readonly label: string;
  readonly interval?: string;
  readonly args: (self: string) => string[];
  readonly what: string;
}

// #57/#58 — own a launchd timer that runs boom (or `boom code fetch`) on an interval. macOS
// only (launchd); a no-op with a note elsewhere. The generated plist is deterministic, so an
// unchanged interval re-renders byte-identical and sync only reloads when it actually changed.
async function applyTimer(ctx: ReconcileCtx, spec: TimerSpec): Promise<void> {
  const { report } = ctx;
  const agents = launchAgentsDir(ctx.env);
  if (!agents) return;
  const plistPath = join(agents, `${spec.label}.plist`);

  // uninstall tears down even a now-disabled timer that boom previously installed, so it never
  // orphans an agent; sync/verify of an off timer is a no-op.
  if (ctx.verb === "uninstall") {
    if (!(await pathExists(plistPath))) return;
    if (ctx.dryRun) report.note(`would unload + remove ${spec.what} timer`);
    else {
      if (detectOs(ctx.env) === "darwin") unloadAgent(plistPath, ctx.env);
      await rm(plistPath, { force: true });
      report.ok(`removed ${spec.what} timer`);
    }
    return;
  }
  if (!spec.on || !spec.interval) return;

  if (detectOs(ctx.env) !== "darwin") {
    report.skip(`${spec.what} — scheduled timers are macOS-only`);
    return;
  }
  // A dry run previews the intent without needing a real boom binary to wire the timer to.
  if (ctx.dryRun) {
    report.plan(`would schedule ${spec.what} every ${spec.interval}`);
    return;
  }
  const self = boomSelf();
  if (!self) {
    report.skip(`${spec.what} — not a compiled boom binary (dev run); skipping timer`);
    return;
  }

  const logDir = join(boomStateDir(ctx.env), "logs");
  const log = join(logDir, `${spec.label}.log`);
  const plist = renderAgentPlist({
    label: spec.label,
    programArgs: spec.args(self),
    startInterval: parseInterval(spec.interval),
    stdoutPath: log,
    stderrPath: log,
  });

  if (ctx.verb === "verify") {
    const current = (await pathExists(plistPath)) ? await Bun.file(plistPath).text() : undefined;
    if (current !== plist) report.warn(`${spec.what} timer missing/outdated — sync installs it`);
    else if (!agentLoaded(spec.label, ctx.env)) report.warn(`${spec.what} timer installed but not loaded`);
    else report.ok(`${spec.what} every ${spec.interval}`);
    return;
  }
  // sync (non-dry)
  if ((await pathExists(plistPath)) && (await Bun.file(plistPath).text()) === plist) {
    // Byte-identical plist already in place; still ensure it's loaded (a reboot or manual
    // unload could have dropped it) but don't rewrite.
    if (agentLoaded(spec.label, ctx.env)) report.skip(`${spec.what} every ${spec.interval} (unchanged)`);
    else if (reloadAgent(plistPath, ctx.env)) report.ok(`reloaded ${spec.what} timer`);
    else report.fail(`${spec.what} timer present but launchctl load failed`);
    return;
  }
  await mkdir(logDir, { recursive: true });
  await Bun.write(plistPath, plist);
  if (reloadAgent(plistPath, ctx.env)) report.ok(`scheduled ${spec.what} every ${spec.interval}`);
  else report.fail(`wrote ${spec.what} plist but launchctl load failed`);
}

// #59 — fold an upgrade check (and optional auto-upgrade) into sync. Both are best-effort and
// offline-safe: a network hiccup surfaces nothing and never fails the sync. Sync-only.
async function applyUpgrade(settings: BoomSettings, ctx: ReconcileCtx): Promise<void> {
  if (!settings.upgrade_check_on_sync && !settings.upgrade_auto_on_sync) return;
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
    report.ok(`boom is current (v${VERSION})`);
    return;
  }
  if (settings.upgrade_auto_on_sync) {
    const self = boomSelf();
    if (!self) {
      report.note(`newer boom v${latest} available — run \`boom upgrade\` (dev run can't self-upgrade)`);
      return;
    }
    report.plan(`upgrading boom ${VERSION} → ${latest}`);
    const { code } = runArgv([self, "upgrade"], ctx.env, { quietStdout: ctx.json });
    if (code === 0) report.ok(`upgraded to v${latest}`);
    else report.warn(`auto-upgrade to v${latest} failed — run \`boom upgrade\` manually`);
    return;
  }
  report.warn(`newer boom v${latest} available (you have v${VERSION}) — run \`boom upgrade\``);
}
