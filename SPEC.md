# BoomTube — design spec

**BoomTube** is an **installable dotfiles + workspace engine**: a single
self-contained binary (executable: **`botu`**), compiled from **TypeScript on
Bun**, that reconciles a machine from a declarative `botufile.toml` and opens
portals to code workspaces. Named for Kirby's **Boom Tube** — it opens portals to
your machine's ideal state, and to your code.

It began as a bash prototype (extracted from `alxjrvs/dotFiles`) and was rewritten
to TypeScript; this document is the design of record for that engine.

## The model (decided — don't relitigate)

A `botu` invocation does one of two things:

1. **Reconcile verbs** over a config repo's `botufile.toml`:
   - `botu apply`  — make it so (`--upgrade` also upgrades outdated brewfile formulae)
   - `botu verify` — check drift, exit 0 ok / 2 warn / 1 fail (`--json` for a report)
   - `botu repair` — repair drift (apply, overwriting conflicts)
   - `botu uninstall`
   These share **one verb-parameterized loop** (`src/engine/reconcile.ts`) over a
   resource-type registry — siblings, not separate scripts. `botu rollback` undoes
   the most recent apply; `apply --resume` continues an interrupted one. A
   conflicting (non-botu-owned) file at a `link` destination is **overwritten by
   default**; `apply --skip` opts out instead. There are no command aliases — one
   canonical name per verb.

   `apply`/`repair` (never `verify`/`uninstall`) also sync the config repo's own git
   state against its remote first (`src/engine/sync.ts`): by default `pull --rebase
   --autostash`s, so any uncommitted local edits ride along and land back on top;
   `apply --commit` commits local edits first instead of autostashing them, so
   they replay as a real commit on the rebase. `botu source commit` commits local
   config-repo changes standalone (`src/engine/commit.ts`), sharing its commit logic with
   `apply --commit` so the default message/behavior can't drift between the two.

2. **Discovered subcommands** — built-ins are the `@stricli` route map (`source`,
   `code`, `mcp`, `where`, `rollback`, `upgrade`, `validate`, `doctor`, `completions`,
   `man`); user commands resolve at runtime from `<config>/commands/<name>.ts`. Adding
   a tool never edits a dispatch table. The command names live once in
   `src/commands/catalog.ts`, which also drives the dispatch guard, shell
   completions, and the man page.

### Config source is a git remote (repo-only)

`botu source set` takes a remote reference — `owner/repo`, `github:owner/repo`,
a full git URL, optionally `@ref` — never an arbitrary local path. Botu clones it into
a managed cache dir (`configRepoCacheDir`, under the state dir) and records the
breadcrumb (`{ path, remote: { url, ref? } }`), then applies immediately — the
one-command fresh-machine bootstrap is `curl install.sh | sh && botu source set
owner/repo`, no repo-relative bootstrap script needed. `--no-apply` records only (review
first, or re-point at a different repo without reconciling).

Sync is a pre-reconcile step (`src/engine/sync.ts`), not a resource: `verify` fetches
and reports drift without touching the working tree — "N commits behind origin",
plus separate warnings for uncommitted local changes and committed-but-unpushed local
commits, since a clean behind-count alone would otherwise read as "up to date" while
either kind of local drift sits unreported; `apply`/`repair` pull first and report what
moved, then reconcile proceeds against whatever's on disk either way — a failed pull
(including a `git rev-list` failure while checking drift) is reported as a failure but
never blocks reconciling from the last-known-good local clone. The pull is `git pull
--rebase --autostash` (git stashes any dirty tracked changes before rebasing and
restores them after, including automatically on an aborted rebase); `apply --commit`
commits local edits first instead of autostashing them (`src/engine/commit.ts`, shared
with `botu source commit`). A rebase conflict aborts cleanly (`git rebase --abort`, which also
restores the autostash) and is reported as a failure, but reconcile still proceeds
from the local state as it was before the rebase attempt. A pinned `@ref` (tag/sha,
detached HEAD) is reported as static rather than checked for drift. Auth is whatever
git/SSH already works in the user's shell — no botu-side credential handling. The
config-repo git verbs live under one namespace: `botu source push` pushes the managed
clone's local commits upstream (no auto-commit); `botu source reset` is the other
direction — fetches, then hard-resets to the upstream tip (or the pinned `@ref` for a
detached clone) and clears untracked files, discarding local changes back to what a
fresh re-clone would leave. Like `linkRemoteConfigRepo`, `botu source reset` refuses to
discard commits no remote has (listing them) unless `--force` is passed — uncommitted
changes alone don't need `--force`, only unpushed commits do. `linkRemoteConfigRepo`
itself refuses to wipe a managed clone that has either uncommitted changes or commits
not yet pushed (checked separately — `git status --porcelain` never reports
ahead-of-upstream) — `botu source push` or `botu source reset` first, then re-link.

### Config is typed TOML, not code

`botufile.toml` is a TOML document validated against a schema (`src/config/schema.ts`,
valibot). It is grouped into `[[section]]`s; within a section, resources run in a
fixed phase order: `link → copy → glob → packages (brewfile/mise) → run → hook`.
Resources:

- `link` / `copy` `{ src, dst, mode? }`, `glob { pattern, into }`
- `brewfile = "FILE"`, `mise = true`
- `run = [{ on = "apply"|"verify", cmd }]` — the inline imperative escape
- `hook = [{ name, with? }]` — load `hooks/<name>.ts`, the TS resource-type extension

A section may carry `when = { os, host, profile }` to gate by machine; overlay
files `botufile.<os|host|profile>.toml` are merged onto the base. `--profile`
(repeatable) activates named profiles; os/host auto-match (overridable via
`BOTU_OS`/`BOTU_HOST`).

### Hooks = the resource-type extension contract

`hooks/<name>.ts` default-exports (or names) `apply`/`verify`/`repair`/`uninstall`
functions receiving a `HookApi`: `{ with, verb, dryRun, env, ok, warn, fail, note }`.
Loaded by runtime `import()` (works inside the compiled binary). This replaces the
bash `_NAME_<verb>` hooks and is the public extension point.

### Transaction + state

Mutating runs open a journal under `${XDG_STATE_HOME:-~/.local/state}/botu/journal/`
(NDJSON, intent/done + undo token, committed marker) and **back up** any displaced
file under `…/backups/<run-id>/`. `botu rollback` replays the journal in reverse
(remove created links, restore backups). A `manifest` of owned destinations drives
orphan reaping (verify warns; apply/fix reap). Breadcrumbs (`config`, `code`) record
the dotfiles repo (path + remote) and code dir.

## Stack

| Concern | Choice |
|---------|--------|
| CLI | `@stricli/core` — the only framework that compiles cleanly under `bun build --compile` |
| Config | TOML via `smol-toml`, validated by `valibot` |
| Shell / process | `Bun.$` / `Bun.spawnSync`; `node:fs/promises` for symlink/copy/mode |
| Output | `Bun.color` palette + a tally Reporter (drives exit codes) |
| Quality gates | Biome (lint + format), `tsc --noEmit`, `bun test` |
| Distribution | `bun build --compile` matrix (macOS arm64/x64, Linux x64) |

## Layout

```
src/
  cli.ts · index.ts        @stricli app + entrypoint (dispatch: mcp, user cmds, built-ins)
  commands/                init, link, apply/verify/repair/uninstall (reconcile.ts), source
                           (diff/commit/push/reset route map), where, rollback, upgrade,
                           validate, doctor, code, mcp, completions, man
                           catalog.ts (command names: dispatch guard + completions + man)
  engine/
    reconcile.ts           the one verb loop
    sync.ts                pre-reconcile config-repo fetch/pull(--rebase --autostash)-and-report
    commit.ts              commit local config-repo changes (shared by `botu source commit` + apply --commit)
    diff.ts                botu source diff (read-only: working-tree diff vs HEAD + untracked)
    push.ts reset.ts       botu source push / botu source reset
    registry.ts            per-section phase dispatch
    resources/             link · copy · glob · packages · run · hook
    journal.ts state.ts    transaction + on-disk state
    rollback.ts code.ts discovery.ts
  config/  schema.ts load.ts remote.ts migrate.ts profile.ts
  lib/     reporter.ts color.ts fs.ts proc.ts git.ts version.ts
test/                       bun test (unit + sandboxed integration)
examples/dotfiles/          a runnable botufile.toml example
.github/workflows/          ci.yml (check + cross-compile smoke), release.yml (tag → matrix → attach)
```

## Distribution

`install.sh` downloads the matching binary from the GitHub release; `Formula/botu.rb`
installs it via Homebrew (the repo doubles as the tap). `release.yml` cross-compiles the
matrix on Linux, then **signs the macOS binaries on a real macOS runner** before
assembling the release and computing checksums over the final binaries. Signing is
ad-hoc by default (valid on Apple Silicon); add the `MACOS_*`/`APPLE_*` repo secrets to
switch on Developer ID signing + notarization (see the header of `release.yml`).
`install.sh`/`botu upgrade` only re-sign ad-hoc when a download fails verification, so a
notarized binary is never clobbered.
