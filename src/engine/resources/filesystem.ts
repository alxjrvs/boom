// Filesystem resources: link + copy. One `file` shape, two placement strategies (symlink
// vs byte-copy). `src` may be a single repo path or a glob pattern — a glob expands to one
// placement per match, `dst` treated as a directory, structure preserved below the pattern's
// static prefix. `copy` additionally supports `expand` (render ${env:VAR}/${host}/${os}).
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { detectOs } from "../../config/profile.ts";
import type { File } from "../../config/schema.ts";
import {
  chmod,
  copyFile,
  displayPath,
  ensureSymlink,
  expandTilde,
  filesEqual,
  linkTarget,
  mkdir,
  pathExists,
  rm,
  stat,
} from "../../lib/fs.ts";
import { displace, type UndoToken } from "../journal.ts";
import type { LinkMode, ReconcileCtx } from "../types.ts";

// A resolved src→dst pair. `srcRel` (the repo-relative path) is carried only for legible
// messages — the abs `src` is what the filesystem calls use.
interface Placement {
  readonly src: string;
  readonly dst: string;
  readonly srcRel: string;
}

// The glob metacharacters Bun.Glob honors. A plain path contains none, so a single-file
// entry never pays the scan cost or the directory-dst semantics.
const GLOB_MAGIC = /[*?[\]{}]/;

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
  if (!GLOB_MAGIC.test(entry.src)) {
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
  if (out.length === 0 && ctx.verb !== "uninstall") {
    ctx.report.warn(`${kind} ${entry.src} — glob matched no files`);
  }
  return out;
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
  await ctx.journal?.intent("mkdir", dir);
  const undo = await displace(dir, ctx.backupRoot, true);
  // Record the undo BEFORE the create: displace has already moved the conflicting file into
  // the backup tree, so if mkdir throws (or the process dies) the `done` row is what lets
  // rollback restore it. Writing `done` only after a successful create leaves that displaced
  // file orphaned with no journal row pointing at it — unrecoverable.
  await ctx.journal?.done("mkdir", dir, undo);
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
  // fires only after the create succeeds.
  if (!conflict) {
    await ctx.journal?.intent("link", dst);
    await ctx.journal?.done("link", dst, { kind: "remove" });
    await ensureSymlink(src, dst);
    report.ok(`${disp} linked`);
    return;
  }
  if (mode === "overwrite") {
    await ctx.journal?.intent("link", dst);
    const undo = await displace(dst, ctx.backupRoot, true);
    await ctx.journal?.done("link", dst, undo);
    await ensureSymlink(src, dst);
    report.ok(`${disp} overwritten`);
    return;
  }
  // skip: never clobber a file boom doesn't own.
  report.skip(`${disp} exists but is not our symlink — skipped`);
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
          // best-effort, mirrors the bash `|| true`
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
        await rm(dst, { force: true });
        report.ok(`${disp} removed`);
      }
      return;
    }
  }
}

// Substitute `${env:VAR}` / `${host}` / `${os}` in an `expand`ed copy's content. Unknown
// `${env:…}` resolves to empty; unmatched `${…}` is left verbatim (so a literal shell
// `${...}` in a config survives). The escape hatch for per-machine content without a hook.
function renderTemplate(text: string, ctx: ReconcileCtx): string {
  return text
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => ctx.env[name] ?? "")
    .replace(/\$\{host\}/g, () => hostname())
    .replace(/\$\{os\}/g, () => detectOs(ctx.env));
}

export async function reconcileCopy(entry: File, ctx: ReconcileCtx): Promise<void> {
  for (const p of await placements(entry, "copy", ctx)) await copyOne(entry, p, ctx);
}

async function copyOne(entry: File, place: Placement, ctx: ReconcileCtx): Promise<void> {
  const { src, dst, srcRel } = place;
  ctx.declared.push({ kind: "copy", dst, src });
  const disp = displayPath(dst, ctx.env);
  const { report } = ctx;
  const expand = entry.expand === true;

  // Is dst already the intended content? (rendered content when expand; a plain byte-compare
  // otherwise, which stays a cheap filesEqual with no read of the whole file).
  const current = async (): Promise<boolean> => {
    if (!(await pathExists(dst))) return false;
    if (!expand) return filesEqual(src, dst);
    return (await Bun.file(dst).text()) === renderTemplate(await Bun.file(src).text(), ctx);
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
        report.skip(`${disp} already up to date`);
        return;
      }
      if (ctx.dryRun) {
        report.plan(`${disp} would be copied`);
        return;
      }
      await ctx.journal?.intent("copy", dst);
      // Only displace when a file is actually there; with no backup root the undo is a plain
      // remove of the copy we're about to write. Recorded before the write (same rationale as
      // applyLink): if it throws after a displace, rollback still restores the original.
      const undo: UndoToken = (await pathExists(dst))
        ? await displace(dst, ctx.backupRoot, true)
        : { kind: "remove" };
      await ctx.journal?.done("copy", dst, undo);
      await mkdir(dirname(dst), { recursive: true });
      if (expand) await Bun.write(dst, renderTemplate(await Bun.file(src).text(), ctx));
      else await copyFile(src, dst);
      await chmod(dst, await wantMode());
      report.ok(`${disp} copied`);
      return;
    }
    case "verify": {
      if (!(await pathExists(src))) {
        report.fail(`${disp} ← ${srcRel} (source missing)`);
        return;
      }
      if (await current()) report.skip(`${disp} (copy current)`);
      else report.warn(`${disp} copy missing/stale`);
      return;
    }
    case "uninstall": {
      // Only remove a copy we still own — one that still matches what boom would write.
      if (!(await current())) return;
      if (ctx.dryRun) report.note(`would remove ${disp}`);
      else {
        await rm(dst, { force: true });
        report.ok(`${disp} removed`);
      }
      return;
    }
  }
}
