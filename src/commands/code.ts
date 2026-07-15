// `boom code <init|claude|cmux>` — open portals to your code workspaces. A nested
// route map. `claude` flattens every repo into a symlink farm and opens the agent
// view there; `cmux` opens one workspace per repo. Both honor --dry-run (the tested
// path) and only spawn the backend tool when it's present.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
import { cleanEnv, hasCommand, runArgv } from "../lib/proc.ts";
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
      // narrating; --prune drops refs deleted upstream so stale branches don't accumulate.
      const { code } = runArgv(["git", "fetch", "--quiet", "--prune", "--no-tags"], this.env, {
        cwd: repo,
        quietStdout: true,
      });
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

export const codeRouteMap = buildRouteMap({
  routes: { init: initCommand, claude: claudeCommand, cmux: cmuxCommand, fetch: fetchCommand },
  // Bare `boom code` is the everyday entrypoint — go straight to the agent farm.
  defaultCommand: "claude",
  docs: { brief: "Open portals to your code workspaces (default: claude / cmux / fetch)" },
});
