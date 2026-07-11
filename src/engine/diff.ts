// `boom source diff` — show what `boom source commit` would capture in the managed
// config-repo clone: the working-tree diff against HEAD, plus any untracked new files
// `git diff` omits. Read-only counterpart to commit.ts/push.ts — it touches nothing, it
// just saves cd-ing into a cache dir you don't normally think about to inspect it.
import { requireConfigBreadcrumb } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import { diffHead, isClean, untrackedFiles } from "../lib/git.ts";

export async function diffConfigRepo(ctx: BoomContext): Promise<number> {
  const breadcrumb = await requireConfigBreadcrumb(ctx);
  if (!breadcrumb) return 1;
  if (isClean(breadcrumb.path, ctx.env)) {
    ctx.process.stdout.write("boom: no local changes\n");
    return 0;
  }
  // Streams straight to the terminal; the untracked note prints after it because
  // spawnSync flushes before returning, so the two writes stay in order on fd 1.
  const result = diffHead(breadcrumb.path, ctx.env);
  const untracked = untrackedFiles(breadcrumb.path, ctx.env);
  if (untracked.length > 0) {
    ctx.process.stdout.write("boom: untracked (new files `boom source commit` would add):\n");
    for (const f of untracked) ctx.process.stdout.write(`  ${f}\n`);
  }
  return result.code === 0 ? 0 : 1;
}
