// Filesystem resources: link, copy, glob. Ports the semantics of engine/run's
// link()/copy()/glob() + lib.sh _symlink to TypeScript.
import { basename, dirname, join } from "node:path";
import type { Glob, Link } from "../../config/schema.ts";
import {
  backupTo,
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
import type { UndoToken } from "../journal.ts";
import type { LinkMode, ReconcileCtx } from "../types.ts";

async function applyLink(
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
  if (ctx.resumeDone?.has(dst)) {
    report.skip(`${disp} (resumed — already applied)`);
    return;
  }
  if (!conflict) {
    await ctx.journal?.intent("link", dst);
    await ensureSymlink(src, dst);
    await ctx.journal?.done("link", dst, { kind: "remove" });
    report.ok(`${disp} linked`);
    return;
  }
  if (mode === "overwrite") {
    await ctx.journal?.intent("link", dst);
    const undo: UndoToken = ctx.backupRoot
      ? { kind: "restore", from: await backupTo(dst, ctx.backupRoot) }
      : { kind: "remove" };
    if (!ctx.backupRoot) await rm(dst, { recursive: true, force: true });
    await ensureSymlink(src, dst);
    await ctx.journal?.done("link", dst, undo);
    report.ok(`${disp} overwritten`);
    return;
  }
  // skip: never clobber a file botu doesn't own.
  report.skip(`${disp} exists but is not our symlink — skipped`);
}

export async function reconcileLink(entry: Link, ctx: ReconcileCtx): Promise<void> {
  const src = join(ctx.repo, entry.src);
  const dst = expandTilde(entry.dst, ctx.env);
  ctx.declared.push({ kind: "link", dst, src });
  const disp = displayPath(dst, ctx.env);
  const { report } = ctx;

  switch (ctx.verb) {
    case "apply":
    case "fix": {
      const mode: LinkMode = ctx.verb === "fix" ? "overwrite" : ctx.linkMode;
      await applyLink(src, dst, disp, mode, ctx);
      // `mode` on a link sets the *target's* mode (chmod follows the symlink to the
      // repo file) — which is exactly what tools reading through the link, e.g. ssh on
      // ~/.ssh/config, check. Only do it once the link is ours: if applyLink skipped a
      // foreign file, chmod-ing it would mutate a file botu doesn't own.
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
    case "apply":
    case "fix": {
      if (ctx.dryRun) {
        report.plan(`${disp} would be copied`);
        return;
      }
      if (ctx.resumeDone?.has(dst)) {
        report.skip(`${disp} (resumed — already applied)`);
        return;
      }
      await ctx.journal?.intent("copy", dst);
      let undo: UndoToken = { kind: "remove" };
      if ((await pathExists(dst)) && ctx.backupRoot) {
        undo = { kind: "restore", from: await backupTo(dst, ctx.backupRoot) };
      }
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
      await chmod(dst, mode);
      await ctx.journal?.done("copy", dst, undo);
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
