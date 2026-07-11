// Config-repo sync: the pre-reconcile step that keeps a repo-only config fresh.
// `verify` (and any dry-run) fetches and reports drift without touching the working
// tree — behind origin, ahead with unpushed commits, or a dirty tree, since those are
// exactly the states `boom source push` exists to handle and "up to date" must
// not paper over them. `sync`/`repair` pull (rebasing local changes on top via
// --autostash, or committing them first with --commit) and report what moved, then
// reconcile proceeds against whatever's on disk regardless — a failed pull is reported
// but never blocks reconciling from the last-known-good local state (a rebase conflict
// is aborted before returning, so "local state" is never left mid-rebase).
import { readConfigBreadcrumb } from "../config/load.ts";
import {
  diffNameOnly,
  fetchOrigin,
  hasUpstream,
  headSha,
  pullRebaseAutostash,
  rebaseAbort,
  repoDrift,
  revListCount,
} from "../lib/git.ts";
import type { Env } from "../lib/proc.ts";
import type { Reporter } from "../lib/reporter.ts";
import { commitLocalChanges } from "./commit.ts";
import type { Verb } from "./types.ts";

export interface SyncOptions {
  // Commit local changes before pulling instead of the default autostash — so they
  // land as a real commit, replayed on top of the rebase rather than left uncommitted.
  readonly commit?: boolean;
  readonly commitMessage?: string;
}

export async function syncConfigRepo(
  repo: string,
  env: Env,
  report: Reporter,
  verb: Verb,
  dryRun: boolean,
  opts?: SyncOptions,
): Promise<void> {
  if (verb === "uninstall") return;
  const breadcrumb = await readConfigBreadcrumb(env);
  if (!breadcrumb || breadcrumb.path !== repo) return; // not a boom-managed remote config

  report.header("Config repo");
  const fetch = fetchOrigin(repo, env);
  if (fetch.code !== 0) {
    report.warn(`could not reach ${breadcrumb.remote.url} — reconciling from the local clone as-is`);
    return;
  }
  if (!hasUpstream(repo, env)) {
    report.ok(`pinned to ${breadcrumb.remote.ref ?? "a fixed ref"} — not tracking a moving branch`);
    return;
  }

  if (verb === "verify" || dryRun) {
    const drift = repoDrift(repo, env);
    if (!drift) {
      report.fail("could not determine drift against origin (git rev-list failed)");
      return;
    }
    if (drift.behind > 0) report.warn(`${drift.behind} commit(s) behind origin`);
    if (drift.unpushed) report.warn("local commit(s) not pushed to origin");
    if (drift.dirty) report.warn("uncommitted local changes");
    if (drift.behind === 0 && !drift.unpushed && !drift.dirty) report.ok("up to date with origin");
    return;
  }

  // --commit's job is to commit local edits, independent of whether origin has moved —
  // do it before the behind-check below, so it isn't skipped just because there's
  // nothing to pull.
  if (opts?.commit) {
    const outcome = commitLocalChanges(repo, env, opts.commitMessage);
    if (outcome.kind === "failed") {
      report.fail(`git commit failed: ${outcome.stderr}`);
      return;
    }
    if (outcome.kind === "committed") report.ok(`committed local changes (${outcome.message})`);
  }

  const behind = revListCount(repo, "HEAD..@{u}", env);
  if (behind === undefined) {
    report.fail("could not determine drift against origin (git rev-list failed)");
    return;
  }
  if (behind === 0) {
    report.ok("up to date with origin");
    return;
  }
  const before = headSha(repo, env);
  const pull = pullRebaseAutostash(repo, env);
  if (pull.code !== 0) {
    rebaseAbort(repo, env); // no-op if nothing was left mid-rebase; restores any autostash
    report.fail(`pull --rebase failed — resolve manually in ${repo} (${pull.stderr || "conflict"})`);
    return;
  }
  const changed = before ? diffNameOnly(repo, `${before}..HEAD`, env) : [];
  report.ok(`pulled ${behind} commit(s)${changed.length > 0 ? `: ${changed.join(", ")}` : ""}`);
}
