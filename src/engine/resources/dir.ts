// The `dir` resource: ensure a standalone directory exists (with an optional mode) — the
// declarative form of a `run` + `mkdir -p`/`chmod`, for a directory with no file to place in
// it (a link/copy creates parents implicitly, but can't declare an empty dir). Uninstall
// leaves it by default (dirs may hold user data); `remove_on_uninstall = true` removes it
// *if empty*.
import { readdir, rmdir } from "node:fs/promises";
import type { Dir } from "../../config/schema.ts";
import { chmod, displayPath, expandTilde, mkdir, pathExists, stat } from "../../lib/fs.ts";
import type { ReconcileCtx } from "../types.ts";

// Current mode bits (octal string) of a path, or undefined if unreadable.
async function modeOf(path: string): Promise<string | undefined> {
  const st = await stat(path).catch(() => undefined);
  return st ? (st.mode & 0o777).toString(8) : undefined;
}

export async function reconcileDir(entry: Dir, ctx: ReconcileCtx): Promise<void> {
  const path = expandTilde(entry.path, ctx.env);
  const disp = displayPath(path, ctx.env);
  const { report } = ctx;
  const wantMode = entry.mode ? Number.parseInt(entry.mode, 8) : undefined;

  // Returns true iff it actually chmoded (corrected mode drift) — so the caller can report a
  // corrected mode as a change (ok, shown even in quiet) and an already-correct dir as a no-op.
  const applyMode = async (): Promise<boolean> => {
    if (wantMode === undefined) return false;
    if ((await modeOf(path)) === entry.mode) return false;
    await chmod(path, wantMode);
    return true;
  };

  switch (ctx.verb) {
    case "sync": {
      const st = await stat(path).catch(() => undefined);
      if (st?.isDirectory()) {
        if (ctx.dryRun) {
          if (entry.mode && (await modeOf(path)) !== entry.mode)
            report.plan(`${disp} would be chmod ${entry.mode}`);
          else report.skip(`${disp} already exists`);
          return;
        }
        // The directory already existed. A corrected mode is a real change (shown even in
        // quiet, like the dry-run's `would be chmod`); an already-correct dir is a no-op skip.
        if (await applyMode()) report.ok(`${disp} (mode ${entry.mode})`);
        else report.skip(entry.mode ? `${disp} (mode ${entry.mode})` : disp);
        return;
      }
      // A non-directory sits at the path (a file, a link). "Ensure a directory exists" can't
      // proceed without clobbering it — never do that for a file boom doesn't own.
      if (st) {
        report.skip(`${disp} exists but is not a directory — skipped`);
        return;
      }
      if (ctx.dryRun) {
        report.plan(`${disp} would be created${entry.mode ? ` (mode ${entry.mode})` : ""}`);
        return;
      }
      // Creating a directory is reversible by a plain remove — journal the undo before the
      // mkdir so a crash mid-create is still rolled back (mirrors the filesystem resource).
      await ctx.journal?.intent("mkdir", path);
      await ctx.journal?.done("mkdir", path, { kind: "remove" });
      await mkdir(path, { recursive: true });
      await applyMode();
      report.ok(entry.mode ? `${disp} created (mode ${entry.mode})` : `${disp} created`);
      return;
    }
    case "verify": {
      const st = await stat(path).catch(() => undefined);
      if (!st) {
        report.fail(`${disp} missing`);
        return;
      }
      if (!st.isDirectory()) {
        report.fail(`${disp} exists but is not a directory`);
        return;
      }
      if (entry.mode && (await modeOf(path)) !== entry.mode)
        report.warn(`${disp} mode ${await modeOf(path)}, expected ${entry.mode}`);
      else report.skip(entry.mode ? `${disp} (mode ${entry.mode})` : disp);
      return;
    }
    case "uninstall": {
      if (!entry.remove_on_uninstall) return; // left in place by default (may hold user data)
      if (!(await pathExists(path))) return;
      const remaining = await readdirLen(path);
      if (remaining === undefined) return; // not a dir / unreadable — don't touch it
      if (remaining > 0) {
        report.note(`${disp} not removed — not empty`);
        return;
      }
      if (ctx.dryRun) report.note(`would remove ${disp}`);
      else {
        // rmdir (not rm): only removes an *empty* directory — a second safety net beyond the
        // emptiness check above, so a race that fills the dir fails loudly instead of nuking it.
        await rmdir(path);
        report.ok(`${disp} removed`);
      }
      return;
    }
  }
}

// Number of entries in a directory, or undefined if `path` isn't a readable directory.
async function readdirLen(path: string): Promise<number | undefined> {
  try {
    return (await readdir(path)).length;
  } catch {
    return undefined;
  }
}
