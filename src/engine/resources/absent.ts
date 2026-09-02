// The `absent` resource: a path that must NOT exist. Sync removes it, verify fails while it
// is there, uninstall leaves it alone.
//
// The inverse of every other resource here: `link`, `copy` and `tmpl` converge a file *to* a
// desired content; this one requires that there be none. It is the shape where the file itself
// is the drift.
//
// WHY THAT SHAPE IS WORTH A RESOURCE. A tool that writes its own config behind your back
// produces exactly it. Claude Code writes `settings.local.json` on an "always allow" click;
// `.gitignore` can stop such a file being committed but never stops it existing, so a
// permission grant nobody reviewed lives on disk, invisible to every gate that reads tracked
// files. The same shape covers a credential cache a tool re-creates, an editor's local
// override, a `.DS_Store` policy — anywhere the fix is "this must not be here" rather than
// "this must say X".
//
// REMOVAL GOES THROUGH THE JOURNAL, so the file lands in the run's backup tree with a row
// naming where it went. That is the difference between this and a `run` step calling `rm`:
// the shell step destroys, this one displaces. A user who did want that file can still get it
// back out of `backups/<run-id>/` rather than from memory.
//
// UNINSTALL IS A NO-OP, deliberately. boom did not create this file and does not own it;
// removing someone else's file during teardown would be boom taking a parting shot at a
// machine it is being removed from.

import { lstat } from "node:fs/promises";
import type { Absent } from "../../config/schema.ts";
import { displayPath, expandTilde } from "../../lib/fs.ts";
import { journalRemove } from "../journal.ts";
import type { ReconcileCtx } from "../types.ts";

export async function reconcileAbsent(entry: Absent, ctx: ReconcileCtx): Promise<void> {
  // Nothing to do on teardown — see the header.
  if (ctx.verb === "uninstall") return;

  const path = expandTilde(entry.path, ctx.env);
  const disp = displayPath(path, ctx.env);
  const { report } = ctx;
  const label = entry.message ? `${entry.message} (${disp})` : disp;

  // lstat, not stat: a symlink at this path is itself the thing to remove, and following it
  // would report on — and remove — whatever it points at instead.
  const st = await lstat(path).catch(() => undefined);

  if (!st) {
    report.skip(`${disp} absent`);
    return;
  }

  // A directory needs `recursive` to be spelled out. Without this, one typo in a path
  // (`~/.claude` for `~/.claude/settings.local.json`) is a silent recursive delete of a
  // config tree on the next sync. Refusing loudly is the only safe default for a resource
  // whose entire job is deletion.
  if (st.isDirectory() && !entry.recursive) {
    report.fail(`${label}: is a directory — set \`recursive = true\` to remove it`);
    return;
  }

  if (ctx.verb === "verify") {
    report.fail(`${label}: exists and should not`);
    return;
  }

  if (ctx.dryRun) {
    report.plan(`${disp} would be removed`);
    return;
  }

  // Displaced into the backup tree rather than unlinked, so the file is recoverable.
  await journalRemove("absent", path, ctx, entry.recursive ?? false);
  report.ok(`${disp} removed`);
}
