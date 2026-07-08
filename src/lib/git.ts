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

export function isClean(dir: string, env: Env): boolean {
  const r = captureArgv(["git", "status", "--porcelain"], env, { cwd: dir });
  return r.code === 0 && r.stdout.length === 0;
}

// Whether HEAD has an upstream tracking ref (@{u} resolves). False for a detached
// HEAD after pinning to a tag/sha — the caller reads that as "not tracking a moving
// branch" rather than as an error.
export function hasUpstream(dir: string, env: Env): boolean {
  return captureArgv(["git", "rev-parse", "--abbrev-ref", "@{u}"], env, { cwd: dir }).code === 0;
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
