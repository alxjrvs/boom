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
import { bandsReporter } from "../lib/reporter.ts";

export interface ResetOptions {
  readonly force?: boolean;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
}

export async function resetConfigRepo(ctx: BoomContext, opts: ResetOptions = {}): Promise<number> {
  // Bands voice, like every `boom source` subcommand; hard failures (and an abort) return 1,
  // keeping exit-2 reserved for the verify/status warning tier. All outcome paths close through
  // finish() so the run always ends on a `▎ RESET...COMPLETE!` / `...FAILED!` verdict band.
  // Resolve the config repo before opening the reporter, so a "no config linked" error doesn't
  // leave a dangling setup band above requireConfigBreadcrumb's own message.
  const breadcrumb = await requireConfigBreadcrumb(ctx);
  if (!breadcrumb) return 1;
  const { path, remote } = breadcrumb;
  // verbose: reset has no section band to nest under, so its plan/ok status lines print live.
  const report = bandsReporter(ctx.process, ctx.env, "reset", {
    verbose: true,
    setup: "REWINDING TO ORIGIN…",
  });
  const fin = { ok: "reset to origin", fail: (f: number) => `${f} failure(s)` };

  const fetch = fetchOrigin(path, ctx.env);
  if (fetch.code !== 0) {
    report.fail(`could not reach ${remote.url}: ${fetch.stderr || "fetch failed"}`);
    return report.finish(fin);
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
    return report.finish(fin);
  }

  if (!opts.force && hasUnpushedCommits(path, ctx.env)) {
    const commits = unpushedCommits(path, ctx.env)
      .map((c) => `      ${c}`)
      .join("\n");
    report.fail(
      `${path} has commit(s) no remote has — reset would discard them:\n${commits}\n` +
        "    pass --force to discard anyway, or `boom source push` first",
    );
    return report.finish(fin);
  }

  // Confirm before discarding a dirty working tree (nothing to lose on a clean one, so no
  // prompt then). --force/--yes signal intent and always proceed; an interactive terminal is
  // prompted; a non-TTY without either now REFUSES (see lib/confirm.ts) rather than silently
  // discarding local changes — a scripted reset must pass --yes to consent explicitly. An abort
  // is a hard stop (exit 1), so it's a fail, not a warning.
  if (
    !isClean(path, ctx.env) &&
    !confirm(`discard local changes in ${path}?`, { yes: opts.force || opts.yes })
  ) {
    report.fail("reset aborted");
    return report.finish(fin);
  }

  const target = hasUpstream(path, ctx.env) ? "@{u}" : (remote.ref ?? "HEAD");
  const before = headSha(path, ctx.env);
  const reset = resetHard(path, target, ctx.env);
  if (reset.code !== 0) {
    report.fail(`git reset --hard ${target} failed: ${reset.stderr || "unknown error"}`);
    return report.finish(fin);
  }
  cleanUntracked(path, ctx.env);

  const after = headSha(path, ctx.env);
  const moved = before && after && before !== after ? ` (was ${before})` : "";
  report.ok(`reset ${path} to ${after ?? target}${moved}`);
  return report.finish(fin);
}
