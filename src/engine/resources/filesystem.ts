// Filesystem resources: link + copy. One `file` shape, two placement strategies (symlink
// vs byte-copy). `src` may be a single repo path or a glob pattern — a glob expands to one
// placement per match, `dst` treated as a directory, structure preserved below the pattern's
// static prefix. Neither places rendered content — that is `tmpl` (template.ts).
import { chmod, copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { File } from "../../config/schema.ts";
import {
  displayPath,
  ensureSymlink,
  expandTilde,
  filesEqual,
  GLOB_MAGIC,
  isGlobPattern,
  linkTarget,
  pathExists,
} from "../../lib/fs.ts";
import { journalRemove, journalWrite } from "../journal.ts";
import type { LinkMode, ReconcileCtx } from "../types.ts";

// A resolved src→dst pair. `srcRel` (the repo-relative path) is carried only for legible
// messages — the abs `src` is what the filesystem calls use.
interface Placement {
  readonly src: string;
  readonly dst: string;
  readonly srcRel: string;
}

// The static prefix directory of a glob pattern — everything up to the last `/` before the
// first magic segment. A match is placed relative to this, so `nvim/**/*.lua` keeps its
// `lua/…` structure under `dst` instead of every match flattening onto its basename and
// silently colliding.
function globBase(pattern: string): string {
  const base: string[] = [];
  for (const seg of pattern.split("/")) {
    if (GLOB_MAGIC.test(seg)) break;
    base.push(seg);
  }
  return base.length ? `${base.join("/")}/` : "";
}

// Resolve an entry to concrete placements. A non-glob src is exactly one (its file may be
// missing — the caller reports that, and never creates a dangling link). A glob expands to
// one per match; zero matches warns (a typo'd pattern is otherwise indistinguishable from
// success), except on uninstall where "nothing to remove" is a legitimate no-op.
async function placements(entry: File, kind: string, ctx: ReconcileCtx): Promise<Placement[]> {
  if (!isGlobPattern(entry.src)) {
    return [{ src: join(ctx.repo, entry.src), dst: expandTilde(entry.dst, ctx.env), srcRel: entry.src }];
  }
  const base = globBase(entry.src);
  const into = expandTilde(entry.dst, ctx.env);
  const out: Placement[] = [];
  const glob = new Bun.Glob(entry.src);
  for await (const rel of glob.scan({ cwd: ctx.repo, onlyFiles: false, dot: true })) {
    const sub = rel.startsWith(base) ? rel.slice(base.length) : basename(rel);
    out.push({ src: join(ctx.repo, rel), dst: join(into, sub), srcRel: rel });
  }
  // Drop any match that is an ancestor directory of another match in the same expansion.
  // The hazard is `**`, which returns a directory AND its descendants: boom would symlink the
  // directory itself into `dst`, and the very next placement's `dst` then resolves THROUGH that
  // fresh symlink back into the repo — so under `--fix` the repo's own sources get displaced
  // into the backup tree and replaced with self-referential links. `onlyFiles: true` is NOT the
  // fix: globbing a directory to link it whole (`skills/*` matching `skills/pack`) is a
  // supported case, and it survives here because no descendant of it is also a match.
  const parents = new Set<string>();
  for (const p of out) {
    for (let d = dirname(p.srcRel); d !== "." && d !== "/"; d = dirname(d)) parents.add(d);
  }
  const kept = out.filter((p) => !parents.has(p.srcRel));
  if (kept.length === 0 && ctx.verb !== "uninstall") {
    ctx.report.warn(`${kind} ${entry.src} — glob matched no files`);
  }
  return kept;
}

// Would placing a link at `dst` write inside the config repo? Then the placement is broken —
// boom would be linking the repo into itself and (under overwrite) displacing its own sources.
// Two gotchas: `dst` usually does not exist yet, so the question has to be asked of its nearest
// EXISTING ancestor, which is also what catches a dst that reaches the repo through a
// pre-existing symlink; and `repo` must be realpath'ed too, because on macOS `$TMPDIR`/`/var`
// resolve through `/private` — a raw string compare would silently never match, and every
// sandboxed test would pass vacuously.
async function landsInRepo(dst: string, repo: string): Promise<boolean> {
  const root = await realpath(repo).catch(() => repo);
  let dir = dirname(dst);
  for (;;) {
    const real = await realpath(dir).catch(() => undefined);
    if (real !== undefined) return real === root || real.startsWith(`${root}/`);
    const up = dirname(dir);
    if (up === dir) return false; // walked to the filesystem root without finding anything
    dir = up;
  }
}

// mkdir(dir, {recursive:true}) only no-ops when `dir` already exists AND is a real
// directory — if it's a stale non-directory (a broken symlink, or a symlink to a file,
// left over from e.g. an earlier whole-directory `link` config now switched to a glob)
// it throws EEXIST instead. Clear that conflict the same way applyLink's overwrite mode
// clears a conflicting `dst`, so a link→glob migration self-heals instead of crashing.
// Returns false (caller should skip) when the conflict exists but `mode` forbids clobbering it.
async function ensureParentDir(dir: string, mode: LinkMode, ctx: ReconcileCtx): Promise<boolean> {
  if (!(await pathExists(dir))) return true; // mkdir will create it fresh below
  if ((await stat(dir).catch(() => undefined))?.isDirectory()) return true;
  if (mode !== "overwrite") return false;
  // Undo BEFORE the create, via the one helper that owns that ordering: displace moves the
  // conflicting file into the backup tree, so if mkdir throws (or the process dies) the rows
  // journalWrite wrote are what say where it went. Inlining this sequence is what used to
  // leave the intent row's undo NULL, which both orphan readers skip.
  await journalWrite("mkdir", dir, ctx, true);
  await mkdir(dir, { recursive: true });
  return true;
}

// Exported so the `launchd` resource can reuse the exact journaled link discipline (skip vs
// overwrite, undo-before-create) for placing its plist, then layer launchctl on top.
export async function applyLink(
  src: string,
  dst: string,
  disp: string,
  mode: LinkMode,
  ctx: ReconcileCtx,
): Promise<void> {
  const { report } = ctx;
  // Ahead of the already-linked skip and the dry-run branch, both deliberately. An existing
  // self-referential link IS the damaged state this refusal exists to prevent, so reporting it
  // as "already linked" would launder the damage; and running in dry-run means `--fix --dry-run`
  // surfaces a broken glob before anyone applies it.
  if (await landsInRepo(dst, ctx.repo)) {
    report.fail(`${disp} resolves inside the config repo — refusing to link the repo into itself`);
    return;
  }
  if ((await linkTarget(dst)) === src) {
    report.skip(`${disp} already linked`);
    return;
  }
  const conflict = await pathExists(dst);
  if (ctx.dryRun) {
    if (conflict && mode === "overwrite") report.plan(`${disp} would overwrite an existing file`);
    else if (conflict) report.plan(`${disp} exists but is not our symlink — would be skipped`);
    else report.plan(`${disp} would be linked`);
    return;
  }
  if (!(await ensureParentDir(dirname(dst), mode, ctx))) {
    report.skip(`${disp} parent exists but is not a directory — skipped`);
    return;
  }
  // In both branches the `done` (undo) row is written BEFORE ensureSymlink — the create is
  // the wide, fail-prone window (I/O that can throw or hang). Journalling the undo first
  // means a crash mid-create is still reversible: for a fresh link the undo is a plain
  // remove (a no-op if the link was never created); for an overwrite the displaced original
  // is already in the backup tree with a `done` row that restores it. `report.ok` still
  // fires only after the create succeeds. That invariant is worthless if `dst` is itself a
  // repo source — "restore the displaced original" would mean restoring boom's own INPUT, and
  // the run would have moved the repo into the backup tree to make room for links pointing at
  // it. Hence the landsInRepo refusal above: this discipline assumes dst is outside the repo.
  // skip: never clobber a file boom doesn't own.
  if (conflict && mode !== "overwrite") {
    report.skip(`${disp} exists but is not our symlink — skipped`);
    return;
  }
  // One call for both arms: journalWrite picks the undo from what is actually at `dst` — a
  // plain remove for a fresh link, a restore-from-backup for a displaced original — and writes
  // it as the intent's plan token as well as the `done` row.
  await journalWrite("link", dst, ctx, true);
  await ensureSymlink(src, dst);
  report.ok(conflict ? `${disp} overwritten` : `${disp} linked`);
}

export async function reconcileLink(entry: File, ctx: ReconcileCtx): Promise<void> {
  for (const p of await placements(entry, "link", ctx)) await linkOne(entry, p, ctx);
}

async function linkOne(entry: File, place: Placement, ctx: ReconcileCtx): Promise<void> {
  const { src, dst, srcRel } = place;
  ctx.declared.push({ kind: "link", dst, src });
  const disp = displayPath(dst, ctx.env);
  const { report } = ctx;

  switch (ctx.verb) {
    case "sync": {
      // Never create a dangling link: a src that isn't in the repo (deleted file, typo) would
      // otherwise become a symlink pointing at nothing. Report it and move on.
      if (!(await pathExists(src))) {
        report.fail(`${disp} → ${srcRel} (source missing — not linked)`);
        return;
      }
      await applyLink(src, dst, disp, ctx.linkMode, ctx);
      // `mode` on a link sets the *target's* mode (chmod follows the symlink to the repo
      // file) — what tools reading through the link (e.g. ssh on ~/.ssh/config) check. Only
      // once the link is ours: if applyLink skipped a foreign file, chmod-ing it would mutate
      // a file boom doesn't own.
      if (entry.mode && !ctx.dryRun && (await linkTarget(dst)) === src) {
        try {
          await chmod(dst, Number.parseInt(entry.mode, 8));
        } catch {
          // best-effort: a mode the target's filesystem refuses is not a broken link
        }
      }
      return;
    }
    case "verify": {
      const t = await linkTarget(dst);
      if (t === src) {
        // Our link — but is it dangling? A repo file deleted without editing the boomfile
        // leaves a live symlink to a now-missing source; verify must not pass that as ok.
        if (!(await pathExists(src))) {
          report.fail(`${disp} → ${srcRel} (dangling — source missing)`);
        } else if (entry.mode) {
          const perms = (await stat(dst)).mode & 0o777;
          if (perms === Number.parseInt(entry.mode, 8)) report.skip(`${disp} (mode ${entry.mode})`);
          else report.warn(`${disp} mode ${perms.toString(8)}, expected ${entry.mode}`);
        } else {
          report.skip(disp);
        }
      } else if (t === undefined && !(await pathExists(dst))) {
        report.fail(`${disp} not linked (→ ${srcRel})`);
      } else if (t === undefined) {
        report.fail(`${disp} exists but is not our symlink`);
      } else {
        report.fail(`${disp} → ${t}, expected ${src}`);
      }
      return;
    }
    case "uninstall": {
      if ((await linkTarget(dst)) !== src) return;
      if (ctx.dryRun) report.note(`would remove ${disp}`);
      else {
        await journalRemove("link-rm", dst, ctx);
        report.ok(`${disp} removed`);
      }
      return;
    }
  }
}

export async function reconcileCopy(entry: File, ctx: ReconcileCtx): Promise<void> {
  for (const p of await placements(entry, "copy", ctx)) await copyOne(entry, p, ctx);
}

async function copyOne(entry: File, place: Placement, ctx: ReconcileCtx): Promise<void> {
  const { src, dst, srcRel } = place;
  ctx.declared.push({ kind: "copy", dst, src });
  const disp = displayPath(dst, ctx.env);
  const { report } = ctx;

  // Is dst already the intended content? A byte-compare — cheap, and a copy's intended content
  // is exactly its source's.
  const current = async (): Promise<boolean> => {
    if (!(await pathExists(dst))) return false;
    return filesEqual(src, dst);
  };

  // Desired dst mode: explicit, else preserve the *source's* mode — copyFile/Bun.write don't,
  // so an unqualified copy used to land as 0o755 (executable). Predictable beats surprising.
  const wantMode = async (): Promise<number> =>
    entry.mode ? Number.parseInt(entry.mode, 8) : (await stat(src)).mode & 0o777;

  switch (ctx.verb) {
    case "sync": {
      if (!(await pathExists(src))) {
        report.fail(`${disp} ← ${srcRel} (source missing — not copied)`);
        return;
      }
      // Mirrors link's "already linked" skip and osx's change-gate: re-writing, re-chmoding,
      // journaling, and backing up an already-current file every run violates the one-loop
      // verb contract (verify already calls this state "copy current") and churns a fresh
      // retained backup of an unchanged file each sync.
      if (await current()) {
        // Content is current — but the mode still has to be enforced, or a copy whose
        // permissions drifted looser is never repaired: this gate returns before the chmod
        // below, so `--fix` is a no-op and `verify` (which calls the same `current()`) is
        // blind. A copied `~/.ssh/config` left 0777 stays 0777 forever. Re-chmod only —
        // no rewrite, no journal churn, no fresh backup.
        const want = await wantMode();
        if (((await stat(dst)).mode & 0o777) !== want) {
          if (ctx.dryRun) {
            report.plan(`${disp} mode would be set to 0${want.toString(8)}`);
            return;
          }
          await chmod(dst, want);
          report.ok(`${disp} mode set to 0${want.toString(8)}`);
          return;
        }
        report.skip(`${disp} already up to date`);
        return;
      }
      if (ctx.dryRun) {
        report.plan(`${disp} would be copied`);
        return;
      }
      // journalWrite only displaces when a file is actually there; with no backup root the undo
      // is a plain remove of the copy we're about to write. Recorded before the write (same
      // rationale as applyLink): if it throws after a displace, a row still names the original.
      await journalWrite("copy", dst, ctx, true);
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
      await chmod(dst, await wantMode());
      report.ok(`${disp} copied`);
      return;
    }
    case "verify": {
      if (!(await pathExists(src))) {
        report.fail(`${disp} ← ${srcRel} (source missing)`);
        return;
      }
      if (!(await current())) {
        report.warn(`${disp} copy missing/stale`);
        return;
      }
      // Content current — check mode too, so verify reports the drift sync now repairs.
      // `link`'s verify has always done this (see the mode branch above); copy was the outlier.
      const want = await wantMode();
      const perms = (await stat(dst)).mode & 0o777;
      if (perms !== want) report.warn(`${disp} mode ${perms.toString(8)}, expected ${want.toString(8)}`);
      else report.skip(`${disp} (copy current)`);
      return;
    }
    case "uninstall": {
      // Only remove a copy we still own — one that still matches what boom would write.
      if (!(await current())) return;
      if (ctx.dryRun) report.note(`would remove ${disp}`);
      else {
        await journalRemove("copy-rm", dst, ctx);
        report.ok(`${disp} removed`);
      }
      return;
    }
  }
}
