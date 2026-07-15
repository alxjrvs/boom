// `boom source diff` — show what `boom source push` would capture in the managed
// config-repo clone: the working-tree diff against HEAD, plus any untracked new files
// `git diff` omits. Read-only counterpart to commit.ts/push.ts — it touches nothing, it
// just saves cd-ing into a cache dir you don't normally think about to inspect it.
import { requireConfigBreadcrumb } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import { diffHead, isClean, untrackedFiles } from "../lib/git.ts";
import { bandsReporter } from "../lib/reporter.ts";

export async function diffConfigRepo(ctx: BoomContext): Promise<number> {
  // Resolve the config repo before opening the reporter, so a "no config linked" error doesn't
  // leave a dangling setup band above requireConfigBreadcrumb's own message.
  const breadcrumb = await requireConfigBreadcrumb(ctx);
  if (!breadcrumb) return 1;
  // Reporter owns boom's status lines (one voice with push/reset); the actual diff is
  // streamed raw by diffHead so git colors + pages it exactly as a bare `git diff` would.
  // verbose: diff streams the raw `git diff` verbatim and has no section band to nest under, so
  // its own status lines (no-changes / untracked note) must print live rather than buffer.
  const report = bandsReporter(ctx.process, ctx.env, "diff", {
    verbose: true,
    setup: "SURVEYING LOCAL CHANGES…",
  });
  if (isClean(breadcrumb.path, ctx.env)) {
    report.ok("no local changes");
    return report.finish({ ok: "nothing to show", fail: (f) => `${f} failure(s)` });
  }
  // Streams straight to the terminal; the untracked note prints after it because
  // spawnSync flushes before returning, so the two writes stay in order on fd 1.
  const result = diffHead(breadcrumb.path, ctx.env);
  const untracked = untrackedFiles(breadcrumb.path, ctx.env);
  if (untracked.length > 0) {
    report.note("untracked (new files `boom source push` would add):");
    for (const f of untracked) report.note(`  ${f}`);
  }
  if (result.code !== 0) report.fail("git diff failed");
  return report.finish({ ok: "diff shown", fail: (f) => `${f} failure(s)` });
}
