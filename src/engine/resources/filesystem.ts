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
  if (ctx.dryRun) {
    report.plan(`${disp} would be linked`);
    return;
  }
  if (!(await pathExists(dst))) {
    await ensureSymlink(src, dst);
    report.ok(`${disp} linked`);
    return;
  }
  if (mode === "overwrite") {
    await rm(dst, { recursive: true, force: true });
    await ensureSymlink(src, dst);
    report.ok(`${disp} overwritten`);
    return;
  }
  // skip / interactive(non-tty): never clobber a file botu doesn't own.
  report.skip(`${disp} exists but is not our symlink — skipped`);
}

export async function reconcileLink(entry: Link, ctx: ReconcileCtx): Promise<void> {
  const src = join(ctx.repo, entry.src);
  const dst = expandTilde(entry.dst, ctx.env);
  ctx.declared.push(dst);
  const disp = displayPath(dst, ctx.env);
  const { report } = ctx;

  switch (ctx.verb) {
    case "apply":
    case "fix": {
      const mode: LinkMode = ctx.verb === "fix" ? "overwrite" : ctx.linkMode;
      await applyLink(src, dst, disp, mode, ctx);
      if (entry.mode && !ctx.dryRun && (await pathExists(dst))) {
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
  ctx.declared.push(dst);
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
