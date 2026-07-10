// `botu skill` — emit a Claude Code SKILL.md so an agent can drive botu correctly. Prints
// to stdout by default; `--install` writes it to <claude-config>/skills/botu/SKILL.md.
// Like `botu man` and `botu completions`, the command reference is generated from the
// catalog so it can never document a command that doesn't exist; the guidance is hand-written.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCommand } from "@stricli/core";
import type { BotuContext } from "../context.ts";
import { VERSION } from "../lib/version.ts";
import { COMMANDS } from "./catalog.ts";

// Where Claude Code keeps user skills: $CLAUDE_CONFIG_DIR (if the user relocated ~/.claude),
// else ~/.claude. Returns undefined only when neither HOME nor CLAUDE_CONFIG_DIR is set.
function skillInstallPath(env: Record<string, string | undefined>): string | undefined {
  const configDir = env.CLAUDE_CONFIG_DIR ?? (env.HOME ? join(env.HOME, ".claude") : undefined);
  return configDir ? join(configDir, "skills", "botu", "SKILL.md") : undefined;
}

export function skillDoc(version: string): string {
  const commands = COMMANDS.map((c) => `- \`botu ${c.name}\` — ${c.brief}`).join("\n");
  return `---
name: botu
description: >-
  Drive botu, an installable dotfiles + workspace engine that reconciles a machine
  from a declarative botufile.toml in a git-remote config repo. Use when bootstrapping
  or updating a machine's dotfiles, checking for configuration drift, operating the
  managed config repo (diff/commit/push/reset), or rolling back a botu change.
---

# botu (v${version})

botu reconciles your machine from a declarative \`botufile.toml\` that lives in a
git-remote **config repo** (the *source*). It symlinks/copies dotfiles, installs
packages, runs steps and hooks, and can undo any change.

## Mental model

- **One config source.** \`botu source set <owner/repo>\` clones the repo into a managed
  cache dir, records it, and applies it. That is also the fresh-machine bootstrap.
- **The reconcile loop is one verb over one registry.** \`apply\`, \`verify\`, \`repair\`,
  and \`uninstall\` walk the same resources; only the verb changes.
- **One canonical name per command — there are no aliases.**

## Commands

${commands}

\`source\` and \`code\` are namespaces: \`botu source <set|diff|commit|push|reset>\`,
\`botu code <init|claude|cmux>\`. Run \`botu <command> --help\` for flags.

## Driving it safely

- **Check before changing.** \`botu verify\` exits **0** ok / **2** warnings / **1**
  failures — gate on it. \`botu apply --dry-run\` previews every change and touches nothing.
- **Machine-readable output.** \`--json\` on \`apply\`/\`verify\`/\`repair\` emits a structured
  report (with a \`schemaVersion\`); parse that instead of scraping stdout.
- **Scope a run** with \`--only <section>\` (repeatable) and \`--profile <name>\`.
- **Destructive commands to use with care:** \`botu source reset --force\` discards local
  commits no remote has; \`botu uninstall\` removes everything botu installed. Both are
  reversible only via \`botu rollback\` (which replays the last apply's journal).
- **Conflicts** at a link destination are overwritten by default; \`apply --skip\` opts out.

## Bootstrapping a fresh machine

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/alxjrvs/botu/main/install.sh | sh
botu source set owner/repo          # clone + record + apply
botu source set owner/repo --no-apply   # …or clone + record only
\`\`\`
`;
}

export const skillCommand = buildCommand<{ install?: boolean }, [], BotuContext>({
  docs: { brief: "Emit a Claude Code SKILL.md for driving botu (agentic use)" },
  parameters: {
    flags: {
      install: {
        kind: "boolean",
        optional: true,
        brief: "Write it to <claude-config>/skills/botu/SKILL.md instead of stdout",
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
        "botu: can't resolve the Claude config dir — set HOME or CLAUDE_CONFIG_DIR\n",
      );
      this.process.exitCode = 1;
      return;
    }
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, doc);
    this.process.stdout.write(`botu: installed skill → ${file}\n`);
  },
});
