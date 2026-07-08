// The dotfiles repo's own git state, synced before apply/sync reconciles. Best-effort:
// no git binary, no remote, or no upstream branch all mean "nothing to sync" rather than
// an error — not every dotfiles repo is git-managed, and botu shouldn't demand it is.
import { cleanEnv } from "./proc.ts";
import type { Reporter } from "./reporter.ts";

type Env = Record<string, string | undefined>;

export type GitSyncMode = "pull" | "hard" | "commit";

export interface GitSyncResult {
  // false: syncRepo/commitLocalChanges already reported the failure — the caller must
  // abort before reconciling against a repo left in an unknown or conflicted state.
  readonly ok: boolean;
}

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function git(args: string[], repo: string, env: Env): GitResult {
  const p = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: cleanEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, stdout: p.stdout.toString().trim(), stderr: p.stderr.toString().trim() };
}

function isGitRepo(repo: string, env: Env): boolean {
  return git(["rev-parse", "--git-dir"], repo, env).code === 0;
}

function isDirty(repo: string, env: Env): boolean {
  return git(["status", "--porcelain"], repo, env).stdout.length > 0;
}

function upstreamRef(repo: string, env: Env): string | undefined {
  const r = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repo, env);
  return r.code === 0 ? r.stdout : undefined;
}

function rebaseOnto(repo: string, env: Env, ref: string, report: Reporter): GitSyncResult {
  const r = git(["rebase", ref], repo, env);
  if (r.code !== 0) {
    git(["rebase", "--abort"], repo, env);
    report.fail(
      `dotfiles repo: rebase onto ${ref} failed — resolve manually (\`git -C ${repo} pull --rebase\`): ${r.stderr}`,
    );
    return { ok: false };
  }
  report.ok(`dotfiles repo up to date with ${ref}`);
  return { ok: true };
}

// Commits every uncommitted change (tracked + untracked) in the repo as one commit.
// Shared by `botu commit` and apply's --commit mode, so the message + behavior can't
// drift between the two entry points.
export function commitLocalChanges(
  repo: string,
  env: Env,
  report: Reporter,
  message?: string,
): GitSyncResult {
  if (!isGitRepo(repo, env)) {
    report.fail(`${repo} is not a git repository — nothing to commit`);
    return { ok: false };
  }
  if (!isDirty(repo, env)) {
    report.ok("dotfiles repo: nothing to commit");
    return { ok: true };
  }
  git(["add", "-A"], repo, env);
  const msg = message ?? "botu: local changes";
  const c = git(["commit", "-m", msg], repo, env);
  if (c.code !== 0) {
    report.fail(`dotfiles repo: git commit failed: ${c.stderr}`);
    return { ok: false };
  }
  report.ok(`dotfiles repo: committed local changes (${msg})`);
  return { ok: true };
}

export interface SyncOptions {
  readonly commitMessage?: string;
  // apply --dry-run: report what would happen without mutating the repo's git state.
  readonly dryRun?: boolean;
}

// Keeps the dotfiles repo current with its remote before reconciling:
//  - "pull" (default): stash any local edits, rebase local commits onto the pulled
//    upstream, then pop the stash back on top.
//  - "commit": commit local edits first, so the rebase replays them as a real commit.
//  - "hard": discard all local commits and edits, resetting to match upstream exactly.
export function syncRepo(
  repo: string,
  env: Env,
  mode: GitSyncMode,
  report: Reporter,
  opts?: SyncOptions,
): GitSyncResult {
  if (!isGitRepo(repo, env)) return { ok: true };
  report.header("dotfiles repo");

  if (opts?.dryRun) {
    report.note(`dry run — skipping repo sync (would ${mode})`);
    return { ok: true };
  }

  const fetch = git(["fetch"], repo, env);
  if (fetch.code !== 0) {
    if (mode === "hard") {
      report.fail(`dotfiles repo: git fetch failed — refusing --hard: ${fetch.stderr}`);
      return { ok: false };
    }
    report.warn("dotfiles repo: could not fetch remote — continuing with local state");
    return { ok: true };
  }

  const ref = upstreamRef(repo, env);
  if (!ref) {
    if (mode === "hard") {
      report.fail("dotfiles repo: no upstream branch configured — nothing for --hard to reset to");
      return { ok: false };
    }
    return { ok: true }; // nothing to pull; proceed with local state as-is
  }

  if (mode === "hard") {
    const r = git(["reset", "--hard", ref], repo, env);
    if (r.code !== 0) {
      report.fail(`dotfiles repo: git reset --hard ${ref} failed: ${r.stderr}`);
      return { ok: false };
    }
    report.ok(`dotfiles repo reset --hard to ${ref}`);
    return { ok: true };
  }

  const dirty = isDirty(repo, env);

  if (mode === "commit") {
    if (dirty) {
      const committed = commitLocalChanges(repo, env, report, opts?.commitMessage);
      if (!committed.ok) return committed;
    }
    return rebaseOnto(repo, env, ref, report);
  }

  // mode === "pull"
  if (dirty) {
    const stash = git(["stash", "push", "-u", "-m", "botu: apply autostash"], repo, env);
    if (stash.code !== 0) {
      report.fail(`dotfiles repo: could not stash local changes: ${stash.stderr}`);
      return { ok: false };
    }
  }
  const rebased = rebaseOnto(repo, env, ref, report);
  if (!rebased.ok) {
    if (dirty)
      report.note(
        `dotfiles repo: local changes are stashed — resolve the rebase, then \`git -C ${repo} stash pop\``,
      );
    return rebased;
  }
  if (dirty) {
    const pop = git(["stash", "pop"], repo, env);
    if (pop.code !== 0) {
      report.fail(
        `dotfiles repo: git stash pop failed — resolve manually in ${repo} (your changes are stashed, not lost)`,
      );
      return { ok: false };
    }
  }
  return { ok: true };
}
