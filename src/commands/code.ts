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
  resolveCodeDir,
} from "../engine/code.ts";
import {
  defaultRemoteRef,
  deleteBranch,
  judge,
  linkedWorktrees,
  pushBranch,
  removeWorktree,
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
    const root = await resolveCodeDir(this.env);
    if (!root) {
      this.process.stderr.write("boom code: no code dir — run: boom code init [DIR]\n");
      this.process.exitCode = 1;
      return;
    }
    const { links, collisions } = await planAgentsFarm(root);
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
    const root = await resolveCodeDir(this.env);
    if (!root) {
      this.process.stderr.write("boom code: no code dir — run: boom code init [DIR]\n");
      this.process.exitCode = 1;
      return;
    }
    const repos = await findRepos(root);
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
    const root = await resolveCodeDir(this.env);
    if (!root) {
      this.process.stderr.write("boom code: no code dir — run: boom code init [DIR]\n");
      this.process.exitCode = 1;
      return;
    }
    const repos = await findRepos(root);
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
    const root = await resolveCodeDir(this.env);
    if (!root) {
      this.process.stderr.write("boom code: no code dir — run: boom code init [DIR]\n");
      this.process.exitCode = 1;
      return;
    }
    const repos = await findRepos(root);
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
          const pushed = await report.spin(`${name} (push)`, () =>
            pushBranch(entry.path, entry.branch as string, this.env, entry.head),
          );
          if (pushed.ok) {
            verdict = "reap";
            // An archived push says so: the branch's own name was taken by diverged history,
            // so the commits live under a ref the sweep invented, and that is worth reading
            // in the log rather than inferring later from a stray remote branch.
            why = pushed.archived
              ? `${entry.branch} diverged from origin — commits parked at origin/${pushed.ref}`
              : `pushed ${entry.branch} to origin`;
          } else {
            // What is left is a push that could not be rescued under any name (no remote,
            // auth). Keeping is the safe answer — but say why, or the next run's identical
            // failure is indistinguishable from the last one's.
            report.warn(`${name} kept — ${why}; push failed: ${pushed.error}`);
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
            choices.push({
              key: "d",
              label: entry.branch
                ? `DELETE worktree + branch ${entry.branch} — loses these commits`
                : "DELETE worktree — loses these commits",
              value: "delete",
            });
            choices.push({ key: "s", label: "skip (keep it)", value: "skip" });
            choices.push({ key: "q", label: "stop asking", value: "quit" });
            const pick = choose(`${name} — ${why}`, choices, "skip");

            if (pick === "quit") stopAsking = true;
            else if (pick === "push" && entry.branch) {
              const pushed = await pushBranch(entry.path, entry.branch, this.env, entry.head);
              if (pushed.ok) {
                const gone = await removeWorktree(repo, entry.path, this.env, entry.lock !== undefined);
                if (gone.ok) {
                  reaped++;
                  const where = pushed.archived
                    ? `${entry.branch} diverged from origin — commits parked at origin/${pushed.ref}`
                    : `pushed ${entry.branch} to origin`;
                  report.ok(`${name} reaped — ${where}; branch kept`);
                  continue;
                }
                report.warn(`${name} pushed, but not removed — ${gone.error}`);
              } else report.warn(`${name} kept — ${why}; push failed: ${pushed.error}`);
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
          const hint = pushable && !flags.push ? " (--push would publish and reap it)" : "";
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
          report.ok(`${name} reaped — ${why}${stale}; ${ref}`);
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
