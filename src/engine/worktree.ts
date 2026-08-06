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
// branch ref in place, so no *commit* is ever lost — the branch still points at them
// and `git worktree add` can restore a checkout. That safety claim does NOT extend to
// stack topology: `git worktree remove` deletes the worktree's admin dir, and the
// gh-stack state lives inside it, so the branch chain and its PR numbers are gone from
// this machine. `gh stack checkout <number>` re-attaches them from GitHub.
//
// Two facts about stacked PRs drive the stack handling below:
//   * gh-stack records its state at `$GIT_DIR/gh-stack`, which inside a linked worktree
//     resolves to `.git/worktrees/<name>/gh-stack` — PER-WORKTREE, not the repo-wide
//     `.git/gh-stack` it is widely assumed to be. It is local JSON: reading it needs no
//     `gh` invocation and no network.
//   * a stack publishes via `gh stack submit`, one PR per branch. `git push -u origin
//     <one-layer>` is never how a stack reaches the remote — at best a no-op, at worst
//     it recreates a branch `delete_branch_on_merge` deliberately deleted.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../lib/paths.ts";
import { captureArgvAsync, runArgvAsync } from "../lib/proc.ts";

export interface WorktreeEntry {
  readonly path: string;
  readonly head: string;
  // Branch shortname, or undefined for a detached HEAD.
  readonly branch?: string;
  // Present only when this worktree's admin dir holds gh-stack state. Its presence means
  // the branch at HEAD *may be* one layer of a multi-PR stack — membership still has to be
  // checked, because the file outlives the branch that created it.
  readonly stack?: StackState;
  // The `locked` line's reason text, present only when the worktree is locked. Claude
  // Code writes "claude session <name> (pid NNNN start ...)" here for a live session.
  readonly lock?: string;
  // A registered worktree whose directory is gone; `git worktree prune` reclaims it.
  readonly prunable: boolean;
}

export interface StackPullRequest {
  readonly number: number;
  readonly url?: string;
  // gh-stack's own *local cache* of the PR's state, refreshed only by `gh stack sync` /
  // `gh stack view`. Fine to read for a label; never trusted as proof that a layer landed —
  // that question is answered by patch-id below, so a stale `false` here costs nothing.
  readonly merged?: boolean;
}

export interface StackBranch {
  readonly branch: string;
  // Recorded only once `gh stack submit` has run: a stack that exists purely locally has
  // `{branch, base}` and nothing else (verified against a real un-submitted stack file).
  // The live ref is the primary source for the layer's tree anyway; this is the fallback.
  readonly head?: string;
  readonly base: string;
  readonly pullRequest?: StackPullRequest;
}

export interface StackState {
  // Assigned by `gh stack submit`; a stack that has never been submitted has no number.
  readonly number?: number;
  // Bottom-to-top. Never empty — parseStackState rejects a stack with no usable layers,
  // because an empty roster would read as "every layer landed".
  readonly branches: readonly StackBranch[];
}

function toPullRequest(raw: unknown): StackPullRequest | undefined {
  const o = raw as { number?: unknown; url?: unknown; merged?: unknown } | undefined;
  if (typeof o?.number !== "number") return undefined;
  return {
    number: o.number,
    url: typeof o.url === "string" ? o.url : undefined,
    merged: typeof o.merged === "boolean" ? o.merged : undefined,
  };
}

// Reject the whole stack on the first unusable layer rather than dropping that layer.
// A partially-parsed roster is the dangerous shape: it shortens `total`, and a stack whose
// only surviving layers happen to be landed would then read as fully landed. Undefined
// degrades to the ordinary single-branch judgement, which is always the conservative answer.
function toStack(raw: unknown): StackState | undefined {
  const o = raw as { number?: unknown; branches?: unknown } | undefined;
  if (!Array.isArray(o?.branches) || o.branches.length === 0) return undefined;
  const branches: StackBranch[] = [];
  for (const entry of o.branches) {
    const b = entry as
      | { branch?: unknown; head?: unknown; base?: unknown; pullRequest?: unknown }
      | undefined;
    if (typeof b?.branch !== "string" || typeof b.base !== "string") return undefined;
    if (b.head !== undefined && typeof b.head !== "string") return undefined;
    branches.push({
      branch: b.branch,
      head: b.head,
      base: b.base,
      pullRequest: toPullRequest(b.pullRequest),
    });
  }
  return { number: typeof o.number === "number" ? o.number : undefined, branches };
}

// The gh-stack file, parsed as pure text so the selection rule is testable with no repo on
// disk. `branch` is the worktree's checked-out branch: the stack that names it wins.
//
// The single-stack fallback (return `stacks[0]` even when it names no such branch) is
// deliberately NARROW in meaning: an admin dir can still hold state from earlier work while
// HEAD now sits on an unrelated branch, or is detached. judge() therefore refuses to draw a
// *verdict* from a stack the branch is not a member of — see the membership gate there. The
// fallback's only remaining job is to suppress `--push`, which is always the safe direction.
export function parseStackState(text: string, branch?: string): StackState | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const stacks = (doc as { stacks?: unknown } | undefined)?.stacks;
  if (!Array.isArray(stacks) || stacks.length === 0) return undefined;
  const parsed = stacks.map(toStack);
  // `branch === undefined` (detached HEAD) can never match, since every branch is a string.
  const named = parsed.find((s) => s?.branches.some((b) => b.branch === branch));
  if (named) return named;
  return parsed.length === 1 ? parsed[0] : undefined;
}

// `--absolute-git-dir`, not `--git-dir`: the latter answers a bare relative `.git` in a
// primary checkout, which resolves against the wrong cwd here. Reading the `.git` pointer
// file by hand was rejected outright — that format is git's to change, and `rev-parse` is
// the supported way to ask. No `gh` invocation, no network: this is a local JSON read, and
// a missing file (the overwhelmingly common case) is not an error.
export async function readStackState(
  wt: string,
  branch: string | undefined,
  env: Env,
): Promise<StackState | undefined> {
  const gitdir = await captureArgvAsync(["git", "rev-parse", "--absolute-git-dir"], env, { cwd: wt });
  if (gitdir.code !== 0 || !gitdir.stdout) return undefined;
  try {
    return parseStackState(await Bun.file(join(gitdir.stdout, "gh-stack")).text(), branch);
  } catch {
    return undefined;
  }
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

interface Judgement {
  readonly entry: WorktreeEntry;
  readonly verdict: Verdict;
  // Human-readable justification, shown per-worktree in the report.
  readonly why: string;
  // A "keep" that exists solely because the work lives nowhere but this machine — the tree
  // is clean and nothing is in flight, the commits just aren't on a remote. Publishing the
  // branch resolves it into a "reap", which is what `--push` does. Never set on a verdict
  // held back for any other reason (dirty, locked, unreadable, or holding gh-stack state):
  // those must not be pushed.
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

// The content test. Replay `tree` as a single synthetic commit on top of `parent`, then ask
// `git cherry` whether that patch already exists on the target branch. `-` means yes (an
// equivalent patch-id is upstream) — exactly the shape a squash-merge produces. The
// synthetic commit is written to the object store but is referenced by nothing, so it is
// unreachable and garbage collected in due course.
//
// ⚠️ THE MATCH IS AGAINST THE PROBE'S OWN LINE, NOT "any line starting with -".
// `git cherry <upstream> <head>` lists every commit in `merge-base(upstream,head)..head`,
// one `+`/`-` line each. When `parent` is a merge-base (the single-branch caller below) the
// range is exactly one commit, and matching any `-` line is accidentally correct. A per-layer
// probe parents on a *sibling layer's head*, which is not an ancestor of the target, so the
// range also contains every already-landed layer beneath it — each printed as `-`. Matching
// any line there would declare an unmerged top layer merged and reap live work. `git cherry`
// prints full SHAs, so comparing against the probe's own sha is exact.
async function probeMerged(
  wt: string,
  tree: string,
  parent: string,
  target: string,
  env: Env,
): Promise<boolean> {
  const probe = await captureArgvAsync(
    ["git", "commit-tree", tree, "-p", parent, "-m", "boom-reap-probe"],
    env,
    {
      cwd: wt,
    },
  );
  if (probe.code !== 0 || !probe.stdout) return false;
  const cherry = await captureArgvAsync(["git", "cherry", target, probe.stdout], env, { cwd: wt });
  if (cherry.code !== 0) return false;
  return cherry.stdout.split("\n").some((l) => l.startsWith("- ") && l.slice(2).trim() === probe.stdout);
}

// The whole-worktree content test: HEAD's tree replayed on the merge-base with the target.
export async function isSquashMerged(wt: string, target: string, env: Env): Promise<boolean> {
  const base = await captureArgvAsync(["git", "merge-base", "HEAD", target], env, { cwd: wt });
  if (base.code !== 0 || !base.stdout) return false;
  const tree = await captureArgvAsync(["git", "rev-parse", "HEAD^{tree}"], env, { cwd: wt });
  if (tree.code !== 0 || !tree.stdout) return false;
  return probeMerged(wt, tree.stdout, base.stdout, target, env);
}

async function revParse(wt: string, rev: string, env: Env): Promise<string | undefined> {
  const r = await captureArgvAsync(["git", "rev-parse", "--verify", "--quiet", rev], env, { cwd: wt });
  return r.code === 0 && r.stdout ? r.stdout : undefined;
}

// Resolve the synthetic parent for layer `i`. Every layer's tree contains all the layers
// beneath it, so pairing it with the layer BELOW as parent is what isolates that layer's own
// diff — the whole-tree probe (isSquashMerged) is structurally incapable of matching an
// N-way squash and returns `+` for every layer above the bottom.
//
// The bottom layer uses the live merge-base rather than its recorded `base` because a
// cascading `gh stack sync` rebase supersedes the recorded value the moment trunk moves.
async function layerParent(
  wt: string,
  stack: StackState,
  i: number,
  layerRef: string,
  target: string,
  env: Env,
): Promise<string | undefined> {
  if (i === 0) {
    const mb = await captureArgvAsync(["git", "merge-base", layerRef, target], env, { cwd: wt });
    return mb.code === 0 && mb.stdout ? mb.stdout : undefined;
  }
  const recorded = stack.branches[i]?.base;
  // The recorded base can name an object this clone no longer has (a rewritten history, a
  // pruned commit), so it is verified rather than trusted; the layer below is the fallback.
  if (recorded) {
    const ok = await revParse(wt, `${recorded}^{commit}`, env);
    if (ok) return ok;
  }
  const below = stack.branches[i - 1];
  if (!below) return undefined;
  return (
    (await revParse(wt, `${below.branch}^{commit}`, env)) ??
    (below.head ? await revParse(wt, `${below.head}^{commit}`, env) : undefined)
  );
}

// Judge a stack layer by layer: how many of its branches have their own diff already in the
// target. A layer whose tree or parent cannot be resolved counts as NOT landed — the sweep's
// default answer is always "leave it alone".
export async function layersLanded(
  wt: string,
  stack: StackState,
  target: string,
  env: Env,
): Promise<{ landed: number; total: number }> {
  const total = stack.branches.length;
  let landed = 0;
  for (let i = 0; i < total; i++) {
    const layer = stack.branches[i] as StackBranch;
    // The live ref first: the recorded head goes stale on every `gh stack sync`.
    const layerRef = (await revParse(wt, `${layer.branch}^{commit}`, env)) ?? layer.head;
    if (!layerRef) continue;
    const tree = await revParse(wt, `${layerRef}^{tree}`, env);
    if (!tree) continue;
    const parent = await layerParent(wt, stack, i, layerRef, target, env);
    if (!parent) continue;
    if (await probeMerged(wt, tree, parent, target, env)) landed++;
  }
  return { landed, total };
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
  // Take the stack path ONLY when this worktree's branch is actually a member of the stack.
  // parseStackState's single-stack fallback can hand back a stack recorded by EARLIER work in
  // this admin dir while HEAD now sits on an unrelated branch (or is detached). Judging that
  // entry by layersLanded() would never look at HEAD at all, and because this arm sits above
  // the rev-list gate it would also bypass the unpushed-commits protection — reaping a clean
  // worktree whose commits exist only on this machine, unattended, on the daily timer.
  const inStack =
    entry.stack !== undefined &&
    entry.branch !== undefined &&
    entry.stack.branches.some((b) => b.branch === entry.branch);
  // The position is load-bearing: a fully-pushed stack would otherwise reap below on "every
  // commit is on a remote" while its PRs are all still open — and removing the worktree takes
  // the gh-stack file with it. `skip`, not `keep`, because skip already means "don't ask,
  // don't touch" in the interactive path: the answer to a half-landed stack is `gh stack
  // merge`, not a per-worktree question. `pushable` is never set on this arm.
  if (inStack) {
    const stack = entry.stack as StackState;
    const label = stack.number === undefined ? "unsubmitted stack" : `stack #${stack.number}`;
    if (!target) return { entry, verdict: "skip", why: `${label} — no remote default branch to compare` };
    const { landed, total } = await layersLanded(wt, stack, target, env);
    return landed === total
      ? { entry, verdict: "reap", why: `${label} — all ${total} layer(s) landed in ${target}` }
      : { entry, verdict: "skip", why: `${label} — ${total - landed} of ${total} layers open` };
  }
  // A stack file is present but the branch is not a member (or HEAD is detached): the stack is
  // used ONLY to force pushable=false below, and judgement falls through to the ordinary
  // single-branch path — rev-list gate included.
  //
  // Reachable from HEAD but from no remote-tracking ref — the same question Claude Code's
  // guard asks. Zero means the commits are literally pushed and the guard would have let go.
  const unpushed = await captureArgvAsync(["git", "rev-list", "--count", "HEAD", "--not", "--remotes"], env, {
    cwd: wt,
  });
  if (unpushed.code !== 0) return { entry, verdict: "skip", why: "unreadable (git rev-list failed)" };
  if (unpushed.stdout === "0") return { entry, verdict: "reap", why: "every commit is on a remote" };
  // A detached HEAD has no branch to publish, so it is never pushable — its commits can only
  // be preserved by naming them, which is a decision for a human, not a sweep. Neither is a
  // worktree holding gh-stack state: its branch is publishable, but never THIS way. A stack
  // goes out through `gh stack submit`, so `git push -u origin <one-layer>` is at best a
  // no-op and at worst the sweep undoing a `delete_branch_on_merge`.
  const pushable = entry.branch !== undefined && entry.stack === undefined;
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

type Removal = { readonly ok: true } | { readonly ok: false; readonly error: string };

// Remove the worktree directory, leaving the branch ref untouched. `--force` covers the
// prunable case (a registered worktree whose directory already vanished) and nothing
// else: every reapable entry has already been proven clean by judge().
//
// `wasLocked` handles the crashed-session case. A killed agent leaves its worktree locked,
// and git refuses to remove a locked tree even under a single `--force` ("use 'remove -f -f'
// to override or unlock first") — so without this, judge() correctly rules a stale-locked
// worktree reapable and the removal then fails forever. We unlock first rather than passing
// `-f -f`, because that is the narrower instrument: it only ever runs for an entry judge()
// already cleared, which for a locked entry means the holding PID is provably dead. A live
// lock never reaches here. Unlock failure is ignored — the remove below reports the truth.
export async function removeWorktree(
  repo: string,
  wt: string,
  env: Env,
  wasLocked = false,
): Promise<Removal> {
  if (wasLocked) await runArgvAsync(["git", "worktree", "unlock", wt], env, { cwd: repo, silent: true });
  const { code, stderr } = await runArgvAsync(["git", "worktree", "remove", "--force", wt], env, {
    cwd: repo,
    silent: true,
  });
  if (code === 0) return { ok: true };
  // git's own first line is far more useful than "it failed" — a lock, a missing dir, a
  // dirty tree all read differently and lead to different fixes.
  return { ok: false, error: (stderr ?? "").split("\n")[0]?.trim() || `git worktree remove exited ${code}` };
}

// Delete a local branch outright, losing any commit it alone held. This is the ONLY
// destructive operation in the module — everything else preserves the ref precisely so a
// misjudgement costs nothing — so the automatic sweep never reaches it. It runs only from
// an explicit per-worktree "delete" answer under --interactive. `-D`, not `-d`, because
// discarding work git would otherwise refuse to drop as unmerged is the entire point.
export async function deleteBranch(repo: string, branch: string, env: Env): Promise<boolean> {
  const { code } = await runArgvAsync(["git", "branch", "-D", branch], env, { cwd: repo, silent: true });
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
  const kept = parseWorktreeList(listed.stdout).filter((e) => real(e.path) !== primary);
  // The stack read is attached here, not inside judge(), so that every consumer — the report
  // line, the interactive prompt, the push gate — sees exactly the same answer. One extra
  // `git rev-parse` per linked worktree, run concurrently.
  return Promise.all(kept.map(async (e) => ({ ...e, stack: await readStackState(e.path, e.branch, env) })));
}
