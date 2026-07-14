// `boom skill` — emit a Claude Code SKILL.md so an agent can drive boom correctly. Prints
// to stdout by default; `--install` writes it to <claude-config>/skills/boom/SKILL.md.
// Like `boom man` and `boom completions`, the command reference is generated from the
// catalog so it can never document a command that doesn't exist; the guidance is hand-written.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { VERSION } from "../lib/version.ts";
import { commandList } from "./catalog.ts";

// Where Claude Code keeps user skills: $CLAUDE_CONFIG_DIR (if the user relocated ~/.claude),
// else ~/.claude. Returns undefined only when neither HOME nor CLAUDE_CONFIG_DIR is set.
function skillInstallPath(env: Record<string, string | undefined>): string | undefined {
  const configDir = env.CLAUDE_CONFIG_DIR ?? (env.HOME ? join(env.HOME, ".claude") : undefined);
  return configDir ? join(configDir, "skills", "boom", "SKILL.md") : undefined;
}

export function skillDoc(version: string): string {
  const commands = commandList()
    .map((c) => `- \`boom ${c.name}\` — ${c.brief}`)
    .join("\n");
  return `---
name: boom
description: >-
  Drive boom, a declarative machine reconciler (dotfiles, packages, tools) that converges a machine
  from a declarative boomfile.toml in a git-remote config repo. Use when bootstrapping
  or updating a machine's dotfiles, checking for configuration drift, operating the
  managed config repo (diff/commit/push/reset), or rolling back a boom change.
---

# boom (v${version})

boom reconciles your machine from a declarative \`boomfile.toml\` that lives in a
git-remote **config repo** (the *source*). It symlinks/copies dotfiles, installs
packages, runs steps and hooks, and can undo any change.

## Mental model

- **One config source.** \`boom source set <owner/repo>\` clones the repo into a managed
  cache dir, records it, and syncs it. That is also the fresh-machine bootstrap.
- **The reconcile loop is one verb over one registry.** \`source\` (the sync verb),
  \`verify\`, and \`uninstall\` walk the same resources; only the verb changes. Drift repair
  is not a separate verb — it's \`boom source --fix\` (sync, but overwriting conflicts).
- **One canonical name per command — there are no aliases.**

## Commands

${commands}

\`boom source\` reconciles your machine; its subcommands \`set|diff|push|reset\` operate the
config repo. \`code\` is a namespace: \`boom code <init|claude|cmux>\`. Run
\`boom <command> --help\` for flags.

## Driving it safely

- **Check before changing.** \`boom verify\` exits **0** ok / **2** warnings / **1**
  failures — gate on it. \`boom source --dry-run\` previews every change and touches nothing.
- **Machine-readable output.** \`--json\` on \`source\`/\`verify\` emits a structured
  report (with a \`schemaVersion\`); parse that instead of scraping stdout.
- **Scope a run** with \`--only <section>\` (repeatable) and \`--profile <name>\`.
- **Destructive commands to use with care:** \`boom source reset --force\` discards local
  commits no remote has; \`boom uninstall\` removes everything boom installed. Both are
  reversible only via \`boom rollback\` (which replays the last sync's journal).
- **Conflicts** at a link destination are skipped by default (boom never clobbers a file it
  doesn't own); \`boom source --fix\` overwrites them to repair drift.

## Bootstrapping a fresh machine

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/alxjrvs/boom/main/install.sh | sh
boom source set owner/repo          # clone + record + sync
boom source set owner/repo --no-sync    # …or clone + record only
\`\`\`
`;
}

export const skillCommand = buildCommand<{ install?: boolean }, [], BoomContext>({
  docs: { brief: "Emit a Claude Code SKILL.md for driving boom (agentic use)" },
  parameters: {
    flags: {
      install: {
        kind: "boolean",
        optional: true,
        brief: "Write it to <claude-config>/skills/boom/SKILL.md instead of stdout",
      },
    },
  },
  async func(flags) {
    const doc = skillDoc(VERSION);
    if (!flags.install) {
      this.process.stdout.write(doc);
      return;
    }
    const file = skillInstallPath(this.env);
    if (!file) {
      this.process.stderr.write(
        "boom: can't resolve the Claude config dir — set HOME or CLAUDE_CONFIG_DIR\n",
      );
      this.process.exitCode = 1;
      return;
    }
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, doc);
    this.process.stdout.write(`boom: installed skill → ${file}\n`);
  },
});
