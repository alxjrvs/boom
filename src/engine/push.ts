// `boom source push` — commit any local changes in the managed config-repo clone and get
// them upstream, in one step. This is the single "save my edits remotely" command: there's
// no separate commit verb, so you never cd into the cache dir to operate the clone by hand.
// `commitLocalChanges` (commit.ts) is the shared commit half — sync's --commit mode uses it
// too, so the default message/behavior can't drift.
//
// Two ways upstream, and the default is the safe one:
//
//   PR mode (default on a GitHub clone sitting on its default branch) — commit, publish
//     HEAD as `boom/<slug>-<sha>`, open a pull request against the default branch. Pushing
//     the default branch directly is a mistake on any repo that protects it, and every repo
//     that runs CI on config wants that CI to have seen the change *before* it is live.
//   direct mode (everything else, or --direct) — plain `git push`, the historical behavior.
//     Kept as the fallback because it is the only thing that works for a non-GitHub remote,
//     a clone with no `gh`, or a clone deliberately checked out on a feature branch.
//
// The tree never moves in PR mode. The clone's working tree is the target of every dotfile
// symlink on the machine, so checking out a branch would swap the user's live config out
// from under them until the PR merged; instead the commit stays on the local default branch
// and only the *ref* is published. The next `boom sync` rebases, sees its own patch already
// upstream in the squashed merge, and drops it — verified, not assumed.
//
// Exit 0 on success, 1 otherwise (no config linked, or a git/gh step failed).
import { requireConfigBreadcrumb } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import {
  currentBranch,
  defaultBranch,
  hasUnpushedCommits,
  headSha,
  headSubject,
  pushAsync,
  pushHeadToBranchAsync,
  remoteUrl,
} from "../lib/git.ts";
import { LockHeldError, withLock } from "../lib/lock.ts";
import type { Env } from "../lib/paths.ts";
import { bandsReporter, type Reporter } from "../lib/reporter.ts";
import { commitLocalChanges } from "./commit.ts";
import { branchNameFor, createPullRequest, enableAutoMerge, ghAvailable, githubSlug } from "./pr.ts";

export interface PushOptions {
  readonly message?: string;
  /** Skip PR mode and push the current branch straight up (the historical behavior). */
  readonly direct?: boolean;
  /** After opening the PR, ask GitHub to merge it once required checks pass. */
  readonly merge?: boolean;
}

// `source push` commits into the managed clone and pushes it — a mutation of the same shared
// working tree a sync rebases, so it takes the same lock every other mutating path now holds.
// Unlocked, a push landing mid-sync commits whatever the rebase happened to have staged.
export async function pushConfigRepo(ctx: BoomContext, opts: PushOptions = {}): Promise<number> {
  try {
    return await withLock(ctx.env, () => pushUnlocked(ctx, opts));
  } catch (e) {
    if (e instanceof LockHeldError) {
      ctx.process.stderr.write(`boom: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

// Why PR mode does or does not apply, as one value. Every branch of the decision carries the
// reason it was taken so the command can *say* why it fell back — a silent direct push to a
// protected branch is exactly the failure this command exists to stop being surprising.
type Route =
  | { readonly mode: "pr"; readonly base: string }
  | { readonly mode: "direct"; readonly why?: string };

function chooseRoute(dir: string, env: Env, opts: PushOptions): Route {
  if (opts.direct) return { mode: "direct" };

  const url = remoteUrl(dir, env);
  if (!url || !githubSlug(url)) return { mode: "direct", why: "origin is not a GitHub repo" };
  if (!ghAvailable(env)) return { mode: "direct", why: "the gh CLI is not installed" };

  const base = defaultBranch(dir, env);
  if (!base) return { mode: "direct", why: "origin/HEAD is not set, so the default branch is unknown" };

  // Already on a feature branch: the user (or a prior PR-mode run) put it there deliberately,
  // and pushing that branch is what they meant. Only the default branch gets rerouted.
  const branch = currentBranch(dir, env);
  if (branch !== base) return { mode: "direct", why: `already on branch ${branch ?? "(detached HEAD)"}` };

  return { mode: "pr", base };
}

async function pushUnlocked(ctx: BoomContext, opts: PushOptions): Promise<number> {
  // One Reporter voice across the source subcommands; hard failures return 1, not 2.
  // Resolve the config repo before opening the reporter, so a "no config linked" error doesn't
  // leave a dangling setup band above requireConfigBreadcrumb's own message.
  const breadcrumb = await requireConfigBreadcrumb(ctx);
  if (!breadcrumb) return 1;
  const dir = breadcrumb.path;
  const env = ctx.env;
  // verbose: push streams git's own push output and has no section band to nest under, so its
  // committed/pushed status lines print live rather than buffer.
  const report = bandsReporter(ctx.process, env, "push", { verbose: true, setup: "SENDING IT UPSTREAM…" });
  const fin = { ok: "pushed upstream", fail: (f: number) => `${f} failure(s)` };

  const commit = commitLocalChanges(dir, env, opts.message);
  if (commit.kind === "failed") {
    report.fail(`git commit failed: ${commit.stderr}`);
    return report.finish(fin);
  }
  if (commit.kind === "committed") report.ok(`committed (${commit.message})`);

  const route = chooseRoute(dir, env, opts);
  if (route.mode === "pr") {
    // Nothing local to publish means there is nothing to open a PR *for*. Say so plainly
    // rather than pushing an empty branch and letting `gh` fail on "no commits between".
    if (commit.kind === "clean" && !hasUnpushedCommits(dir, env)) {
      report.ok("nothing to push — the clone matches origin");
      return report.finish(fin);
    }
    return await pushViaPullRequest(ctx, report, dir, route.base, opts);
  }

  if (route.why) report.note(`pushing directly — ${route.why}`);
  return await pushDirect(ctx, report, dir, fin);
}

async function pushDirect(
  ctx: BoomContext,
  report: Reporter,
  dir: string,
  fin: { ok: string; fail: (f: number) => string },
): Promise<number> {
  // git's own push output is passed through verbatim (its progress/refs go to stderr) —
  // the Reporter owns only boom's status line, mirroring how diff streams the raw git diff.
  const result = await report.spin("pushing", () => pushAsync(dir, ctx.env));
  if (result.stdout) ctx.process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) ctx.process.stderr.write(`${result.stderr}\n`);
  if (result.code !== 0) report.fail("git push failed");
  else report.ok("pushed");
  return report.finish(fin);
}

async function pushViaPullRequest(
  ctx: BoomContext,
  report: Reporter,
  dir: string,
  base: string,
  opts: PushOptions,
): Promise<number> {
  const env = ctx.env;
  const fin = { ok: "pull request open", fail: (f: number) => `${f} failure(s)` };
  const sha = headSha(dir, env);
  const subject = headSubject(dir, env);
  if (!sha || !subject) {
    report.fail("could not read HEAD — is the config repo a valid clone?");
    return report.finish(fin);
  }
  const branch = branchNameFor(subject, sha);

  const pushed = await report.spin(`publishing ${branch}`, () => pushHeadToBranchAsync(dir, branch, env));
  if (pushed.code !== 0) {
    if (pushed.stderr) ctx.process.stderr.write(`${pushed.stderr}\n`);
    report.fail(`could not publish ${branch}`);
    return report.finish(fin);
  }
  report.ok(`published ${branch}`);

  const body = [
    "Opened by `boom source push`.",
    "",
    "The change is already live on the machine that pushed it — this PR is how it reaches",
    `\`${base}\`, so CI sees it before anyone else picks it up.`,
  ].join("\n");
  const pr = await report.spin("opening pull request", () =>
    createPullRequest(dir, { branch, base, title: subject, body }, env),
  );

  if (pr.code !== 0 && !pr.url) {
    if (pr.stderr) ctx.process.stderr.write(`${pr.stderr}\n`);
    // The commit is safe on the remote either way, so name the branch: the PR is one click
    // away and nothing has been lost, which is the difference between a failure and a loss.
    report.fail(`gh could not open the pull request — ${branch} is pushed, open it by hand`);
    return report.finish(fin);
  }
  const url = pr.url ?? branch;
  report.ok(`pull request ready — ${url}`);

  if (opts.merge) {
    const merged = await report.spin("enabling auto-merge", () => enableAutoMerge(dir, url, env));
    // A repo without auto-merge enabled is a repo setting, not a boom failure, and the PR is
    // open and correct regardless — warn so the run stays green and the reason is visible.
    if (merged.code !== 0)
      report.warn(`auto-merge unavailable: ${merged.stderr.split("\n")[0] ?? "gh failed"}`);
    else report.ok("auto-merge on — GitHub will land it once checks pass");
  }
  return report.finish(fin);
}
