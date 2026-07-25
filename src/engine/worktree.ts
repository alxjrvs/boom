// Agent-worktree reaping. Claude Code cuts a throwaway git worktree per background
// agent and, on session close, refuses to remove any whose HEAD commits exist on no
// remote — a guard against deleting unpushed work. The test is SHA identity, so a
// squash-merged branch fails it: the content landed on the default branch under a
// *new* SHA, and the branch's own commits genuinely exist nowhere by SHA even though
// every line of them is merged. The worktrees therefore accumulate forever.
//
// This module re-decides that question by *content* rather than by SHA, using git's
// own patch-id equivalence (the same machinery `git cherry` uses to spot already-
// applied commits). Reaping removes only the worktree directory and always leaves the
// branch ref in place, so even a misjudged call loses no commits — the branch still
// points at them and `git worktree add` can restore a checkout.
import { realpathSync } from "node:fs";
import { captureArgvAsync, type Env, runArgvAsync } from "../lib/proc.ts";

export interface WorktreeEntry {
  readonly path: string;
  readonly head: string;
  // Branch shortname, or undefined for a detached HEAD.
  readonly branch?: string;
  // The `locked` line's reason text, present only when the worktree is locked. Claude
  // Code writes "claude session <name> (pid NNNN start ...)" here for a live session.
  readonly lock?: string;
  // A registered worktree whose directory is gone; `git worktree prune` reclaims it.
  readonly prunable: boolean;
}

// `git worktree list --porcelain` emits stanzas separated by blank lines, each led by a
// `worktree <path>` line. Value-less attributes (`bare`, `detached`, `prunable`) appear
// as a bare keyword; the rest are `key value`. Parsed as pure text so the classification
// rules can be tested without a repo on disk.
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: { path?: string; head?: string; branch?: string; lock?: string; prunable?: boolean } = {};
  const flush = (): void => {
    if (cur.path && cur.head)
      out.push({
        path: cur.path,
        head: cur.head,
        branch: cur.branch,
        lock: cur.lock,
        prunable: cur.prunable ?? false,
      });
    cur = {};
  };
  for (const raw of porcelain.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      flush();
      cur.path = value;
    } else if (key === "HEAD") cur.head = value;
    else if (key === "branch") cur.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "locked") cur.lock = value;
    else if (key === "prunable") cur.prunable = true;
  }
  flush();
  return out;
}

// Claude Code stamps the holding process into the lock reason ("… (pid 98170 start …)").
// A lock whose PID is gone is a crashed session's litter; a lock whose PID is alive is
// another session's in-flight work and must never be touched.
export function lockPid(reason: string | undefined): number | undefined {
  const m = reason?.match(/\bpid\s+(\d+)/i);
  return m ? Number(m[1]) : undefined;
}

export function pidAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to another user — alive for our purposes.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export type Verdict = "reap" | "keep" | "skip";

export interface Judgement {
  readonly entry: WorktreeEntry;
  readonly verdict: Verdict;
  // Human-readable justification, shown per-worktree in the report.
  readonly why: string;
  // A "keep" that exists solely because the work lives nowhere but this machine — the tree
  // is clean and nothing is in flight, the commits just aren't on a remote. Publishing the
  // branch resolves it into a "reap", which is what `--push` does. Never set on a verdict
  // held back for any other reason (dirty, locked, unreadable): those must not be pushed.
  readonly pushable?: boolean;
}

// Resolve the default branch the way the repo itself records it, falling back to the
// conventional names. Returns a remote-tracking ref (`origin/main`) or undefined when
// the repo has no remote at all — in which case nothing can be proven merged and every
// worktree is kept.
export async function defaultRemoteRef(repo: string, env: Env): Promise<string | undefined> {
  const head = await captureArgvAsync(["git", "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], env, {
    cwd: repo,
  });
  if (head.code === 0 && head.stdout) return head.stdout.replace(/^refs\/remotes\//, "");
  for (const guess of ["origin/main", "origin/master"]) {
    const ok = await captureArgvAsync(["git", "rev-parse", "--verify", "--quiet", guess], env, { cwd: repo });
    if (ok.code === 0 && ok.stdout) return guess;
  }
  return undefined;
}

// The content test. Replay the worktree's HEAD *tree* as a single synthetic commit on
// top of the merge-base, then ask `git cherry` whether that patch already exists on the
// default branch. `-` means yes (an equivalent patch-id is upstream) — exactly the shape
// a squash-merge produces. The synthetic commit is written to the object store but is
// referenced by nothing, so it is unreachable garbage collected in due course.
export async function isSquashMerged(wt: string, target: string, env: Env): Promise<boolean> {
  const base = await captureArgvAsync(["git", "merge-base", "HEAD", target], env, { cwd: wt });
  if (base.code !== 0 || !base.stdout) return false;
  const tree = await captureArgvAsync(["git", "rev-parse", "HEAD^{tree}"], env, { cwd: wt });
  if (tree.code !== 0 || !tree.stdout) return false;
  const fake = await captureArgvAsync(
    ["git", "commit-tree", tree.stdout, "-p", base.stdout, "-m", "boom-reap-probe"],
    env,
    { cwd: wt },
  );
  if (fake.code !== 0 || !fake.stdout) return false;
  const cherry = await captureArgvAsync(["git", "cherry", target, fake.stdout], env, { cwd: wt });
  if (cherry.code !== 0) return false;
  return cherry.stdout.split("\n").some((l) => l.startsWith("-"));
}

// Decide one worktree's fate. Ordered most-conservative-first: a live lock or a dirty
// tree short-circuits before any content analysis, so an in-flight agent is never
// second-guessed on the strength of a patch-id.
export async function judge(entry: WorktreeEntry, target: string | undefined, env: Env): Promise<Judgement> {
  const wt = entry.path;
  if (entry.prunable) return { entry, verdict: "reap", why: "directory is gone (prunable)" };
  if (entry.lock !== undefined) {
    const pid = lockPid(entry.lock);
    if (pid === undefined) return { entry, verdict: "skip", why: "locked (no pid in reason)" };
    if (pidAlive(pid)) return { entry, verdict: "skip", why: `live session (pid ${pid})` };
  }
  const status = await captureArgvAsync(["git", "status", "--porcelain"], env, { cwd: wt });
  if (status.code !== 0) return { entry, verdict: "skip", why: "unreadable (git status failed)" };
  if (status.stdout !== "") return { entry, verdict: "keep", why: "uncommitted changes" };
  // Reachable from HEAD but from no remote-tracking ref — the same question Claude Code's
  // guard asks. Zero means the commits are literally pushed and the guard would have let go.
  const unpushed = await captureArgvAsync(["git", "rev-list", "--count", "HEAD", "--not", "--remotes"], env, {
    cwd: wt,
  });
  if (unpushed.code !== 0) return { entry, verdict: "skip", why: "unreadable (git rev-list failed)" };
  if (unpushed.stdout === "0") return { entry, verdict: "reap", why: "every commit is on a remote" };
  // A detached HEAD has no branch to publish, so it is never pushable — its commits can only
  // be preserved by naming them, which is a decision for a human, not a sweep.
  const pushable = entry.branch !== undefined;
  if (!target)
    return { entry, verdict: "keep", why: "unpushed commits, no remote default branch to compare", pushable };
  if (await isSquashMerged(wt, target, env))
    return { entry, verdict: "reap", why: `content already in ${target} (squash-merged)` };
  return { entry, verdict: "keep", why: `${unpushed.stdout} commit(s) not on any remote`, pushable };
}

// Publish a pushable worktree's branch so its commits stop existing only on this machine.
// `-u` sets upstream so the branch reads as tracked afterwards; no force, ever — if the
// remote already has a diverged branch of that name, the push fails and the worktree is
// kept, which is the correct outcome for a sweep that must never destroy anything.
export async function pushBranch(wt: string, branch: string, env: Env): Promise<boolean> {
  const { code } = await runArgvAsync(["git", "push", "--quiet", "-u", "origin", branch], env, {
    cwd: wt,
    silent: true,
  });
  return code === 0;
}

// Remove the worktree directory, leaving the branch ref untouched. `--force` covers the
// prunable case (a registered worktree whose directory already vanished) and nothing
// else: every reapable entry has already been proven clean by judge().
export async function removeWorktree(repo: string, wt: string, env: Env): Promise<boolean> {
  const { code } = await runArgvAsync(["git", "worktree", "remove", "--force", wt], env, {
    cwd: repo,
    silent: true,
  });
  return code === 0;
}

// Linked worktrees only — the primary checkout is the repo itself and is never a reap
// candidate. Compared by realpath, not by string: git always reports a fully resolved
// path, while the caller's path comes from a directory crawl that may run through a
// symlink (on macOS /var is a link to /private/var, and the agents farm is symlinks all
// the way down). A raw string compare silently fails to drop the primary checkout, which
// would then be judged — and possibly reaped — as if it were disposable.
export async function linkedWorktrees(repo: string, env: Env): Promise<WorktreeEntry[]> {
  const listed = await captureArgvAsync(["git", "worktree", "list", "--porcelain"], env, { cwd: repo });
  if (listed.code !== 0) return [];
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const primary = real(repo);
  return parseWorktreeList(listed.stdout).filter((e) => real(e.path) !== primary);
}
