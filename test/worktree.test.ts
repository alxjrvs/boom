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
  archiveRef,
  defaultRemoteRef,
  deleteBranch,
  isDivergedRejection,
  judge,
  linkedWorktrees,
  lockPid,
  parseWorktreeList,
  pidAlive,
  pushBranch,
  removeWorktree,
  type WorktreeEntry,
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

test("judge: unmerged work is flagged pushable — the only keep --push is allowed to act on", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  await Bun.write(join(wt, "feature.txt"), "one\ntwo\nthree\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "feature part 3 — never merged");

  const entries = await linkedWorktrees(repo, ENV);
  const verdict = await judge(entries[0] as NonNullable<(typeof entries)[0]>, "origin/main", ENV);
  expect(verdict.verdict).toBe("keep");
  expect(verdict.pushable).toBe(true);
});

test("judge: a dirty tree is never pushable, so --push can't publish work-in-progress", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  await Bun.write(join(wt, "scratch.txt"), "unsaved work\n");

  const entries = await linkedWorktrees(repo, ENV);
  const verdict = await judge(entries[0] as NonNullable<(typeof entries)[0]>, "origin/main", ENV);
  expect(verdict.verdict).toBe("keep");
  expect(verdict.pushable).toBeUndefined();
});

test("pushBranch: publishing unmerged work turns a keep into a reap", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  await Bun.write(join(wt, "feature.txt"), "one\ntwo\nthree\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "feature part 3 — never merged");

  const before = await judge((await linkedWorktrees(repo, ENV))[0] as WorktreeEntry, "origin/main", ENV);
  expect(before.verdict).toBe("keep");

  const pushed = await pushBranch(wt, "feature", ENV);
  expect(pushed).toMatchObject({ ok: true, ref: "feature", archived: false });

  // Same worktree, same commits — but they now exist somewhere other than this machine.
  const after = await judge((await linkedWorktrees(repo, ENV))[0] as WorktreeEntry, "origin/main", ENV);
  expect(after.verdict).toBe("reap");
  expect(after.why).toBe("every commit is on a remote");
});

test("pushBranch: reports failure (rather than throwing) when there is no such remote", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  git(repo, "remote", "remove", "origin");
  const pushed = await pushBranch(wt, "feature", ENV);
  expect(pushed.ok).toBe(false);
  // git's own words, not a bare "it failed" — and never the `To <url>` line, which names
  // the remote rather than the problem.
  if (!pushed.ok) expect(pushed.error).toMatch(/origin/);
});

// The dead end this fallback exists for: the remote holds a branch of the same name whose
// history has diverged (the agent rebased, or its PR was closed and the remote moved on).
// A non-forced push is then rejected forever, so before the fallback every later sweep
// re-ran the same doomed push and neither guard would ever release the worktree.
function divergeFromRemote(wt: string): void {
  git(wt, "push", "-q", "-u", "origin", "feature");
  // Amending after the push leaves local and remote each holding a commit the other lacks —
  // the remote's tip is no longer an ancestor of HEAD, which is exactly non-fast-forward.
  Bun.write(join(wt, "feature.txt"), "one\ntwo\nrewritten\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "--amend", "-m", "rewritten after the remote moved on");
}

test("isDivergedRejection: only a rejected push with a not-a-fast-forward reason qualifies", () => {
  const rejected = [
    "To https://github.com/o/r.git",
    " ! [rejected]        feature -> feature (non-fast-forward)",
    "error: failed to push some refs",
  ].join("\n");
  expect(isDivergedRejection(rejected)).toBe(true);
  expect(isDivergedRejection(rejected.replace("non-fast-forward", "fetch first"))).toBe(true);
  expect(isDivergedRejection(rejected.replace("non-fast-forward", "stale info"))).toBe(true);
  // A rejection for a reason another name cannot fix must NOT divert to the archive ref.
  expect(isDivergedRejection(rejected.replace("non-fast-forward", "protected branch hook declined"))).toBe(
    false,
  );
  expect(isDivergedRejection("fatal: 'origin' does not appear to be a git repository")).toBe(false);
  expect(isDivergedRejection("")).toBe(false);
});

test("pushBranch: a diverged remote branch parks the commits at an archive ref, and that reaps", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  divergeFromRemote(wt);

  // Precondition: the branch's own name is unpushable, which is the permanent dead end.
  const held = await judge((await linkedWorktrees(repo, ENV))[0] as WorktreeEntry, "origin/main", ENV);
  expect(held.verdict).toBe("keep");
  expect(held.pushable).toBe(true);

  const head = git(wt, "rev-parse", "HEAD");
  const pushed = await pushBranch(wt, "feature", ENV, head);
  expect(pushed).toMatchObject({ ok: true, archived: true, ref: archiveRef("feature", head) });

  // The existing remote branch is untouched — nothing was overwritten to achieve this.
  expect(git(repo, "rev-parse", "origin/feature")).not.toBe(head);
  // And the local branch keeps tracking its own upstream, not the archive ref.
  expect(git(wt, "rev-parse", "--abbrev-ref", "feature@{upstream}")).toBe("origin/feature");

  const after = await judge((await linkedWorktrees(repo, ENV))[0] as WorktreeEntry, "origin/main", ENV);
  expect(after.verdict).toBe("reap");
  expect(after.why).toBe("every commit is on a remote");
});

test("pushBranch: parking the same commits twice is a no-op, not a second ref", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  divergeFromRemote(wt);
  const head = git(wt, "rev-parse", "HEAD");

  expect((await pushBranch(wt, "feature", ENV, head)).ok).toBe(true);
  // Idempotent because the ref name is a function of the commit: git answers "up to date".
  expect(await pushBranch(wt, "feature", ENV, head)).toMatchObject({ ok: true, archived: true });
  const archived = git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/boom/");
  expect(archived.split("\n").filter((l) => l !== "")).toEqual([
    `refs/remotes/origin/${archiveRef("feature", head)}`,
  ]);
});

test("pushBranch: a failing fallback is reported, never silently treated as parked", async () => {
  const { wt } = await repoWithSquashMergedWorktree();
  divergeFromRemote(wt);
  const head = git(wt, "rev-parse", "HEAD");
  // Occupy the archive ref itself with unrelated history, so the fallback push is rejected
  // too. Contrived on purpose: the point is that a sweep reports the truth instead of
  // reaping a worktree whose commits it never actually managed to publish.
  git(wt, "push", "-q", "origin", `origin/main:refs/heads/${archiveRef("feature", head)}`);

  const pushed = await pushBranch(wt, "feature", ENV, head);
  expect(pushed.ok).toBe(false);
});

// The only destructive path in the module, reachable solely from an explicit "delete"
// answer under --interactive. Worth proving it (a) really discards unmerged work, and
// (b) needs the worktree gone first — git refuses to drop a checked-out branch.
test("deleteBranch: refuses while the branch is checked out, and discards it once freed", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  await Bun.write(join(wt, "feature.txt"), "one\ntwo\nthree\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "unmerged work about to be thrown away");
  expect(git(repo, "rev-parse", "--verify", "feature")).toBeTruthy();

  // Checked out in the worktree — git will not delete it, so this can't be half-done.
  expect(await deleteBranch(repo, "feature", ENV)).toBe(false);
  expect(git(repo, "rev-parse", "--verify", "feature")).toBeTruthy();

  expect((await removeWorktree(repo, wt, ENV)).ok).toBe(true);
  expect(await deleteBranch(repo, "feature", ENV)).toBe(true);

  const gone = Bun.spawnSync(["git", "rev-parse", "--verify", "feature"], {
    cwd: repo,
    env: ENV as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(gone.exitCode).not.toBe(0);
});

// Regression: judge() rules a stale-locked worktree reapable (holder PID is dead), but git
// refuses to remove a locked tree even under a single --force — so the sweep detected the
// crashed-session case and could never actually clear it. removeWorktree unlocks first when
// told the entry was locked.
test("removeWorktree: reclaims a stale-locked worktree, but only when told it was locked", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  git(repo, "worktree", "lock", "--reason", "claude session feature (pid 2147483632 start then)", wt);

  // judge() already clears it — the holder is long gone.
  const entry = (await linkedWorktrees(repo, ENV))[0] as WorktreeEntry;
  expect((await judge(entry, "origin/main", ENV)).verdict).toBe("reap");

  // Without the lock hint, git blocks and says why.
  const blocked = await removeWorktree(repo, wt, ENV);
  expect(blocked.ok).toBe(false);
  if (!blocked.ok) expect(blocked.error).toContain("locked");

  expect((await removeWorktree(repo, wt, ENV, true)).ok).toBe(true);
});

test("removeWorktree alone leaves the branch — the non-destructive default", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  const before = git(repo, "rev-parse", "feature");
  expect((await removeWorktree(repo, wt, ENV)).ok).toBe(true);
  // Same SHA, still resolvable: `git worktree add` restores a checkout of exactly this.
  expect(git(repo, "rev-parse", "feature")).toBe(before);
});

test("judge: with no remote default branch, unpushed commits are always kept", async () => {
  const { repo } = await repoWithSquashMergedWorktree();
  const entries = await linkedWorktrees(repo, ENV);
  const verdict = await judge(entries[0] as NonNullable<(typeof entries)[0]>, undefined, ENV);
  expect(verdict.verdict).toBe("keep");
  expect(verdict.why).toContain("no remote default branch");
});
