# Prompt: migrate a bash `botufile` to `botufile.toml`

Hand this prompt to an agent (Claude Code) pointed at a dotfiles repo that still
uses the legacy bash `botufile`. It produces a `botufile.toml` matching botu's
TypeScript schema, and converts bash hooks to TypeScript resource modules — the
parts `botu migrate` (the mechanical converter) can't fully handle.

> Run `botu migrate <repo>` first for the mechanical 1:1 conversion (links,
> copies, globs, brewfile, mise, `on` steps, hook references). Then use this
> prompt to (a) review the result, (b) port hook **files**, and (c) add host/OS
> profiles. The prompt assumes the mechanical pass already produced a draft.

---

## Your task

Convert the bash dotfiles configuration in this repo to botu's `botufile.toml`
format and TypeScript hooks. Preserve behavior exactly.

### 1. The target schema (`botufile.toml`, nested-by-section)

```toml
[[section]]
name = "Shell + git"                 # required
when = { os = "darwin" }             # optional gate: os ("darwin"|"linux"), host, profile
link = [{ src = ".zshrc", dst = "~/.zshrc", mode = "600" }]   # mode optional (octal string)
copy = [{ src = "bin/tool", dst = "~/.local/bin/tool", mode = "755" }]
glob = [{ pattern = "zsh/[0-9]*.zsh", into = "~/.config/zsh/" }]
brewfile = "Brewfile"                # one per section
mise = true                          # run `mise install`
run  = [{ on = "apply", cmd = "lefthook install" }]   # on = "apply" | "verify"
hook = [{ name = "claude_statusline", with = { repo = "github.com/alxjrvs/claude-statusline" } }]
```

Phase order within a section is fixed: `link → copy → glob → packages → run →
hook`. Source order between those categories does not matter; if a `run` step
must happen after a specific link, keep them in the same section (the order is
guaranteed by phase).

### 2. Mapping rules (bash DSL → TOML)

| Bash line | TOML |
|-----------|------|
| `section "Name"` | a new `[[section]]` with `name = "Name"` |
| `link SRC DST` / `link --mode M SRC DST` | a `link` entry `{ src, dst, mode? }` |
| `copy SRC DST` / `copy --mode M …` | a `copy` entry |
| `glob 'PAT' DIR` | a `glob` entry `{ pattern, into }` |
| `brewfile FILE` | `brewfile = "FILE"` on the section |
| `mise_install` | `mise = true` |
| `on apply CMD` / `on verify CMD` | a `run` entry `{ on, cmd = "CMD" }` |
| `hook NAME k=v …` | a `hook` entry `{ name, with = { k = "v" } }` |

`~` in `dst` stays literal (the engine expands it). `src` is repo-relative.

### 3. Port hook **files**: `hooks/NAME.sh` → `hooks/NAME.ts`

The bash hook contract (`_NAME_apply` / `_NAME_verify` / `_NAME_fix`, reading
`$BOTU_<key>`) becomes a TypeScript module exporting verb functions that receive
a typed API:

```ts
// hooks/claude_statusline.ts
import type { HookApi } from "botu";   // { with, verb, dryRun, env, ok, warn, fail, note }

export async function apply(api: HookApi) {
  const repo = api.with.repo;          // was $BOTU_repo
  if (api.dryRun) { api.note(`would install from ${repo}`); return; }
  // ...port the imperative logic here (use Bun.$ / Bun.spawnSync for shell)...
  api.ok(`installed ${repo}`);
}

export async function verify(api: HookApi) { /* ... */ }
// fix falls back to apply if omitted.
```

Translate shell hook bodies to TypeScript: prefer `Bun.$` for pipelines and
`Bun.spawnSync` when you need an exit code. Read inputs from `api.with`, honor
`api.dryRun`, and report via `api.ok/warn/fail` (never `console.log`) so the hook
participates in the engine's tally and exit code.

### 4. Host/OS profiles

If the bash config branched on OS or hostname (e.g. `if [[ $(uname) == Darwin ]]`),
express it with `when = { os = "darwin" }` on the relevant sections, or split the
machine-specific parts into overlay files `botufile.darwin.toml`,
`botufile.<hostname>.toml`, or `botufile.<profile>.toml` (the latter activated by
`botu apply --profile <name>`).

### 5. Verify the result

- `botu verify --json` against the new config parses and reports no unexpected
  drift.
- Diff the set of `dst` paths against the bash version — every target the old
  config managed must be present.
- For each ported hook, confirm `apply` then `verify` behave as before in a
  throwaway `$HOME`.

Output the final `botufile.toml`, the new `hooks/*.ts`, and a short list of
anything you could not translate mechanically (for human review).
