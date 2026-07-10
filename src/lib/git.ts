// Thin git plumbing for a repo-only config source: clone/fetch/pull the managed
// config-repo clone, and answer the small questions engine/sync.ts and `botu doctor`/
// `botu source push` need (ahead/behind, upstream, reachability). Shells out via
// captureArgv — no libgit2, no GitHub API client; ambient git/SSH auth is whatever
// already works in the user's shell.
import { type CaptureResult, captureArgv, type Env, runArgv, type ShellResult } from "./proc.ts";

export function cloneRepo(url: string, dest: string, env: Env): CaptureResult {
  return captureArgv(["git", "clone", url, dest], env);
}

export function fetchOrigin(dir: string, env: Env): CaptureResult {
  return captureArgv(["git", "fetch", "origin"], env, { cwd: dir });
}

export function ffPull(dir: string, env: Env): CaptureResult {
  return captureArgv(["git", "pull", "--ff-only"], env, { cwd: dir });
}

// --autostash: git itself stashes any dirty tracked changes before rebasing and
// restores them after — including automatically on `rebaseAbort`, so a conflict
// never strands local edits. Untracked files are never touched by a rebase, so they
// don't need stashing for this to be safe.
export function pullRebaseAutostash(dir: string, env: Env): CaptureResult {
  return captureArgv(["git", "pull", "--rebase", "--autostash"], env, { cwd: dir });
}

export function rebaseOnto(dir: string, ref: string, env: Env): CaptureResult {
  return captureArgv(["git", "rebase", ref], env, { cwd: dir });
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

// One-line `<sha> <subject>` per commit hasUnpushedCommits flagged — for a guard's
// error message, so discarding them is an informed choice rather than a leap of faith.
export function unpushedCommits(dir: string, env: Env): string[] {
  const r = captureArgv(["git", "log", "--oneline", "HEAD", "--not", "--remotes"], env, { cwd: dir });
  return r.code === 0 && r.stdout.length > 0 ? r.stdout.split("\n") : [];
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

// Stream the working-tree diff against HEAD straight to the caller's terminal (like a
// `run` step / hook — inherited stdout, so git colors and pages it exactly as a bare
// `git diff` would, with nothing buffered in memory). Covers both staged and unstaged
// edits to tracked files; untracked files never appear in `git diff`, so callers list
// those separately via untrackedFiles.
export function diffHead(dir: string, env: Env): ShellResult {
  return runArgv(["git", "diff", "HEAD"], env, { cwd: dir });
}

// Paths git isn't tracking yet — the new files `git diff` omits but `botu source commit`
// (git add -A) would capture. Mirrors the `--others` half of the porcelain status so a
// `botu source diff` doesn't silently hide a freshly added base file.
export function untrackedFiles(dir: string, env: Env): string[] {
  const r = captureArgv(["git", "ls-files", "--others", "--exclude-standard"], env, { cwd: dir });
  return r.code === 0 && r.stdout.length > 0 ? r.stdout.split("\n") : [];
}

// `ls-remote` touches only the remote, never the local clone — safe for `botu doctor`
// to call without mutating anything.
export function remoteReachable(url: string, env: Env): boolean {
  return captureArgv(["git", "ls-remote", "--exit-code", url], env).code === 0;
}
