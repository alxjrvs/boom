// Thin git plumbing for a repo-only config source: clone/fetch/pull the managed
// config-repo clone, and answer the small questions engine/sync.ts and `botu doctor`/
// `botu push` need (ahead/behind, upstream, reachability). Shells out via
// captureArgv — no libgit2, no GitHub API client; ambient git/SSH auth is whatever
// already works in the user's shell.
import { type CaptureResult, captureArgv, type Env } from "./proc.ts";

export function cloneRepo(url: string, dest: string, env: Env): CaptureResult {
  return captureArgv(["git", "clone", url, dest], env);
}

export function fetchOrigin(dir: string, env: Env): CaptureResult {
  return captureArgv(["git", "fetch", "origin"], env, { cwd: dir });
}

export function ffPull(dir: string, env: Env): CaptureResult {
  return captureArgv(["git", "pull", "--ff-only"], env, { cwd: dir });
}

export function checkoutRef(dir: string, ref: string, env: Env): CaptureResult {
  return captureArgv(["git", "checkout", ref], env, { cwd: dir });
}

export function push(dir: string, env: Env): CaptureResult {
  return captureArgv(["git", "push"], env, { cwd: dir });
}

export function resetHard(dir: string, ref: string, env: Env): CaptureResult {
  return captureArgv(["git", "reset", "--hard", ref], env, { cwd: dir });
}

// -fd only (no -x): clears untracked files/dirs same as a fresh clone would leave,
// without also nuking gitignored build/cache artifacts a hook might have left behind.
export function cleanUntracked(dir: string, env: Env): CaptureResult {
  return captureArgv(["git", "clean", "-fd"], env, { cwd: dir });
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

export function revListCount(dir: string, range: string, env: Env): number {
  const r = captureArgv(["git", "rev-list", "--count", range], env, { cwd: dir });
  return r.code === 0 ? Number.parseInt(r.stdout, 10) || 0 : 0;
}

export function diffNameOnly(dir: string, range: string, env: Env): string[] {
  const r = captureArgv(["git", "diff", "--name-only", range], env, { cwd: dir });
  return r.code === 0 && r.stdout.length > 0 ? r.stdout.split("\n") : [];
}

// `ls-remote` touches only the remote, never the local clone — safe for `botu doctor`
// to call without mutating anything.
export function remoteReachable(url: string, env: Env): boolean {
  return captureArgv(["git", "ls-remote", "--exit-code", url], env).code === 0;
}
