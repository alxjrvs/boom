// Filesystem resources: link, copy, glob. Ports the semantics of engine/run's
// link()/copy()/glob() + lib.sh _symlink to TypeScript.
import { basename, dirname, join } from "node:path";
import type { Glob, Link } from "../../config/schema.ts";
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

// mkdir(dir, {recursive:true}) only no-ops when `dir` already exists AND is a real
// directory — if it's a stale non-directory (a broken symlink, or a symlink to a file,
// left over from e.g. an earlier whole-directory `link` config now switched to `glob`)
// it throws EEXIST instead. Clear that conflict the same way applyLink's overwrite mode
// clears a conflicting `dst`, so a `link`→`glob` migration self-heals instead of crashing.
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

export async function reconcileLink(entry: Link, ctx: ReconcileCtx): Promise<void> {
  const src = join(ctx.repo, entry.src);
  const dst = expandTilde(entry.dst, ctx.env);
  ctx.declared.push({ kind: "link", dst, src });
  const disp = displayPath(dst, ctx.env);
  const { report } = ctx;

  switch (ctx.verb) {
    case "sync": {
      await applyLink(src, dst, disp, ctx.linkMode, ctx);
      // `mode` on a link sets the *target's* mode (chmod follows the symlink to the
      // repo file) — which is exactly what tools reading through the link, e.g. ssh on
      // ~/.ssh/config, check. Only do it once the link is ours: if applyLink skipped a
      // foreign file, chmod-ing it would mutate a file boom doesn't own.
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
        if (entry.mode) {
          const perms = (await stat(dst)).mode & 0o777;
          if (perms === Number.parseInt(entry.mode, 8)) report.ok(`${disp} (mode ${entry.mode})`);
          else report.warn(`${disp} mode ${perms.toString(8)}, expected ${entry.mode}`);
        } else {
          report.ok(disp);
        }
      } else if (t === undefined && !(await pathExists(dst))) {
        report.fail(`${disp} not linked (→ ${entry.src})`);
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

export async function reconcileCopy(entry: Link, ctx: ReconcileCtx): Promise<void> {
  const src = join(ctx.repo, entry.src);
  const dst = expandTilde(entry.dst, ctx.env);
  ctx.declared.push({ kind: "copy", dst, src });
  const disp = displayPath(dst, ctx.env);
  const { report } = ctx;
  const mode = entry.mode ? Number.parseInt(entry.mode, 8) : 0o755;

  switch (ctx.verb) {
    case "sync": {
      // Mirrors link's "already linked" skip and osx's change-gate: re-copying,
      // re-chmoding, journaling, and backing up an already-current file every run
      // violates the one-loop verb contract (verify already calls this state "copy
      // current") and churns a fresh retained backup of an unchanged file each sync.
      if (await filesEqual(src, dst)) {
        report.skip(`${disp} already up to date`);
        return;
      }
      if (ctx.dryRun) {
        report.plan(`${disp} would be copied`);
        return;
      }
      await ctx.journal?.intent("copy", dst);
      // Only displace when a file is actually there (copyFile overwrites in place); with no
      // backup root the undo is a plain remove of the copy we're about to write.
      const undo: UndoToken = (await pathExists(dst))
        ? await displace(dst, ctx.backupRoot, true)
        : { kind: "remove" };
      // Record the undo before the copy (same rationale as applyLink): if copyFile/chmod
      // throws after a displace, rollback still restores the displaced original.
      await ctx.journal?.done("copy", dst, undo);
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
      await chmod(dst, mode);
      report.ok(`${disp} copied`);
      return;
    }
    case "verify": {
      if (await filesEqual(src, dst)) report.ok(`${disp} (copy current)`);
      else report.warn(`${disp} copy missing/stale`);
      return;
    }
    case "uninstall": {
      if (!(await filesEqual(src, dst))) return;
      if (ctx.dryRun) report.note(`would remove ${disp}`);
      else {
        await rm(dst, { force: true });
        report.ok(`${disp} removed`);
      }
      return;
    }
  }
}

export async function reconcileGlob(entry: Glob, ctx: ReconcileCtx): Promise<void> {
  const into = expandTilde(entry.into, ctx.env);
  const glob = new Bun.Glob(entry.pattern);
  for await (const rel of glob.scan({ cwd: ctx.repo, onlyFiles: false, dot: true })) {
    await reconcileLink({ src: rel, dst: join(into, basename(rel)) }, ctx);
  }
}
