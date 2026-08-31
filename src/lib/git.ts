// Thin git plumbing for a repo-only config source: clone/fetch/pull the managed
// config-repo clone, and answer the small questions engine/sync.ts, config/remote.ts and
// `boom doctor` need (ahead/behind, upstream, reachability). Shells out via captureArgv —
// no libgit2, no GitHub API client; ambient git/SSH auth is whatever already works in the
// user's shell. Every export here has a caller: the wrappers that only served the removed
// `boom source push|reset|diff` verbs went with them in 0.33.
import type { Env } from "./paths.ts";
import { type CaptureResult, captureArgv, captureArgvAsync } from "./proc.ts";

export function cloneRepo(url: string, dest: string, env: Env): CaptureResult {
  return captureArgv(["git", "clone", url, dest], env);
}

// The two network-slow config-repo ops, awaited under the active-work spinner (see
// engine/sync.ts). The rest of git plumbing is local + fast, so it stays synchronous.
export function fetchOriginAsync(dir: string, env: Env): Promise<CaptureResult> {
  return captureArgvAsync(["git", "fetch", "origin"], env, { cwd: dir });
}

// --autostash: git itself stashes any dirty tracked changes before rebasing and
// restores them after — including automatically on `rebaseAbort`, so a conflict
// never strands local edits. Untracked files are never touched by a rebase, so they
// don't need stashing for this to be safe.
export function pullRebaseAutostashAsync(dir: string, env: Env): Promise<CaptureResult> {
  return captureArgvAsync(["git", "pull", "--rebase", "--autostash"], env, { cwd: dir });
}

// Harmless (git errors, callers ignore the result) when no rebase is in progress —
// callers can call this unconditionally as cleanup after any rebase attempt.
export function rebaseAbort(dir: string, env: Env): CaptureResult {
  return captureArgv(["git", "rebase", "--abort"], env, { cwd: dir });
}

export function addAll(dir: string, env: Env): CaptureResult {
  return captureArgv(["git", "add", "-A"], env, { cwd: dir });
}

export function commitStaged(dir: string, message: string, env: Env): CaptureResult {
  return captureArgv(["git", "commit", "-m", message], env, { cwd: dir });
}

export function checkoutRef(dir: string, ref: string, env: Env): CaptureResult {
  return captureArgv(["git", "checkout", ref], env, { cwd: dir });
}

// Working-tree/index clean — mirrors `git status --porcelain`. This alone does NOT
// mean "safe to discard": a repo can be clean here while still carrying committed
// commits that were never pushed (porcelain status never reports ahead-of-upstream).
// Callers that intend to wipe the directory must also check hasUnpushedCommits.
export function isClean(dir: string, env: Env): boolean {
  const r = captureArgv(["git", "status", "--porcelain"], env, { cwd: dir });
  return r.code === 0 && r.stdout.length === 0;
}

// Whether HEAD has an upstream tracking ref (@{u} resolves). False for a detached
// HEAD after pinning to a tag/sha — the caller reads that as "not tracking a moving
// branch" rather than as an error.
export function hasUpstream(dir: string, env: Env): boolean {
  return captureArgv(["git", "rev-parse", "@{u}"], env, { cwd: dir }).code === 0;
}

// Commits HEAD carries that no remote ref has — the "would wiping this lose work"
// check. Deliberately NOT @{u}-based: a pinned @tag/@sha clone is detached, so it has
// no upstream to be "ahead of", yet commits made there are every bit as unpushed —
// comparing against --remotes catches both that case and the plain branch-ahead one.
export function hasUnpushedCommits(dir: string, env: Env): boolean {
  const r = captureArgv(["git", "rev-list", "--count", "HEAD", "--not", "--remotes"], env, { cwd: dir });
  return r.code === 0 && (Number.parseInt(r.stdout, 10) || 0) > 0;
}

export function headSha(dir: string, env: Env): string | undefined {
  const r = captureArgv(["git", "rev-parse", "HEAD"], env, { cwd: dir });
  return r.code === 0 ? r.stdout : undefined;
}

// undefined signals the git command itself failed — distinct from a genuine 0, so a
// caller can't mistake a broken clone/range for "no drift" (see sync.ts's verify path).
export function revListCount(dir: string, range: string, env: Env): number | undefined {
  const r = captureArgv(["git", "rev-list", "--count", range], env, { cwd: dir });
  return r.code === 0 ? Number.parseInt(r.stdout, 10) || 0 : undefined;
}

export function diffNameOnly(dir: string, range: string, env: Env): string[] {
  const r = captureArgv(["git", "diff", "--name-only", range], env, { cwd: dir });
  return r.code === 0 && r.stdout.length > 0 ? r.stdout.split("\n") : [];
}

// `ls-remote` touches only the remote, never the local clone — safe for `boom doctor` to call
// without mutating anything. Awaited under doctor's active-work spinner: the reachability probe
// is a network round-trip and shouldn't run silently.
export async function remoteReachableAsync(url: string, env: Env): Promise<boolean> {
  return (await captureArgvAsync(["git", "ls-remote", "--exit-code", url], env)).code === 0;
}

// How the local clone stands against its upstream: commits behind, whether it carries
// unpushed work, and whether the tree is dirty. The drift summary behind the `verify`/dry-run
// report (engine/sync.ts). undefined when `git rev-list` itself failed (a broken clone or
// unreadable range) — the caller must not read that as "no drift". Assumes an upstream
// exists (@{u} resolves); callers check hasUpstream first.
interface RepoDrift {
  readonly behind: number;
  readonly unpushed: boolean;
  readonly dirty: boolean;
}

export function repoDrift(dir: string, env: Env): RepoDrift | undefined {
  const behind = revListCount(dir, "HEAD..@{u}", env);
  if (behind === undefined) return undefined;
  return { behind, unpushed: hasUnpushedCommits(dir, env), dirty: !isClean(dir, env) };
}
