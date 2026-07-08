// Config-repo sync: the pre-reconcile step that keeps a repo-only config fresh.
// `verify` (and any dry-run) fetches and reports drift without touching the working
// tree; `apply`/`fix` fast-forward-pull and report what moved, then reconcile
// proceeds against whatever's on disk regardless — a failed pull is reported but
// never blocks reconciling from the last-known-good local state (fast-forward-only
// means a failure can't have left the clone half-merged).
import { readConfigBreadcrumb } from "../config/load.ts";
import { diffNameOnly, fetchOrigin, ffPull, hasUpstream, headSha, revListCount } from "../lib/git.ts";
import type { Env } from "../lib/proc.ts";
import type { Reporter } from "../lib/reporter.ts";
import type { Verb } from "./types.ts";

export async function syncConfigRepo(
  repo: string,
  env: Env,
  report: Reporter,
  verb: Verb,
  dryRun: boolean,
): Promise<void> {
  if (verb === "uninstall") return;
  const breadcrumb = await readConfigBreadcrumb(env);
  if (!breadcrumb || breadcrumb.path !== repo) return; // not a botu-managed remote config

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
  const behind = revListCount(repo, "HEAD..@{u}", env);
  if (behind === 0) {
    report.ok("up to date with origin");
    return;
  }
  if (verb === "verify" || dryRun) {
    report.warn(`${behind} commit(s) behind origin`);
    return;
  }
  const before = headSha(repo, env);
  const pull = ffPull(repo, env);
  if (pull.code !== 0) {
    report.fail(
      `fast-forward pull failed — resolve manually in ${repo} (${pull.stderr || "not a fast-forward"})`,
    );
    return;
  }
  const changed = before ? diffNameOnly(repo, `${before}..HEAD`, env) : [];
  report.ok(`pulled ${behind} commit(s)${changed.length > 0 ? `: ${changed.join(", ")}` : ""}`);
}
