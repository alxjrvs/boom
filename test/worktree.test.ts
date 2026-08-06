// Agent-worktree reaping. The pure parsing/lock rules are asserted directly; the
// verdict rules run against a real git repo with a real remote, because the whole
// point of the module is a claim about git's patch-id behaviour under squash-merge —
// a mocked git would assert nothing.
import { expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRemoteRef,
  deleteBranch,
  isSquashMerged,
  judge,
  layersLanded,
  linkedWorktrees,
  lockPid,
  parseStackState,
  parseWorktreeList,
  pidAlive,
  pushBranch,
  readStackState,
  removeWorktree,
  type StackState,
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

  expect(await pushBranch(wt, "feature", ENV)).toBe(true);

  // Same worktree, same commits — but they now exist somewhere other than this machine.
  const after = await judge((await linkedWorktrees(repo, ENV))[0] as WorktreeEntry, "origin/main", ENV);
  expect(after.verdict).toBe("reap");
  expect(after.why).toBe("every commit is on a remote");
});

test("pushBranch: reports failure (rather than throwing) when there is no such remote", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  git(repo, "remote", "remove", "origin");
  expect(await pushBranch(wt, "feature", ENV)).toBe(false);
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

// ---------------------------------------------------------------------------------------
// Stacked PRs. A `gh stack` worktree holds one layer of an N-PR chain, and every rule above
// misjudges it: the whole-tree probe can never match an N-way squash (false negative → the
// worktree is kept forever and `--push` re-publishes branches `delete_branch_on_merge`
// deleted), while a per-layer probe against a non-ancestor base emits several `-` lines, so
// a sloppy match turns that into a false positive that reaps live work.
// ---------------------------------------------------------------------------------------

// The verified real-world shape of a submitted stack (`.git/worktrees/<name>/gh-stack`),
// trimmed to the fields the parser reads. Four layers chained base → previous head, PRs
// 108-111, all merged.
const REAL_STACK_JSON = JSON.stringify({
  schemaVersion: 1,
  repository: "github.com:alxjrvs/dotFiles",
  stacks: [
    {
      id: "186114",
      number: 112,
      trunk: { branch: "main", head: "04a1ce7f2125bb41cf5ab0f035413722bf9e3167" },
      branches: [
        {
          branch: "op-deny-hardening",
          head: "de3849bfaf9ac151edc44d08e3df5d3f3b69dc97",
          base: "04a1ce7f2125bb41cf5ab0f035413722bf9e3167",
          pullRequest: { number: 108, url: "https://github.com/alxjrvs/dotFiles/pull/108", merged: true },
        },
        {
          branch: "op-pr-review-allowlist",
          head: "8dea33c2eb7952a8395457c2fdfe2b9cdfd1240d",
          base: "de3849bfaf9ac151edc44d08e3df5d3f3b69dc97",
          pullRequest: { number: 109, url: "https://github.com/alxjrvs/dotFiles/pull/109", merged: true },
        },
        {
          branch: "op-sa-expiry",
          head: "0f4d93bae3f85952ac82804190b5b2708a6ef6b8",
          base: "8dea33c2eb7952a8395457c2fdfe2b9cdfd1240d",
          pullRequest: { number: 110, url: "https://github.com/alxjrvs/dotFiles/pull/110", merged: true },
        },
        {
          branch: "op-docs-drift",
          head: "73fb8d9a6c60264a871f86f44d6c30e956c6e7ae",
          base: "0f4d93bae3f85952ac82804190b5b2708a6ef6b8",
          pullRequest: { number: 111, url: "https://github.com/alxjrvs/dotFiles/pull/111", merged: true },
        },
      ],
    },
  ],
});

test("parseStackState: reads the real gh-stack shape — number, layer chain, PR numbers", () => {
  const s = parseStackState(REAL_STACK_JSON, "op-sa-expiry");
  expect(s?.number).toBe(112);
  expect(s?.branches).toHaveLength(4);
  // The chain is what makes a per-layer probe possible: each layer's base is the one below.
  expect(s?.branches[1]?.base).toBe(s?.branches[0]?.head as string);
  expect(s?.branches[3]?.pullRequest?.number).toBe(111);
});

// A stack that has never been submitted carries neither a number nor per-branch heads —
// verified against a real local-only stack file. Requiring `head` would drop every layer,
// leaving an empty roster that reads as "all layers landed".
test("parseStackState: an un-submitted stack (no number, no heads) still parses as a stack", () => {
  const s = parseStackState(
    JSON.stringify({
      schemaVersion: 1,
      stacks: [{ trunk: { branch: "main", head: "aaa" }, branches: [{ branch: "one", base: "aaa" }] }],
    }),
    "one",
  );
  expect(s?.number).toBeUndefined();
  expect(s?.branches).toHaveLength(1);
  expect(s?.branches[0]?.head).toBeUndefined();
});

test("parseStackState: degrades to undefined rather than half a stack", () => {
  expect(parseStackState("not json")).toBeUndefined();
  expect(parseStackState('{"stacks":[]}')).toBeUndefined();
  // A schemaVersion bump that retypes a field must not yield a short roster — a stack whose
  // surviving layers all happen to be landed would read as fully landed.
  expect(parseStackState('{"stacks":[{"number":1,"branches":[{"branch":7}]}]}')).toBeUndefined();
});

test("parseStackState: picks the stack naming the branch; falls back only when there is exactly one", () => {
  const two = JSON.stringify({
    stacks: [
      { number: 1, branches: [{ branch: "a1", base: "x" }] },
      { number: 2, branches: [{ branch: "b1", base: "y" }] },
    ],
  });
  expect(parseStackState(two, "b1")?.number).toBe(2);
  expect(parseStackState(two, "unrelated")).toBeUndefined();
  // One stack in the file: hand it back even for a stranger. That is push suppression only —
  // judge() refuses to draw a verdict from a stack the branch is not a member of.
  expect(parseStackState(REAL_STACK_JSON, "unrelated")?.number).toBe(112);
  expect(parseStackState(REAL_STACK_JSON, undefined)?.number).toBe(112);
});

// gh-stack state lives at $GIT_DIR/gh-stack, which for a LINKED worktree is the per-worktree
// admin dir — not the repo-wide `.git/gh-stack` it is widely assumed to be. The existence
// assertion is the point: if git ever relocates the admin dir, these tests must fail loudly
// rather than plant a file nothing reads.
function plantStack(repo: string, worktreeName: string, doc: unknown): void {
  const admin = join(repo, ".git", "worktrees", worktreeName);
  expect(existsSync(admin)).toBe(true);
  writeFileSync(join(admin, "gh-stack"), JSON.stringify(doc, null, 2));
}

test("readStackState: reads the per-worktree admin dir, and is undefined where there is no file", async () => {
  const { repo, wt } = await repoWithSquashMergedWorktree();
  expect(await readStackState(wt, "feature", ENV)).toBeUndefined();
  plantStack(repo, "feature", {
    schemaVersion: 1,
    stacks: [{ number: 7, branches: [{ branch: "feature", base: "x" }] }],
  });
  expect((await readStackState(wt, "feature", ENV))?.number).toBe(7);
  // The primary checkout has its own $GIT_DIR and no gh-stack file of its own.
  expect(await readStackState(repo, "main", ENV)).toBeUndefined();
});

test("linkedWorktrees: surfaces the stack state on the entry, for every consumer at once", async () => {
  const { repo } = await repoWithSquashMergedWorktree();
  expect((await linkedWorktrees(repo, ENV))[0]?.stack).toBeUndefined();
  plantStack(repo, "feature", {
    schemaVersion: 1,
    stacks: [{ number: 9, branches: [{ branch: "feature", base: "x" }] }],
  });
  expect((await linkedWorktrees(repo, ENV))[0]?.stack?.number).toBe(9);
});

// A four-layer stack in a linked worktree checked out on the TOP layer, with the bottom
// `landedLayers` layers squash-merged into main as N SEPARATE commits — exactly how
// `gh stack merge --squash` lands one. Each layer touches its own file so the successive
// squash merges never conflict.
async function repoWithMergedStackWorktree(landedLayers: number): Promise<{
  repo: string;
  wt: string;
  layers: string[];
  heads: Record<string, string>;
  seed: string;
  stackDoc: (branches?: string[]) => unknown;
}> {
  const base = await mkdtemp(join(tmpdir(), "boom-stack-"));
  const origin = join(base, "origin.git");
  const repo = join(base, "repo");
  git(base, "init", "--bare", "--initial-branch=main", origin);
  git(base, "clone", "--quiet", origin, repo);

  await Bun.write(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "seed");
  git(repo, "push", "-q", "-u", "origin", "main");
  const seed = git(repo, "rev-parse", "HEAD");

  const layers = ["l1", "l2", "l3", "l4"];
  for (const l of layers) {
    git(repo, "checkout", "-q", "-b", l);
    await Bun.write(join(repo, `${l}.txt`), `${l}\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", `${l} work`);
  }
  git(repo, "checkout", "-q", "main");
  const heads: Record<string, string> = {};
  for (const l of layers) heads[l] = git(repo, "rev-parse", l);

  const wt = join(repo, ".claude", "worktrees", "l4");
  git(repo, "worktree", "add", "-q", wt, "l4");

  for (let i = 0; i < landedLayers; i++) {
    git(repo, "merge", "--squash", layers[i] as string);
    git(repo, "commit", "-qm", `${layers[i]} (#${101 + i})`);
  }
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");

  const stackDoc = (branches: string[] = layers): unknown => ({
    schemaVersion: 1,
    repository: "github.com:test/test",
    stacks: [
      {
        id: "1",
        number: 112,
        trunk: { branch: "main", head: seed },
        branches: branches.map((l, i) => ({
          branch: l,
          head: heads[l],
          base: i === 0 ? seed : (heads[branches[i - 1] as string] as string),
          pullRequest: {
            number: 101 + i,
            url: `https://example.invalid/pull/${101 + i}`,
            merged: i < landedLayers,
          },
        })),
      },
    ],
  });

  return { repo: realpathSync(repo), wt: realpathSync(wt), layers, heads, seed, stackDoc };
}

const only = async (repo: string): Promise<WorktreeEntry> =>
  (await linkedWorktrees(repo, ENV))[0] as WorktreeEntry;

test("layersLanded: an N-way squash is invisible to the whole-tree probe but visible layer by layer", async () => {
  const f = await repoWithMergedStackWorktree(4);
  plantStack(f.repo, "l4", f.stackDoc());

  // The false NEGATIVE this layer fixes: every line of every layer is on main, yet HEAD's
  // whole tree matches no single squash commit's patch-id, so the old rule kept it forever —
  // and `--push` then re-published branches the merge had deliberately deleted.
  expect(await isSquashMerged(f.wt, "origin/main", ENV)).toBe(false);

  const stack = parseStackState(JSON.stringify(f.stackDoc()), "l4") as StackState;
  expect(await layersLanded(f.wt, stack, "origin/main", ENV)).toEqual({ landed: 4, total: 4 });

  const v = await judge(await only(f.repo), "origin/main", ENV);
  expect(v.verdict).toBe("reap");
  expect(v.why).toContain("stack");
  expect(v.why).toContain("4 layer");
});

// ⚠️ The false POSITIVE guard. `git cherry <upstream> <head>` lists every commit in
// merge-base(upstream,head)..head. A per-layer probe parents on a sibling layer's head, which
// is NOT an ancestor of the target, so the range also contains every already-landed layer
// beneath it — each printed as `-`. `.some(l => l.startsWith("-"))` would call the unmerged
// top layer merged and reap live work.
test("layersLanded: matches the probe's own cherry line, not any line", async () => {
  const f = await repoWithMergedStackWorktree(2);
  const stack = parseStackState(JSON.stringify(f.stackDoc(["l1", "l2", "l3"])), "l3") as StackState;
  expect(await layersLanded(f.wt, stack, "origin/main", ENV)).toEqual({ landed: 2, total: 3 });

  // Pin the mechanism: build l3's probe exactly as layersLanded does and show the output the
  // old predicate would have matched.
  const probe = git(
    f.wt,
    "commit-tree",
    git(f.wt, "rev-parse", "l3^{tree}"),
    "-p",
    f.heads.l2 as string,
    "-m",
    "boom-reap-probe",
  );
  const cherry = git(f.wt, "cherry", "origin/main", probe).split("\n");
  expect(cherry.length).toBeGreaterThan(1);
  expect(cherry.some((l) => l.startsWith("-"))).toBe(true);
  // …and none of those `-` lines is the probe: l3 is genuinely unmerged.
  expect(cherry.some((l) => l.startsWith("- ") && l.slice(2).trim() === probe)).toBe(false);
});

// The live outward-facing bug: `code reap --push` runs on a daily launchd timer, and a stack
// whose PRs are still open used to read as an ordinary keep with `pushable === true`.
test("judge: a stacked worktree is never pushable — --push must not publish a stack layer", async () => {
  const f = await repoWithMergedStackWorktree(3);
  plantStack(f.repo, "l4", f.stackDoc());

  const v = await judge(await only(f.repo), "origin/main", ENV);
  expect(v.verdict).toBe("skip");
  expect(v.why).toMatch(/stack #\d+ — 1 of 4 layers open/);
  // Never set on the stack arm: `code reap --push` reads `pushable === true`.
  expect(v.pushable).toBeUndefined();
});

// Ordering regression. The stack arm sits ABOVE the `rev-list --count HEAD --not --remotes`
// gate on purpose: a stack whose every branch is pushed would otherwise reap on "every commit
// is on a remote" while all four PRs are still open — and removal takes the gh-stack file too.
test("judge: a fully pushed but unmerged stack is skipped, not reaped", async () => {
  const f = await repoWithMergedStackWorktree(0);
  for (const l of f.layers) git(f.repo, "push", "-q", "-u", "origin", l);
  plantStack(f.repo, "l4", f.stackDoc());
  expect(git(f.wt, "rev-list", "--count", "HEAD", "--not", "--remotes")).toBe("0");

  const v = await judge(await only(f.repo), "origin/main", ENV);
  expect(v.verdict).toBe("skip");
  expect(v.why).toMatch(/4 of 4 layers open/);
});

// The bottom layer takes its parent from the live merge-base, not the recorded base: a
// cascading `gh stack sync` rebase supersedes the recorded value the moment trunk moves.
test("layersLanded: the bottom layer survives a stale recorded base", async () => {
  const f = await repoWithMergedStackWorktree(4);
  const doc = f.stackDoc() as { stacks: { branches: { base: string }[] }[] };
  (doc.stacks[0]?.branches[0] as { base: string }).base = "0".repeat(40);
  const stack = parseStackState(JSON.stringify(doc), "l4") as StackState;
  expect(await layersLanded(f.wt, stack, "origin/main", ENV)).toEqual({ landed: 4, total: 4 });
});

test("judge: a stack with no remote default branch to compare is skipped, never reaped", async () => {
  const f = await repoWithMergedStackWorktree(4);
  plantStack(f.repo, "l4", f.stackDoc());
  const v = await judge(await only(f.repo), undefined, ENV);
  expect(v.verdict).toBe("skip");
  expect(v.why).toContain("no remote default branch");
  expect(v.pushable).toBeUndefined();
});

// ⚠️ The membership gate. parseStackState's single-stack fallback hands back a stack recorded
// by EARLIER work in this admin dir even when HEAD has moved to an unrelated branch. Judging
// that entry by layersLanded() would never look at HEAD at all — and because the stack arm
// sits above the rev-list gate it would bypass the unpushed-commits protection, reaping a
// clean worktree whose commits exist only on this machine, unattended, on the daily timer.
test("judge: an unrelated branch with local-only commits is not reaped because a planted stack landed", async () => {
  const f = await repoWithMergedStackWorktree(4);
  plantStack(f.repo, "l4", f.stackDoc());
  git(f.wt, "checkout", "-q", "-b", "unrelated");
  await Bun.write(join(f.wt, "only-here.txt"), "exists nowhere else\n");
  git(f.wt, "add", "-A");
  git(f.wt, "commit", "-qm", "work that exists on no remote");

  const v = await judge(await only(f.repo), "origin/main", ENV);
  expect(v.verdict).toBe("keep");
  expect(v.why).toMatch(/commit\(s\) not on any remote/);
  // The fallthrough return carries the field, and it is false — the stack still suppresses
  // auto-push. `not.toBe(true)` is the exact predicate `code reap --push` applies.
  expect(v.pushable).not.toBe(true);
});

test("judge: a detached HEAD in a stack-bearing worktree is kept, not reaped", async () => {
  const f = await repoWithMergedStackWorktree(4);
  plantStack(f.repo, "l4", f.stackDoc());
  git(f.wt, "checkout", "-q", "--detach");

  const v = await judge(await only(f.repo), "origin/main", ENV);
  expect(v.verdict).toBe("keep");
  expect(v.why).toMatch(/commit\(s\) not on any remote/);
  expect(v.pushable).not.toBe(true);
});
