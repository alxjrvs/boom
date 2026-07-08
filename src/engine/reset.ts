// `botu reset` — discard local changes in the config repo and reset it to match
// origin. The counterpart to what linkRemoteConfigRepo's re-link refusal points you
// at ("`botu push` or clean it up"): this is the "clean it up" half, without having
// to know the managed clone's path or wipe/re-clone by hand. Fetches first, then
// hard-resets to the upstream tip (or the pinned ref, for a detached/@ref-pinned
// clone — pins are static, so "reset to remote" means "back to the pin") and clears
// untracked files, leaving the same end state a fresh re-clone would.
import { readConfigBreadcrumb } from "../config/load.ts";
import type { BotuContext } from "../context.ts";
import { cleanUntracked, fetchOrigin, hasUpstream, headSha, resetHard } from "../lib/git.ts";

export async function resetConfigRepo(ctx: BotuContext): Promise<number> {
  const breadcrumb = await readConfigBreadcrumb(ctx.env);
  if (!breadcrumb) {
    ctx.process.stderr.write("botu: no remote config linked — run `botu link <owner/repo>`\n");
    return 1;
  }
  const { path, remote } = breadcrumb;

  const fetch = fetchOrigin(path, ctx.env);
  if (fetch.code !== 0) {
    ctx.process.stderr.write(`botu: could not reach ${remote.url}: ${fetch.stderr || "fetch failed"}\n`);
    return 1;
  }

  const target = hasUpstream(path, ctx.env) ? "@{u}" : (remote.ref ?? "HEAD");
  const before = headSha(path, ctx.env);
  const reset = resetHard(path, target, ctx.env);
  if (reset.code !== 0) {
    ctx.process.stderr.write(`botu: git reset --hard ${target} failed: ${reset.stderr || "unknown error"}\n`);
    return 1;
  }
  cleanUntracked(path, ctx.env);

  const after = headSha(path, ctx.env);
  const moved = before && after && before !== after ? ` (was ${before})` : "";
  ctx.process.stdout.write(`botu: reset ${path} to ${after ?? target}${moved}\n`);
  return 0;
}
