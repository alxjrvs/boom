// `boom source reset` — discard local changes in the config repo and reset it to match
// origin. The counterpart to what linkRemoteConfigRepo's re-link refusal points you
// at ("`boom source push` or clean it up"): this is the "clean it up" half, without having
// to know the managed clone's path or wipe/re-clone by hand. Fetches first, then
// hard-resets to the upstream tip (or the pinned ref, for a detached/@ref-pinned
// clone — pins are static, so "reset to remote" means "back to the pin") and clears
// untracked files, leaving the same end state a fresh re-clone would.
//
// Committed-but-unpushed commits are real work, not "local changes" — linkRemoteConfigRepo
// refuses to clobber them (see config/remote.ts), so reset must too: require --force
// before a hard reset discards commits no remote has.
import { requireConfigBreadcrumb } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { confirm } from "../lib/confirm.ts";
import {
  cleanUntracked,
  fetchOrigin,
  hasUnpushedCommits,
  hasUpstream,
  headSha,
  isClean,
  resetHard,
  unpushedCommits,
} from "../lib/git.ts";
import { Reporter } from "../lib/reporter.ts";

export interface ResetOptions {
  readonly force?: boolean;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
}

export async function resetConfigRepo(ctx: BoomContext, opts: ResetOptions = {}): Promise<number> {
  // Reporter (not raw boom: writes) so every `boom source` subcommand speaks one voice —
  // the ✓/→/✗ glyphs — and returns 1 (not 2) for a hard failure, keeping exit-2 reserved
  // for the verify/status warning tier.
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env));
  const breadcrumb = await requireConfigBreadcrumb(ctx);
  if (!breadcrumb) return 1;
  const { path, remote } = breadcrumb;

  const fetch = fetchOrigin(path, ctx.env);
  if (fetch.code !== 0) {
    report.fail(`could not reach ${remote.url}: ${fetch.stderr || "fetch failed"}`);
    return 1;
  }

  if (opts.dryRun) {
    const target = hasUpstream(path, ctx.env) ? "@{u}" : (remote.ref ?? "HEAD");
    report.plan(`would reset ${path} to ${target} and clean untracked files`);
    if (!isClean(path, ctx.env)) report.plan("would discard uncommitted local changes");
    if (hasUnpushedCommits(path, ctx.env))
      report.plan(
        opts.force
          ? "would discard unpushed commit(s) (--force)"
          : "would refuse: unpushed commit(s) present — needs --force",
      );
    return 0;
  }

  if (!opts.force && hasUnpushedCommits(path, ctx.env)) {
    const commits = unpushedCommits(path, ctx.env)
      .map((c) => `      ${c}`)
      .join("\n");
    report.fail(
      `${path} has commit(s) no remote has — reset would discard them:\n${commits}\n` +
        "    pass --force to discard anyway, or `boom source push` first",
    );
    return 1;
  }

  // Confirm before discarding a dirty working tree (nothing to lose on a clean one, so no
  // prompt then). --force/--yes signal intent and always proceed; an interactive terminal is
  // prompted; a non-TTY without either now REFUSES (see lib/confirm.ts) rather than silently
  // discarding local changes — a scripted reset must pass --yes to consent explicitly.
  if (
    !isClean(path, ctx.env) &&
    !confirm(`discard local changes in ${path}?`, { yes: opts.force || opts.yes })
  ) {
    report.warn("reset aborted");
    return 1;
  }

  const target = hasUpstream(path, ctx.env) ? "@{u}" : (remote.ref ?? "HEAD");
  const before = headSha(path, ctx.env);
  const reset = resetHard(path, target, ctx.env);
  if (reset.code !== 0) {
    report.fail(`git reset --hard ${target} failed: ${reset.stderr || "unknown error"}`);
    return 1;
  }
  cleanUntracked(path, ctx.env);

  const after = headSha(path, ctx.env);
  const moved = before && after && before !== after ? ` (was ${before})` : "";
  report.ok(`reset ${path} to ${after ?? target}${moved}`);
  return 0;
}
