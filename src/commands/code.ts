// `botu code <init|claude|cmux>` — open portals to your code workspaces. A nested
// route map. claude/cmux crawl the code dir (leaf rule) and act per repo; both honor
// --dry-run (the tested path) and only spawn the backend tool when it's present.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildCommand, buildRouteMap } from "@stricli/core";
import type { BotuContext } from "../context.ts";
import { codeBreadcrumbPath, findRepos, resolveCodeDir } from "../engine/code.ts";
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

function backend(kind: "claude" | "cmux") {
  return buildCommand<{ dryRun?: boolean }, [], BotuContext>({
    docs: {
      brief: kind === "claude" ? "One idle `claude --bg` agent per repo" : "One cmux workspace per repo",
    },
    parameters: { flags: { dryRun: { kind: "boolean", optional: true, brief: "Plan only; spawn nothing" } } },
    async func(flags) {
      const root = await resolveCodeDir(this.env);
      if (!root) {
        this.process.stderr.write("botu code: no code dir — run: botu code init [DIR]\n");
        this.process.exitCode = 1;
        return;
      }
      const repos = await findRepos(root);
      this.process.stdout.write(`==> botu code ${kind}  (${root})\n`);
      const tool = kind === "claude" ? "claude" : "cmux";
      const live = !flags.dryRun && hasCommand(tool, this.env);
      for (const repo of repos) {
        const rel = repo.startsWith(`${root}/`) ? repo.slice(root.length + 1) : repo;
        if (!live) {
          const why = flags.dryRun ? "plan" : `${tool} not found`;
          this.process.stdout.write(
            `  • ${rel} → [${why}] ${kind === "claude" ? "claude --bg" : "cmux workspace"}\n`,
          );
          continue;
        }
        const argv = kind === "claude" ? ["claude", "--bg"] : ["cmux", "open", repo];
        await Bun.spawn(argv, { cwd: repo, env: cleanEnv(this.env), stdout: "inherit", stderr: "inherit" })
          .exited;
        this.process.stdout.write(`  • ${rel} → launched\n`);
      }
      this.process.stdout.write(`  ${repos.length} repo(s)\n`);
    },
  });
}

export const codeRouteMap = buildRouteMap({
  routes: { init: initCommand, claude: backend("claude"), cmux: backend("cmux") },
  docs: { brief: "Open portals to your code workspaces (claude / cmux)" },
});
