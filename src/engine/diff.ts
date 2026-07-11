// `boom source diff` — show what `boom source push` would capture in the managed
// config-repo clone: the working-tree diff against HEAD, plus any untracked new files
// `git diff` omits. Read-only counterpart to commit.ts/push.ts — it touches nothing, it
// just saves cd-ing into a cache dir you don't normally think about to inspect it.
import { requireConfigBreadcrumb } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { diffHead, isClean, untrackedFiles } from "../lib/git.ts";
import { Reporter } from "../lib/reporter.ts";

export async function diffConfigRepo(ctx: BoomContext): Promise<number> {
  // Reporter owns boom's status lines (one voice with push/reset); the actual diff is
  // streamed raw by diffHead so git colors + pages it exactly as a bare `git diff` would.
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env));
  const breadcrumb = await requireConfigBreadcrumb(ctx);
  if (!breadcrumb) return 1;
  if (isClean(breadcrumb.path, ctx.env)) {
    report.ok("no local changes");
    return 0;
  }
  // Streams straight to the terminal; the untracked note prints after it because
  // spawnSync flushes before returning, so the two writes stay in order on fd 1.
  const result = diffHead(breadcrumb.path, ctx.env);
  const untracked = untrackedFiles(breadcrumb.path, ctx.env);
  if (untracked.length > 0) {
    report.note("untracked (new files `boom source push` would add):");
    for (const f of untracked) report.note(`  ${f}`);
  }
  return result.code === 0 ? 0 : 1;
}
