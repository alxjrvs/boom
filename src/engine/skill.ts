// The self-describing Claude Code SKILL.md: where it installs, how it renders, and whether the
// installed copy is current. The *command reference* is generated from the catalog so it can
// never document a command that doesn't exist; the guidance around it is hand-written. The
// three consumers — `boom skill --install`, `boom doctor`, `[boom] skill_on_sync` — all read
// `skillState` and write through `installSkill`, so there is one spelling of the install.
//
// It lives in `engine/` rather than `commands/` because the engine is the busier consumer.
//
// DECISION + GOTCHA: `engine/skill` → `commands/catalog` → `cli` → `commands/skill` →
// `engine/skill` is a require cycle, entered from the engine. Entering through this file,
// `commands/skill.ts` is reached *from* `cli.ts` and finishes initializing before the route
// map reads it; entering through `commands/skill.ts` itself crashes with `Cannot access
// 'skillCommand' before initialization`, and nothing needs to fix that — `cli.ts` is the
// production entry. The exports below MUST stay `export function` declarations, not `const`
// arrows: function declarations are hoisted and initialized before any module body runs, so a
// partially-evaluated `engine/skill.ts` still hands a mid-cycle consumer a live `skillDoc`. No
// consumer reads them at module-evaluation time *today*, so nothing fails the moment you
// convert them — which is exactly why it is written down here. The same applies to
// `catalog.ts` reading `routes` lazily; hoisting that to a top-level const closes the cycle at
// evaluation time and the crash returns. `test/layering.test.ts` pins the engine-entry
// direction in a subprocess.
import { join } from "node:path";
import { commandList } from "../commands/catalog.ts";
import { pathExists } from "../lib/fs.ts";
import type { Env } from "../lib/paths.ts";
import { VERSION } from "../lib/version.ts";

// Where Claude Code keeps user skills: $CLAUDE_CONFIG_DIR (if the user relocated ~/.claude),
// else ~/.claude. Returns undefined only when neither HOME nor CLAUDE_CONFIG_DIR is set.
export function skillInstallPath(env: Env): string | undefined {
  const configDir = env.CLAUDE_CONFIG_DIR ?? (env.HOME ? join(env.HOME, ".claude") : undefined);
  return configDir ? join(configDir, "skills", "boom", "SKILL.md") : undefined;
}

// The installed skill measured against what this binary would render: the path, the rendered
// doc, and whether the on-disk copy is `current`, `stale`, or `missing`. Undefined when the
// install path cannot be resolved (no HOME / CLAUDE_CONFIG_DIR).
export interface SkillState {
  readonly file: string;
  readonly doc: string;
  readonly status: "current" | "stale" | "missing";
}

// The one human wording for a status, so `boom doctor` and `[boom] skill_on_sync` cannot drift.
export function skillStatusLabel(status: SkillState["status"]): string {
  return status === "missing" ? "not installed" : status;
}

export async function skillState(env: Env): Promise<SkillState | undefined> {
  const file = skillInstallPath(env);
  if (!file) return undefined;
  const doc = skillDoc(VERSION);
  if (!(await pathExists(file))) return { file, doc, status: "missing" };
  return { file, doc, status: (await Bun.file(file).text()) === doc ? "current" : "stale" };
}

// Write the rendered doc into place. Takes only the file + doc, so an unconditional install
// (`boom skill --install`) need not read the existing copy first. `Bun.write` creates the parent
// directory itself; a parent that exists as a regular file makes it throw, which is the failure
// the journaling caller (engine/settings.ts) deliberately records its undo ahead of.
export async function installSkill(target: Pick<SkillState, "file" | "doc">): Promise<void> {
  await Bun.write(target.file, target.doc);
}

export function skillDoc(version: string): string {
  const commands = commandList()
    .map((c) => `- \`boom ${c.name}\` — ${c.brief}`)
    .join("\n");
  return `---
name: boom
description: >-
  Drive boom, declarative dev-machine setup (dotfiles, packages, tools) that converges a machine
  from a declarative boomfile.toml in a git-remote config repo. Use when bootstrapping
  or updating a machine's dotfiles, checking for configuration drift, or pointing boom at a
  different config repo.
---

# boom (v${version})

boom reconciles your machine from a declarative \`boomfile.toml\` that lives in a
git-remote **config repo** (the *source*). It symlinks/copies dotfiles, installs
packages, runs steps and hooks, and tears down what it made on \`uninstall\`.

## Mental model

- **One config source.** \`boom source set <owner/repo>\` clones the repo into a managed
  cache dir, records it, and syncs it. That is also the fresh-machine bootstrap.
- **The reconcile loop is one verb over one registry.** \`source\` (the sync verb),
  \`verify\`, and \`uninstall\` walk the same resources; only the verb changes. Drift repair
  is not a separate verb — it's \`boom source --fix\` (sync, but overwriting conflicts).
- **One canonical name per command — there are no aliases.**

## Commands

${commands}

\`boom source\` reconciles your machine; \`boom source set owner/repo\` points it at a config
repo. Run \`boom <command> --help\` for flags.

## Driving it safely

- **Check before changing.** \`boom verify\` exits **0** ok / **2** warnings / **1**
  failures — gate on it. \`boom source --dry-run\` previews every change and touches nothing.
- **Machine-readable output.** \`--json\` on \`source\`/\`verify\` emits a structured
  report (with a \`schemaVersion\`); parse that instead of scraping stdout.
- **Scope a run** with \`--only <section>\` (repeatable) and \`--profile <name>\`.
- **Destructive commands to use with care:** \`boom source set\` re-clones the managed config
  repo and refuses to run while that clone has uncommitted or unpushed work. \`boom uninstall\`
  removes what boom installed; it *is* journaled, so a file it overwrites is displaced into
  \`backups/<run-id>/\` rather than destroyed. There is no undo verb, so putting one back is
  a manual copy out of that tree.
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
