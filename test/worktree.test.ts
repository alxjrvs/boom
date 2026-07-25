// Agent-worktree reaping. The pure parsing/lock rules are asserted directly; the
// verdict rules run against a real git repo with a real remote, because the whole
// point of the module is a claim about git's patch-id behaviour under squash-merge —
// a mocked git would assert nothing.
import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRemoteRef,
  judge,
  linkedWorktrees,
  lockPid,
  parseWorktreeList,
  pidAlive,
} from "../src/engine/worktree.ts";

const ENV: Record<string, string | undefined> = {
  ...process.env,
  GIT_AUTHOR_NAME: "boom test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "boom test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: ENV as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

test("parseWorktreeList: splits stanzas, strips refs/heads/, and flags detached + locked + prunable", () => {
  const out = parseWorktreeList(
    [
      "worktree /repo",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/live",
      "HEAD bbbb",
      "branch refs/heads/worktree-live",
      "locked claude session live (pid 4242 start Fri Jul 24 21:01:24 2026)",
      "",
      "worktree /repo/.claude/worktrees/loose",
      "HEAD cccc",
      "detached",
      "",
      "worktree /repo/.claude/worktrees/gone",
      "HEAD dddd",
      "branch refs/heads/gone",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n"),
  );
  expect(out).toHaveLength(4);
  expect(out[0]).toMatchObject({ path: "/repo", branch: "main" });
  expect(out[1]?.branch).toBe("worktree-live");
  expect(out[1]?.lock).toContain("pid 4242");
  // A detached stanza carries no `branch` line at all.
  expect(out[2]?.branch).toBeUndefined();
  expect(out[3]?.prunable).toBe(true);
});

test("lockPid: reads the pid Claude Code stamps into the lock reason, and tolerates its absence", () => {
  expect(lockPid("claude session foo (pid 98170 start Fri Jul 24 21:01:24 2026)")).toBe(98170);
  expect(lockPid("locked by hand")).toBeUndefined();
  expect(lockPid(undefined)).toBeUndefined();
});

test("pidAlive: true for this process, false for a pid that cannot exist", () => {
  expect(pidAlive(process.pid)).toBe(true);
  // PID 0 is the kernel/swapper on macOS and a process-group wildcard elsewhere; use an
  // absurd pid instead, which is reliably absent.
  expect(pidAlive(0x7ffffff0)).toBe(false);
});

// The scenario the whole module exists for: a branch whose content is squash-merged into
// the default branch. Its own commits then exist on no remote *by SHA* — which is exactly
// what Claude Code's guard measures — while every line of them is upstream.
async function repoWithSquashMergedWorktree(): Promise<{ repo: string; wt: string }> {
  const base = await mkdtemp(join(tmpdir(), "boom-wt-"));
  const origin = join(base, "origin.git");
  const repo = join(base, "repo");
  git(base, "init", "--bare", "--initial-branch=main", origin);
  git(base, "clone", "--quiet", origin, repo);

  Bun.write(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "seed");
  git(repo, "push", "-q", "-u", "origin", "main");

  // A feature branch in a linked worktree, mirroring an agent's throwaway checkout.
  const wt = join(repo, ".claude", "worktrees", "feature");
  git(repo, "worktree", "add", "-q", "-b", "feature", wt);
  Bun.write(join(wt, "feature.txt"), "one\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "feature part 1");
  Bun.write(join(wt, "feature.txt"), "one\ntwo\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "feature part 2");

  // Squash-merge it into main and push — the content lands under a brand-new SHA.
  git(repo, "merge", "--squash", "feature");
  git(repo, "commit", "-qm", "feature (#1)");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  // Resolved, because git reports realpaths and macOS puts the tmpdir behind /var → /private/var.
  return { repo: realpathSync(repo), wt: realpathSync(wt) };
}

test("judge: a squash-merged worktree is reapable even though its commits are on no remote", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();

  // Precondition — the guard's own test fails here. This is the false positive.
  const unpushed = git(wt, "rev-list", "--count", "HEAD", "--not", "--remotes");
  expect(unpushed).not.toBe("0");

  const entries = await linkedWorktrees(repo, ENV);
  expect(entries.map((e) => e.path)).toEqual([wt]);
  const target = await defaultRemoteRef(repo, ENV);
  expect(target).toBe("origin/main");

  const verdict = await judge(entries[0] as NonNullable<(typeof entries)[0]>, target, ENV);
  expect(verdict.verdict).toBe("reap");
  expect(verdict.why).toContain("squash-merged");
});

test("judge: uncommitted changes are kept, and outrank any content analysis", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  await Bun.write(join(wt, "scratch.txt"), "unsaved work\n");

  const entries = await linkedWorktrees(repo, ENV);
  const verdict = await judge(entries[0] as NonNullable<(typeof entries)[0]>, "origin/main", ENV);
  expect(verdict.verdict).toBe("keep");
  expect(verdict.why).toBe("uncommitted changes");
});

test("judge: genuinely unmerged commits are kept", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  // A further commit that was never merged anywhere.
  await Bun.write(join(wt, "feature.txt"), "one\ntwo\nthree\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "feature part 3 — never merged");

  const entries = await linkedWorktrees(repo, ENV);
  const verdict = await judge(entries[0] as NonNullable<(typeof entries)[0]>, "origin/main", ENV);
  expect(verdict.verdict).toBe("keep");
  expect(verdict.why).toContain("not on any remote");
});

test("judge: a fully pushed worktree is reapable without needing the content test", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  git(wt, "push", "-q", "-u", "origin", "feature");

  const entries = await linkedWorktrees(repo, ENV);
  const verdict = await judge(entries[0] as NonNullable<(typeof entries)[0]>, "origin/main", ENV);
  expect(verdict.verdict).toBe("reap");
  expect(verdict.why).toBe("every commit is on a remote");
});

test("judge: a live lock is skipped without inspecting the tree", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  git(repo, "worktree", "lock", "--reason", `claude session feature (pid ${process.pid} start now)`, wt);

  const entries = await linkedWorktrees(repo, ENV);
  const verdict = await judge(entries[0] as NonNullable<(typeof entries)[0]>, "origin/main", ENV);
  expect(verdict.verdict).toBe("skip");
  expect(verdict.why).toContain(`pid ${process.pid}`);
});

test("judge: a lock whose holder is dead falls through to the normal rules", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  git(repo, "worktree", "lock", "--reason", "claude session feature (pid 2147483632 start then)", wt);

  const entries = await linkedWorktrees(repo, ENV);
  const verdict = await judge(entries[0] as NonNullable<(typeof entries)[0]>, "origin/main", ENV);
  expect(verdict.verdict).toBe("reap");
  expect(verdict.why).toContain("squash-merged");
});

test("judge: with no remote default branch, unpushed commits are always kept", async () => {
  const { repo } = await repoWithSquashMergedWorktree();
  const entries = await linkedWorktrees(repo, ENV);
  const verdict = await judge(entries[0] as NonNullable<(typeof entries)[0]>, undefined, ENV);
  expect(verdict.verdict).toBe("keep");
  expect(verdict.why).toContain("no remote default branch");
});
