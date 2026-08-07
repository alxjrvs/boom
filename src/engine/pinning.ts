// `boom lock` — record the *resolved* versions of the packages a boomfile declares, so a
// second machine (or the same machine later) can converge to the exact set this one runs,
// not just "latest at sync time". `brew bundle` / `mise install` pin nothing on their own;
// this captures what actually got installed into `boom.lock` in the config repo.
//
// Honest by construction: Homebrew can't hard-pin a formula to a past version, so this is a
// *record + drift report*, not an enforcer. `boom lock` writes the lockfile from the current
// machine; `boom lock --check` compares the installed versions against it and reports (0/2/1)
// where they've drifted — the reproducibility signal, without pretending brew can roll a
// formula back.
import { join } from "node:path";
import { loadConfig, NO_CONFIG_REPO_MSG, resolveConfigDir } from "../config/load.ts";
import type { Boomfile } from "../config/schema.ts";
import type { BoomContext } from "../context.ts";
import { pathExists } from "../lib/fs.ts";
import { captureArgv, hasCommand } from "../lib/proc.ts";
import { bandsReporter, type Reporter } from "../lib/reporter.ts";

// Resolved versions, grouped by manager. A plain name→version map per manager — enough to
// diff, small enough to read.
export interface Lock {
  readonly brew: Record<string, string>;
  readonly mise: Record<string, string>;
}

export function lockPath(repo: string): string {
  return join(repo, "boom.lock");
}

// The formula names a Brewfile declares (`brew "x"` lines). Casks are intentionally skipped —
// `brew list --versions` doesn't report them uniformly, and a cask's version is the app's, not
// a reproducibility knob boom can act on. Comments / other stanzas (`tap`, `mas`) are ignored.
async function brewFormulae(repo: string, file: string): Promise<string[]> {
  const text = await Bun.file(join(repo, file)).text();
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*brew\s+"([^"]+)"/);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

// Capture installed brew formula versions for the declared set. `brew list --versions <name>`
// prints "<name> <version> [older…]" (first token after the name is the active version), or
// exits non-zero for a formula that isn't installed — recorded as "missing" so a drift check
// can flag it rather than silently omitting it.
function brewVersions(names: readonly string[], env: BoomContext["env"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const r = captureArgv(["brew", "list", "--versions", name], env);
    const v = r.code === 0 ? r.stdout.split(/\s+/)[1] : undefined;
    out[name] = v ?? "missing";
  }
  return out;
}

// Capture the active mise tool versions for the config repo (`mise current` prints one
// "<tool> <version>" line per active tool). Best-effort: an older/newer mise whose output
// doesn't parse just yields fewer entries, never a crash.
function miseVersions(repo: string, env: BoomContext["env"]): Record<string, string> {
  const r = captureArgv(["mise", "current"], env, { cwd: repo });
  const out: Record<string, string> = {};
  if (r.code !== 0) return out;
  for (const line of r.stdout.split("\n")) {
    const [tool, version] = line.trim().split(/\s+/);
    if (tool && version) out[tool] = version;
  }
  return out;
}

// Resolve the lock from the machine, driven by what the config declares. Only managers the
// boomfile actually uses are probed, and each is skipped (with a report line) when its tool
// isn't on PATH — a lock is a snapshot of reality, so an absent manager contributes nothing.
async function resolveLock(
  repo: string,
  config: Boomfile,
  ctx: BoomContext,
  report: Reporter,
): Promise<Lock> {
  const pkgs = config.section.flatMap((s) => s.pkg ?? []);
  const brew: Record<string, string> = {};
  const mise: Record<string, string> = {};

  const brewFiles = pkgs.filter((p) => p.manager === "brew");
  if (brewFiles.length > 0) {
    if (!hasCommand("brew", ctx.env)) report.warn("brew declared but not on PATH — skipping brew versions");
    else
      for (const p of brewFiles) {
        const names = await brewFormulae(repo, p.file ?? "Brewfile").catch(() => [] as string[]);
        Object.assign(brew, brewVersions(names, ctx.env));
      }
  }
  if (pkgs.some((p) => p.manager === "mise")) {
    if (!hasCommand("mise", ctx.env)) report.warn("mise declared but not on PATH — skipping mise versions");
    else Object.assign(mise, miseVersions(repo, ctx.env));
  }
  return { brew, mise };
}

// --- lockfile IO -------------------------------------------------------------------------

// Serialize a manager's map as a TOML table with *quoted* keys — formula/tool names can carry
// `@` (`node@20`, `python@3.12`), which a TOML bare key forbids, so quoting is always correct.
function tomlTable(name: string, map: Record<string, string>): string {
  const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const keys = Object.keys(map).sort();
  const lines = keys.map((k) => `"${esc(k)}" = "${esc(map[k] as string)}"`);
  return `[${name}]\n${lines.join("\n")}\n`;
}

function serializeLock(lock: Lock): string {
  return [
    "# boom.lock — resolved package versions, written by `boom lock`.",
    "# A record for reproducibility + `boom lock --check` drift detection, not a hard pin.",
    "",
    tomlTable("brew", lock.brew),
    tomlTable("mise", lock.mise),
  ].join("\n");
}

export async function writeLock(repo: string, lock: Lock): Promise<void> {
  await Bun.write(lockPath(repo), serializeLock(lock));
}

// Read + parse boom.lock, or undefined when absent. Uses smol-toml (already a dep); a malformed
// lock throws, surfaced to the user as a failure rather than silently treated as empty.
export async function readLock(repo: string): Promise<Lock | undefined> {
  const file = lockPath(repo);
  if (!(await pathExists(file))) return undefined;
  const { parse } = await import("smol-toml");
  const raw = parse(await Bun.file(file).text()) as {
    brew?: Record<string, string>;
    mise?: Record<string, string>;
  };
  return { brew: raw.brew ?? {}, mise: raw.mise ?? {} };
}

// Report where installed versions diverge from the lock: a changed version, or a locked entry
// no longer installed. New-but-unlocked packages aren't drift against the lock (re-run `boom
// lock` to capture them), so they're noted, not warned.
function reportDrift(
  manager: string,
  locked: Record<string, string>,
  now: Record<string, string>,
  report: Reporter,
): void {
  for (const [name, want] of Object.entries(locked)) {
    const have = now[name];
    if (have === undefined) report.warn(`${manager} ${name} locked ${want} but not installed`);
    else if (have !== want) report.warn(`${manager} ${name} ${have} — locked ${want}`);
    else report.skip(`${manager} ${name} ${want}`);
  }
  const extra = Object.keys(now).filter((n) => !(n in locked));
  if (extra.length > 0) report.note(`${manager}: ${extra.length} installed but unlocked (run \`boom lock\`)`);
}

// --- command entry -----------------------------------------------------------------------

export async function boomLock(ctx: BoomContext, check = false, json = false): Promise<number> {
  const report = bandsReporter(ctx.process, ctx.env, "lock", {
    json,
    setup: check ? "AUDITING THE LOCKFILE…" : "PINNING RESOLVED VERSIONS…",
  });
  // The one finish for both surfaces: --json writes the shared envelope (with the same
  // warning-tier flag), human output the bands verdict — so the two agree on exit codes.
  const finish = (msgs: Parameters<Reporter["finish"]>[0]): number =>
    json ? report.finishJson(ctx.process.stdout, msgs.warn !== undefined) : report.finish(msgs);

  const repo = await resolveConfigDir(ctx.env, ctx.cwd);
  if (!repo) {
    report.fail(NO_CONFIG_REPO_MSG);
    return finish({ ok: "lock done", fail: (f) => `lock: ${f} failure(s)` });
  }
  let config: Boomfile;
  try {
    config = await loadConfig(repo);
  } catch (e) {
    report.fail((e as Error).message);
    return finish({ ok: "lock done", fail: (f) => `lock: ${f} failure(s)` });
  }

  const now = await resolveLock(repo, config, ctx, report);
  const total = Object.keys(now.brew).length + Object.keys(now.mise).length;

  if (check) {
    report.header("Lock drift");
    const locked = await readLock(repo);
    if (!locked) {
      report.warn("no boom.lock yet — run `boom lock` to create one");
      return finish({
        ok: "lock: in sync",
        warn: (w) => `lock: ${w} drift(s)`,
        fail: (f, w) => `lock: ${f} failure(s), ${w} drift(s)`,
      });
    }
    reportDrift("brew", locked.brew, now.brew, report);
    reportDrift("mise", locked.mise, now.mise, report);
    return finish({
      ok: "lock: in sync with boom.lock",
      warn: (w) => `lock: ${w} version drift(s) — run \`boom lock\` to re-pin`,
      fail: (f, w) => `lock: ${f} failure(s), ${w} drift(s)`,
    });
  }

  await writeLock(repo, now);
  report.header("Locked");
  report.ok(`wrote boom.lock — ${total} package(s) pinned`);
  report.note("commit it with: boom source push");
  return finish({ ok: `lock: ${total} package(s) pinned`, fail: (f) => `lock: ${f} failure(s)` });
}
