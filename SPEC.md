# BoomTube — design spec

**BoomTube** is a **declarative machine reconciler**: a single self-contained binary
(executable: **`boom`**), compiled from **TypeScript on Bun**, that converges a
machine to a declared state — dotfiles, packages, and tools from one
`boomfile.toml`, with drift detection and rollback — then opens portals to your code.
Named for Kirby's **Boom Tube** — the Fourth World's instant conduit between worlds —
it opens a portal to your machine's ideal state, and to your code.

It began as a bash prototype (extracted from `alxjrvs/dotFiles`) and was rewritten
to TypeScript; this document is the design of record for that engine.

## The model (decided — don't relitigate)

A `boom` invocation does one of two things:

1. **Reconcile verbs** over a config repo's `boomfile.toml` — the `sync` verb runs on
   the bare `boom source` command (and its explicit `boom source sync` spelling); the
   rest are their own top-level commands:
   - `boom source` / `boom source sync` — reconcile the machine to the boomfile, running the `sync` verb (`--fix` repairs drift by overwriting conflicts; `--update` also updates outdated brewfile formulae)
   - `boom verify` — check drift, exit 0 ok / 2 warn / 1 fail (`--json` for a report)
   - `boom uninstall`
   These share **one verb-parameterized loop** (`src/engine/reconcile.ts`) over a
   resource-type registry — siblings, not separate scripts. `boom rollback` undoes
   the most recent sync (`--run-id` targets an older one, `--list` enumerates them);
   `source --resume` continues an interrupted one. A
   conflicting (non-boom-owned) file at a `link` destination is **skipped by
   default** (boom never clobbers a file it doesn't own); `source --fix` opts into
   overwriting it — that's how drift is repaired, so there's no separate `fix` verb.
   `sync` is the one canonical reconcile name; bare `boom source` is its shorthand
   (the namespace's default command), not a separate alias.

   The `sync` verb (never `verify`/`uninstall`) also syncs the config repo's own git
   state against its remote first (`src/engine/sync.ts`): by default `pull --rebase
   --autostash`s, so any uncommitted local edits ride along and land back on top;
   `source --commit` commits local edits first instead of autostashing them, so
   they replay as a real commit on the rebase. `boom source push` commits local
   config-repo changes and pushes them (`src/engine/commit.ts`), sharing its commit logic with
   `source --commit` so the default message/behavior can't drift between the two.

2. **Discovered subcommands** — built-ins are the `@stricli` route map (`source`,
   `code`, `mcp`, `where`, `rollback`, `upgrade`, `doctor`, `completions`,
   `man`, `skill`); user commands resolve at runtime from `<config>/commands/<name>.ts`.
   The route map is the **single registry, with no hardcoded dispatch anywhere**: `mcp`
   is an ordinary route (its `-- <server args>` ride through verbatim via the scanner's
   argument-escape sequence, so it needs no pre-Stricli passthrough), and `index.ts`
   decides built-in-vs-discovered by asking the route map itself
   (`getRoutingTargetForInput`). `src/commands/catalog.ts` *derives* command names +
   briefs from that same route map for shell completions, the man page, and `boom skill`
   — one source of truth, no parallel table to keep in sync.

### Config source is a git remote (repo-only)

`boom source set` takes a remote reference — `owner/repo`, `github:owner/repo`,
a full git URL, optionally `@ref` — never an arbitrary local path. Boom clones it into
a managed cache dir (`configRepoCacheDir`, under the state dir) and records the
breadcrumb (`{ path, remote: { url, ref? } }`), then syncs immediately — the
one-command fresh-machine bootstrap is `curl install.sh | sh && boom source set
owner/repo`, no repo-relative bootstrap script needed. `--no-sync` records only (review
first, or re-point at a different repo without reconciling).

Sync is a pre-reconcile step (`src/engine/sync.ts`), not a resource: `verify` fetches
and reports drift without touching the working tree — "N commits behind origin",
plus separate warnings for uncommitted local changes and committed-but-unpushed local
commits, since a clean behind-count alone would otherwise read as "up to date" while
either kind of local drift sits unreported; the `sync` verb pulls first and reports what
moved, then reconcile proceeds against whatever's on disk either way — a failed pull
(including a `git rev-list` failure while checking drift) is reported as a failure but
never blocks reconciling from the last-known-good local clone.

The pull is `git pull --rebase --autostash` (git stashes any dirty tracked changes
before rebasing and restores them after, including automatically on an aborted rebase);
`source --commit` commits local edits first instead of autostashing them
(`src/engine/commit.ts`, shared with `boom source push`).

A rebase conflict aborts cleanly (`git rebase --abort`, which also restores the
autostash) and is reported as a failure, but reconcile still proceeds from the local
state as it was before the rebase attempt.

A pinned `@ref` (tag/sha, detached HEAD) is reported as static rather than checked for
drift. Auth is whatever git/SSH already works in the user's shell — no boom-side
credential handling.

The config-repo git verbs live under one namespace: `boom source status` is the read-only
"how does my clone stand against origin?" (behind / unpushed / dirty, exit 0 in sync / 2
on drift) — the same summary the `verify` path shows, over a shared `repoDrift` helper, but
without also walking the whole machine; `boom source push` commits any local
config-repo changes and pushes the managed clone's commits upstream (`-m`/`--message`
sets the commit message); `boom source reset` is the
other direction — fetches, then hard-resets to the upstream tip (or the pinned `@ref`
for a detached clone) and clears untracked files, discarding local changes back to what
a fresh re-clone would leave. Like `linkRemoteConfigRepo`, `boom source reset` refuses
to discard commits no remote has (listing them) unless `--force` is passed — uncommitted
changes alone don't need `--force`, only unpushed commits do. `linkRemoteConfigRepo`
itself refuses to wipe a managed clone that has either uncommitted changes or commits
not yet pushed (checked separately — `git status --porcelain` never reports
ahead-of-upstream) — `boom source push` or `boom source reset` first, then re-link.

### Config is typed TOML, not code

`boomfile.toml` is a TOML document validated against a schema (`src/config/schema.ts`,
valibot). It is grouped into `[[section]]`s; within a section, resources run in a
fixed phase order: `link → copy → glob → packages (brewfile/mise) → run → hook`.
Resources:

- `link` / `copy` `{ src, dst, mode? }`, `glob { pattern, into }`
- `brewfile = "FILE"`, `mise = true`
- `run = [{ on = "sync"|"verify"|"uninstall", cmd, timeout? }]` — the inline imperative
  escape; `timeout` (seconds) caps a step's wall-clock so a hung command can't block reconcile
- `hook = [{ name, with? }]` — load `hooks/<name>.ts`, the TS resource-type extension

A section may carry `when = { os, host, profile }` to gate by machine; overlay
files `boomfile.<os|host|profile>.toml` are merged onto the base. `--profile`
(repeatable) activates named profiles; os/host auto-match (overridable via
`BOOM_OS`/`BOOM_HOST`).

### Hooks = the resource-type extension contract

`hooks/<name>.ts` default-exports (or names) `sync`/`verify`/`uninstall`
functions receiving a `HookApi`: `{ with, verb, dryRun, env, ok, warn, fail, note }`.
Loaded by runtime `import()` (works inside the compiled binary). This replaces the
bash `_NAME_<verb>` hooks and is the public extension point.

### Transaction + state

On-disk state lives in a single **bun:sqlite** database at
`${XDG_STATE_HOME:-~/.local/state}/boom/state.db` (`src/engine/db.ts`): the per-run
transaction journal (intent/done rows + undo token, a `committed` flag) and the `manifest`
of owned destinations. Each journal row commits atomically (WAL), so an interrupted run
leaves whole rows — there's no torn-record to guard against on read. A mutating run holds
an exclusive lockfile under the state dir (`src/lib/lock.ts`) so two concurrent
sync runs can't race on destinations or clobber each other's manifest; a stale lock
from a crashed run (dead pid) is reclaimed. `committed` is set only when the run finished
with zero failures, so `rollback --list` distinguishes a clean run from a half-applied one;
each destructive filesystem op journals its undo *before* the write, so a crash mid-op is
still reversible. `source --resume` continues the interrupted run in place (its id + backup
tree) rather than opening a new one. Mutating runs also
**back up** any displaced file under `…/backups/<run-id>/`. `boom rollback` replays a run's
`done` rows in reverse (remove created links, restore backups) — like a Mother Box, it
remembers everything and can put it back; `--dry-run` previews the replay. The manifest
drives orphan reaping (verify warns; sync reaps), and a legacy TSV manifest is
imported once on upgrade. Breadcrumbs (`config`, `code`) record the config repo (path +
remote) and code dir.

## Stack

| Concern | Choice |
|---------|--------|
| CLI | `@stricli/core` — the only framework that compiles cleanly under `bun build --compile` |
| Config | TOML via `smol-toml`, validated by `valibot` |
| State | `bun:sqlite` (`state.db`: owned-destinations manifest + transaction journal) |
| Shell / process | `Bun.$` / `Bun.spawnSync`; `node:fs/promises` for symlink/copy/mode |
| Output | `Bun.color` palette + a tally Reporter (drives exit codes) |
| Quality gates | Biome (lint + format), `tsc --noEmit`, `bun test` |
| Distribution | `bun build --compile` matrix (macOS arm64/x64, Linux x64) |

## Layout

```
src/
  cli.ts · index.ts        @stricli app + entrypoint (one dispatch: route-map lookup →
                           discovered user cmd, else Stricli — no hardcoded cases)
  commands/                verify/uninstall + source (reconcile.ts; source runs the
                           sync verb — `--fix` overwrites conflicts — and namespaces
                           the set/status/diff/push/reset
                           route map — set is the bootstrap),
                           where, rollback, upgrade, doctor (--config folds in the
                           former validate), code, mcp (add
                           route), completions, man, skill
                           catalog.ts (names+briefs + nested subcommands derived from the
                           route map for completions + man + skill); flags.ts (shared parsers)
  engine/
    reconcile.ts           the one verb loop
    sync.ts                pre-reconcile config-repo fetch/pull(--rebase --autostash)-and-report
    commit.ts              commit local config-repo changes (shared by `boom source push` + source --commit)
    diff.ts                boom source diff (read-only: working-tree diff vs HEAD + untracked)
    status.ts              boom source status (read-only drift vs origin, shared repoDrift helper)
    push.ts reset.ts       boom source push / boom source reset
    registry.ts            data-driven resource table (phase order) + finalize hooks
    resources/             link · copy · glob · packages · osx · run · hook
    db.ts journal.ts state.ts   bun:sqlite store: transaction journal + manifest
    rollback.ts code.ts discovery.ts
  config/  schema.ts load.ts remote.ts profile.ts
  lib/     reporter.ts color.ts fs.ts proc.ts git.ts version.ts
test/                       bun test (unit + sandboxed integration)
examples/dotfiles/          a runnable boomfile.toml example
.github/workflows/          ci.yml (check + cross-compile smoke), release.yml (tag → matrix → attach)
```

## Distribution

`install.sh` downloads the matching binary from the GitHub release; `Formula/boom.rb`
installs it via Homebrew (the repo doubles as the tap). `release.yml` cross-compiles the
matrix on Linux, then **signs the macOS binaries on a real macOS runner** before
assembling the release and computing checksums over the final binaries. Signing is
ad-hoc by default (valid on Apple Silicon); add the `MACOS_*`/`APPLE_*` repo secrets to
switch on Developer ID signing + notarization (see the header of `release.yml`).
`install.sh`/`boom upgrade` only re-sign ad-hoc when a download fails verification, so a
notarized binary is never clobbered.
