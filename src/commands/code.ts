// `boom code <init|claude|cmux|fetch|reap>` — open portals to your code workspaces, and
// keep them tidy. A nested route map. `claude` flattens every repo into a symlink farm
// and opens the agent view there; `cmux` opens one workspace per repo; `fetch` keeps
// every repo's origin warm; `reap` sweeps away spent agent worktrees. All honor
// --dry-run (the tested path) and only spawn the backend tool when it's present.

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { buildCommand, buildRouteMap } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import {
  agentsFarmDir,
  codeBreadcrumbPath,
  findRepos,
  materializeAgentsFarm,
  planAgentsFarm,
  pruneFarmProject,
  requireCodeDir,
} from "../engine/code.ts";
import {
  defaultRemoteRef,
  deleteBranch,
  judge,
  linkedWorktrees,
  pushBranch,
  removeWorktree,
  type StackBranch,
  type StackState,
} from "../engine/worktree.ts";
import { type Choice, choose } from "../lib/confirm.ts";
import { cleanEnv, hasCommand, runArgvAsync } from "../lib/proc.ts";
import { bandsReporter } from "../lib/reporter.ts";
import { str } from "./flags.ts";

const initCommand = buildCommand<Record<never, never>, [string?], BoomContext>({
  docs: { brief: "Record the code dir (default ~/Code)" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ parse: str, optional: true, placeholder: "dir", brief: "code directory" }],
    },
  },
  async func(_flags, dir) {
    const target = dir ?? `${this.env.HOME ?? ""}/Code`;
    const crumb = codeBreadcrumbPath(this.env);
    await mkdir(dirname(crumb), { recursive: true });
    await writeFile(crumb, `${target}\n`);
    this.process.stdout.write(`boom: code dir recorded → ${target}\n`);
  },
});

const rel = (root: string, p: string) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);

// `boom code claude` — flatten ~/Code into a symlink farm and open `claude agents`
// there, so every repo is @-taggable for dispatch even with no running agents.
const claudeCommand = buildCommand<{ dryRun?: boolean }, [], BoomContext>({
  docs: { brief: "Symlink every repo into one dir and open `claude agents` there" },
  parameters: {
    flags: { dryRun: { kind: "boolean", optional: true, brief: "Plan only; touch nothing, spawn nothing" } },
  },
  async func(flags) {
    const root = await requireCodeDir(this);
    if (!root) return;
    const { links, collisions } = await planAgentsFarm(root, this.env);
    const farm = agentsFarmDir(this.env);
    const report = bandsReporter(this.process, this.env, "code", { setup: "OPENING THE PORTAL…" });
    report.header(`agent farm (${root} → ${farm})`);
    for (const { name, target } of links) report.ok(`${name} → ${rel(root, target)}`);
    for (const { name, target } of collisions)
      report.warn(`${name} skipped (name already taken) → ${rel(root, target)}`);

    if (flags.dryRun) {
      report.plan(`would symlink the above into ${farm} and run: claude agents`);
      report.finish({ ok: `${links.length} repo(s) planned` });
      return;
    }
    await materializeAgentsFarm(this.env, links);
    if (!hasCommand("claude", this.env)) {
      report.warn(`farm ready — claude not found; run \`claude agents\` in ${farm}`);
      report.finish({ ok: "farm ready", warn: (w) => `${w} note(s)` });
      return;
    }
    // Verdict before handing the terminal to the interactive session.
    report.finish({ ok: `${links.length} repo(s) linked — launching claude agents` });
    await Bun.spawn(["claude", "agents"], {
      cwd: farm,
      env: cleanEnv(this.env),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).exited;
    // `claude agents` registers the farm cwd as a project; drop that ghost entry so
    // the disposable index never lingers in Claude's project/agent-view list.
    await pruneFarmProject(this.env, farm);
  },
});

// `boom code cmux` — one cmux workspace per repo.
const cmuxCommand = buildCommand<{ dryRun?: boolean }, [], BoomContext>({
  docs: { brief: "One cmux workspace per repo" },
  parameters: { flags: { dryRun: { kind: "boolean", optional: true, brief: "Plan only; spawn nothing" } } },
  async func(flags) {
    const root = await requireCodeDir(this);
    if (!root) return;
    const repos = await findRepos(root, this.env);
    // verbose (stream, no krackle): the loop spawns `cmux open` with inherited stdout while the
    // band is open, so a dense-mode krackle line would be corrupted by the child's output when
    // closeBand's \r rewrite fires. Streaming avoids the in-place rewrite entirely.
    const report = bandsReporter(this.process, this.env, "code", {
      verbose: true,
      setup: "OPENING WORKSPACES…",
    });
    report.header(`cmux workspaces (${root})`);
    const live = !flags.dryRun && hasCommand("cmux", this.env);
    for (const repo of repos) {
      if (!live) {
        const why = flags.dryRun ? "plan" : "cmux not found";
        report.plan(`${rel(root, repo)} → [${why}] cmux workspace`);
        continue;
      }
      await Bun.spawn(["cmux", "open", repo], {
        cwd: repo,
        env: cleanEnv(this.env),
        stdout: "inherit",
        stderr: "inherit",
      }).exited;
      report.ok(`${rel(root, repo)} → launched`);
    }
    report.finish({ ok: `${repos.length} repo(s)` });
  },
});

// `boom code fetch` — `git fetch` every repo under the code dir, so `origin/HEAD` is warm
// whenever an agent's `worktree.baseRef: "fresh"` worktree is cut off it. Runs as the login
// user, so it uses the existing git credential helper (headless, no biometric). Standalone,
// and the command the `[boom] code_fetch_schedule` launchd timer invokes on its interval.
const fetchCommand = buildCommand<{ dryRun?: boolean }, [], BoomContext>({
  docs: { brief: "git fetch every code-dir repo (keep origin warm for agent worktrees)" },
  parameters: {
    flags: { dryRun: { kind: "boolean", optional: true, brief: "List repos; fetch nothing" } },
  },
  async func(flags) {
    const root = await requireCodeDir(this);
    if (!root) return;
    const repos = await findRepos(root, this.env);
    const report = bandsReporter(this.process, this.env, "code fetch", {
      setup: "FANNING OUT ACROSS THE CODE DIR…",
    });
    report.header(`git fetch (${root})`);
    let failed = 0;
    for (const repo of repos) {
      if (flags.dryRun) {
        report.plan(`${rel(root, repo)} → git fetch`);
        continue;
      }
      // --quiet + --no-tags: keep the branch refs current without pulling every tag or
      // narrating; --prune drops refs deleted upstream so stale branches don't accumulate. Each
      // repo's fetch spins under its own name, so a slow fan-out shows which repo it's on.
      const { code } = await report.spin(rel(root, repo), () =>
        runArgvAsync(["git", "fetch", "--quiet", "--prune", "--no-tags"], this.env, {
          cwd: repo,
          quietStdout: true,
        }),
      );
      // A failed fetch (offline, auth) is tolerated — a warm-cache courtesy, not a gate — so it's
      // a warning, not a failure; the verdict stays COMPLETE unless every repo fails (below).
      if (code === 0) report.ok(rel(root, repo));
      else {
        failed++;
        report.warn(`${rel(root, repo)} (git fetch exit ${code})`);
      }
    }
    report.finish({ ok: `${repos.length} repo(s) fetched`, warn: (w) => `${w} repo(s) failed` });
    // Non-zero only if every repo failed (a real, systemic problem), overriding finish's warn→2.
    this.process.exitCode = repos.length > 0 && failed === repos.length ? 1 : 0;
  },
});

// A stack that has never been submitted has no number, so it cannot be named by one.
const stackLabel = (s: StackState): string =>
  s.number === undefined ? "unsubmitted stack" : `stack #${s.number}`;
// PR number where there is one, branch name where there isn't — the reader needs whichever
// handle actually identifies the layer.
const layerLabel = (b: StackBranch): string => (b.pullRequest ? `#${b.pullRequest.number}` : b.branch);
// judge()'s stack verdicts already open with the label, so repeating it there is noise. On
// the non-member path they don't, and naming it is the *only* clue about why --push left a
// clean, unpushed worktree alone.
const stackHint = (s: StackState, why: string): string =>
  ` (${why.startsWith(stackLabel(s)) ? "" : `${stackLabel(s)} — `}publish with \`gh stack submit\`, not --push)`;

// `boom code reap` — remove agent worktrees whose work is already safe, across every
// repo under the code dir. Claude Code keeps a worktree whenever a HEAD commit exists on
// no remote *by SHA*, which a squash-merge always violates even though the content
// landed — so they pile up and sessions can't be closed. This re-asks the question by
// content (patch-id) and removes only the directory, never the branch ref.
const reapCommand = buildCommand<
  { dryRun?: boolean; push?: boolean; interactive?: boolean },
  [],
  BoomContext
>({
  docs: { brief: "Remove agent worktrees whose work is merged or pushed (keeps branches)" },
  parameters: {
    flags: {
      dryRun: { kind: "boolean", optional: true, brief: "Classify only; remove nothing" },
      push: {
        kind: "boolean",
        optional: true,
        brief: "Publish branches whose commits exist nowhere else, then reap them too",
      },
      interactive: {
        kind: "boolean",
        optional: true,
        brief: "Ask what to do with each worktree that isn't safe to remove",
      },
    },
    aliases: { i: "interactive" },
  },
  async func(flags) {
    const root = await requireCodeDir(this);
    if (!root) return;
    const repos = await findRepos(root, this.env);
    const report = bandsReporter(this.process, this.env, "code reap", {
      setup: "SWEEPING AGENT WORKTREES…",
    });
    report.header(`agent worktrees (${root})`);
    let reaped = 0;
    let kept = 0;
    let deleted = 0;
    // Set by answering "q" to any prompt: stop asking for the rest of the sweep, but let the
    // sweep itself finish — quitting the questions is not quitting the safe cleanup.
    let stopAsking = false;
    for (const repo of repos) {
      const entries = await linkedWorktrees(repo, this.env);
      if (entries.length === 0) continue;
      const target = await defaultRemoteRef(repo, this.env);
      for (const entry of entries) {
        const name = `${rel(root, repo)}/${basename(entry.path)}`;
        let { verdict, why, pushable } = await report.spin(name, () => judge(entry, target, this.env));
        // --push closes the last gap between this sweep and "a session can always be closed":
        // a clean worktree held back only because its commits live nowhere else. Publishing
        // the branch makes that false, so it reaps on the same "work exists elsewhere" rule
        // everything else does. Only ever applied to a `pushable` keep — never to a dirty
        // tree, a live session, or anything the judgement couldn't read.
        const willPush =
          verdict === "keep" && pushable === true && flags.push === true && entry.branch !== undefined;
        if (willPush && flags.dryRun) {
          reaped++;
          report.plan(`${name} → push ${entry.branch} to origin, then remove (${why})`);
          continue;
        }
        if (willPush) {
          if (
            await report.spin(`${name} (push)`, () =>
              pushBranch(entry.path, entry.branch as string, this.env),
            )
          ) {
            verdict = "reap";
            why = `pushed ${entry.branch} to origin`;
          } else {
            // A push can fail for reasons a sweep must not paper over (no remote, auth, a
            // diverged branch of the same name). Keeping is always the safe answer.
            report.warn(`${name} kept — ${why}; push failed`);
            kept++;
            continue;
          }
        }
        if (verdict !== "reap") {
          // --interactive turns the kept list into a work queue: the sweep has just proved it
          // can't clear this one, so ask. Only a "keep" is ever offered — a "skip" is a live
          // session or a repo we couldn't read, where the right answer is never a question.
          // Asking after the judgement (not before) is what lets the prompt state the stakes.
          if (flags.interactive && !flags.dryRun && verdict === "keep" && !stopAsking) {
            const choices: Choice<"push" | "delete" | "skip" | "quit">[] = [];
            if (pushable && entry.branch) choices.push({ key: "p", label: "push & remove", value: "push" });
            // The stakes of "delete" are larger inside a stack, and the label has to say so.
            // Deliberate non-change: deleteBranch still drops ONLY entry.branch — widening the
            // one destructive path to N branches is not this command's call. But once the
            // worktree is gone the siblings have no checkout, so linkedWorktrees can never
            // surface them again; the prompt is the only place a human learns that.
            // This path is now reachable only for a *dirty* stacked worktree: every clean
            // member resolves to reap or skip, and neither is ever prompted.
            const siblings = entry.stack?.branches.filter((b) => b.branch !== entry.branch) ?? [];
            choices.push({
              key: "d",
              label: entry.branch
                ? siblings.length > 0
                  ? `DELETE worktree + branch ${entry.branch} — orphans ${siblings.length} other stack branch(es) (${siblings.map(layerLabel).join(", ")}); loses these commits`
                  : `DELETE worktree + branch ${entry.branch} — loses these commits`
                : "DELETE worktree — loses these commits",
              value: "delete",
            });
            choices.push({ key: "s", label: "skip (keep it)", value: "skip" });
            choices.push({ key: "q", label: "stop asking", value: "quit" });
            const roster = entry.stack
              ? ` [${stackLabel(entry.stack)}: ${entry.stack.branches
                  .map((b) => (b.pullRequest ? `${b.branch} #${b.pullRequest.number}` : b.branch))
                  .join(" → ")}]`
              : "";
            const pick = choose(`${name} — ${why}${roster}`, choices, "skip");

            if (pick === "quit") stopAsking = true;
            else if (pick === "push" && entry.branch) {
              if (await pushBranch(entry.path, entry.branch, this.env)) {
                const gone = await removeWorktree(repo, entry.path, this.env, entry.lock !== undefined);
                if (gone.ok) {
                  reaped++;
                  report.ok(`${name} reaped — pushed ${entry.branch} to origin; branch kept`);
                  continue;
                }
                report.warn(`${name} pushed, but not removed — ${gone.error}`);
              } else report.warn(`${name} kept — ${why}; push failed`);
              kept++;
              continue;
            } else if (pick === "delete") {
              // Order matters: git refuses to delete a branch that is checked out in a
              // worktree, so the directory has to go first.
              const removed = await removeWorktree(repo, entry.path, this.env, entry.lock !== undefined);
              if (removed.ok) {
                const dropped = entry.branch ? await deleteBranch(repo, entry.branch, this.env) : true;
                deleted++;
                report.warn(
                  `${name} DELETED — ${entry.branch && dropped ? `branch ${entry.branch} deleted` : "worktree removed"}; ${why}`,
                );
                continue;
              }
              report.warn(`${name} not removed — ${removed.error}`);
              kept++;
              continue;
            }
          }
          kept++;
          // "keep" is the guard working as intended (real unmerged work); "skip" is a live
          // session or an unreadable tree. Neither is a problem, so neither is a warning.
          // The stack case comes first: `pushable` is now false for anything holding stack
          // state, so without this the old hint would simply vanish and the user would be
          // told nothing about why --push declined a clean, unpushed worktree.
          const hint = entry.stack
            ? stackHint(entry.stack, why)
            : pushable && !flags.push
              ? " (--push would publish and reap it)"
              : "";
          report.ok(`${name} kept — ${why}${hint}`);
          continue;
        }
        if (flags.dryRun) {
          reaped++;
          report.plan(`${name} → remove (${why})`);
          continue;
        }
        const removed = await removeWorktree(repo, entry.path, this.env, entry.lock !== undefined);
        if (removed.ok) {
          reaped++;
          const ref = entry.branch ? `branch ${entry.branch} kept` : "detached HEAD, commits kept";
          const stale = entry.lock !== undefined ? " (stale lock cleared)" : "";
          // The gh-stack file lives in the worktree's admin dir, so removal takes the branch
          // chain and its PR numbers with it. That is the one thing reap does which local
          // state cannot undo — say so, and say what restores it.
          const topology =
            entry.stack?.number !== undefined
              ? `; stack #${entry.stack.number} topology dropped with the directory (gh stack checkout ${entry.stack.number} re-attaches)`
              : "";
          report.ok(`${name} reaped — ${why}${stale}; ${ref}${topology}`);
        } else {
          kept++;
          report.warn(`${name} not removed — ${removed.error}`);
        }
      }
    }
    const verb = flags.dryRun ? "reapable" : "reaped";
    const summary = `${reaped} ${verb}, ${kept} kept${deleted > 0 ? `, ${deleted} deleted` : ""}`;
    // `meta` (not `ok`) is what the bands verdict prints on success — the counts are the
    // whole point of a sweep, so they belong on the verdict line rather than "all clear".
    report.finish({ ok: summary, meta: summary, warn: (w) => `${w} removal(s) failed` });
    // A removal failure stays a warning (finish maps that to exit 2): the sweep is a
    // courtesy and the next run retries, so nothing here should ever wedge a scheduled timer.
  },
});

export const codeRouteMap = buildRouteMap({
  routes: {
    init: initCommand,
    claude: claudeCommand,
    cmux: cmuxCommand,
    fetch: fetchCommand,
    reap: reapCommand,
  },
  // Bare `boom code` is the everyday entrypoint — go straight to the agent farm.
  defaultCommand: "claude",
  docs: { brief: "Open portals to your code workspaces (default: claude / cmux / fetch / reap)" },
});
