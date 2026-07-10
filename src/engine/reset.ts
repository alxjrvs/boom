// `botu source reset` — discard local changes in the config repo and reset it to match
// origin. The counterpart to what linkRemoteConfigRepo's re-link refusal points you
// at ("`botu source push` or clean it up"): this is the "clean it up" half, without having
// to know the managed clone's path or wipe/re-clone by hand. Fetches first, then
// hard-resets to the upstream tip (or the pinned ref, for a detached/@ref-pinned
// clone — pins are static, so "reset to remote" means "back to the pin") and clears
// untracked files, leaving the same end state a fresh re-clone would.
//
// Committed-but-unpushed commits are real work, not "local changes" — linkRemoteConfigRepo
// refuses to clobber them (see config/remote.ts), so reset must too: require --force
// before a hard reset discards commits no remote has.
import { requireConfigBreadcrumb } from "../config/load.ts";
import type { BotuContext } from "../context.ts";
import {
  cleanUntracked,
  fetchOrigin,
  hasUnpushedCommits,
  hasUpstream,
  headSha,
  resetHard,
  unpushedCommits,
} from "../lib/git.ts";

export interface ResetOptions {
  readonly force?: boolean;
}

export async function resetConfigRepo(ctx: BotuContext, opts: ResetOptions = {}): Promise<number> {
  const breadcrumb = await requireConfigBreadcrumb(ctx);
  if (!breadcrumb) return 1;
  const { path, remote } = breadcrumb;

  const fetch = fetchOrigin(path, ctx.env);
  if (fetch.code !== 0) {
    ctx.process.stderr.write(`botu: could not reach ${remote.url}: ${fetch.stderr || "fetch failed"}\n`);
    return 1;
  }

  if (!opts.force && hasUnpushedCommits(path, ctx.env)) {
    const commits = unpushedCommits(path, ctx.env)
      .map((c) => `    ${c}`)
      .join("\n");
    ctx.process.stderr.write(
      `botu: ${path} has commit(s) no remote has — reset would discard them:\n${commits}\n` +
        "botu: pass --force to discard anyway, or `botu source push` first\n",
    );
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
