// `botu code <init|claude|cmux>` — open portals to your code workspaces. A nested
// route map. `claude` flattens every repo into a symlink farm and opens the agent
// view there; `cmux` opens one workspace per repo. Both honor --dry-run (the tested
// path) and only spawn the backend tool when it's present.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildCommand, buildRouteMap } from "@stricli/core";
import type { BotuContext } from "../context.ts";
import {
  agentsFarmDir,
  codeBreadcrumbPath,
  findRepos,
  materializeAgentsFarm,
  planAgentsFarm,
  resolveCodeDir,
} from "../engine/code.ts";
import { cleanEnv, hasCommand } from "../lib/proc.ts";

const initCommand = buildCommand<Record<never, never>, [string?], BotuContext>({
  docs: { brief: "Record the code dir (default ~/Code)" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ parse: (s: string) => s, optional: true, placeholder: "dir", brief: "code directory" }],
    },
  },
  async func(_flags, dir) {
    const target = dir ?? `${this.env.HOME ?? ""}/Code`;
    const crumb = codeBreadcrumbPath(this.env);
    await mkdir(dirname(crumb), { recursive: true });
    await writeFile(crumb, `${target}\n`);
    this.process.stdout.write(`botu: code dir recorded → ${target}\n`);
  },
});

const rel = (root: string, p: string) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);

// `botu code claude` — flatten ~/Code into a symlink farm and open `claude agents`
// there, so every repo is @-taggable for dispatch even with no running agents.
const claudeCommand = buildCommand<{ dryRun?: boolean }, [], BotuContext>({
  docs: { brief: "Symlink every repo into one dir and open `claude agents` there" },
  parameters: {
    flags: { dryRun: { kind: "boolean", optional: true, brief: "Plan only; touch nothing, spawn nothing" } },
  },
  async func(flags) {
    const root = await resolveCodeDir(this.env);
    if (!root) {
      this.process.stderr.write("botu code: no code dir — run: botu code init [DIR]\n");
      this.process.exitCode = 1;
      return;
    }
    const { links, collisions } = await planAgentsFarm(root);
    const farm = agentsFarmDir(this.env);
    this.process.stdout.write(`==> botu code claude  (${root} → ${farm})\n`);
    for (const { name, target } of links) this.process.stdout.write(`  • ${name} → ${rel(root, target)}\n`);
    for (const { name, target } of collisions)
      this.process.stdout.write(`  ! ${name} skipped (name already taken) → ${rel(root, target)}\n`);
    this.process.stdout.write(
      `  ${links.length} repo(s)${collisions.length ? `, ${collisions.length} collision(s)` : ""}\n`,
    );

    if (flags.dryRun) {
      this.process.stdout.write(`  [plan] would symlink the above into ${farm} and run: claude agents\n`);
      return;
    }
    await materializeAgentsFarm(this.env, links);
    if (!hasCommand("claude", this.env)) {
      this.process.stdout.write(`  farm ready — claude not found; run \`claude agents\` in ${farm}\n`);
      return;
    }
    await Bun.spawn(["claude", "agents"], {
      cwd: farm,
      env: cleanEnv(this.env),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).exited;
  },
});

// `botu code cmux` — one cmux workspace per repo.
const cmuxCommand = buildCommand<{ dryRun?: boolean }, [], BotuContext>({
  docs: { brief: "One cmux workspace per repo" },
  parameters: { flags: { dryRun: { kind: "boolean", optional: true, brief: "Plan only; spawn nothing" } } },
  async func(flags) {
    const root = await resolveCodeDir(this.env);
    if (!root) {
      this.process.stderr.write("botu code: no code dir — run: botu code init [DIR]\n");
      this.process.exitCode = 1;
      return;
    }
    const repos = await findRepos(root);
    this.process.stdout.write(`==> botu code cmux  (${root})\n`);
    const live = !flags.dryRun && hasCommand("cmux", this.env);
    for (const repo of repos) {
      if (!live) {
        const why = flags.dryRun ? "plan" : "cmux not found";
        this.process.stdout.write(`  • ${rel(root, repo)} → [${why}] cmux workspace\n`);
        continue;
      }
      await Bun.spawn(["cmux", "open", repo], {
        cwd: repo,
        env: cleanEnv(this.env),
        stdout: "inherit",
        stderr: "inherit",
      }).exited;
      this.process.stdout.write(`  • ${rel(root, repo)} → launched\n`);
    }
    this.process.stdout.write(`  ${repos.length} repo(s)\n`);
  },
});

export const codeRouteMap = buildRouteMap({
  routes: { init: initCommand, claude: claudeCommand, cmux: cmuxCommand },
  docs: { brief: "Open portals to your code workspaces (claude / cmux)" },
});
