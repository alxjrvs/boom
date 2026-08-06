# BoomTube — design spec

**BoomTube** is **declarative dev-machine setup**: a single self-contained binary
(executable: **`boom`**), compiled from **TypeScript on Bun**, that converges a
machine to a declared state — dotfiles, packages, and tools from one
`boomfile.toml`, with drift detection and rollback — then opens portals to your code.
Named for Kirby's **Boom Tube** — an instant conduit between worlds —
it opens a portal to your machine's ideal state, and to your code.

It began as a bash prototype (extracted from `alxjrvs/dotFiles`) and was rewritten
to TypeScript; this document is the design of record for that engine.

This document describes the **current** design, not how it got here. When a release changes
behavior a running machine depends on, the upgrade path is a migration note beside it — for the
0.23 release that is
[`docs/MIGRATING-0.23.md`](https://github.com/alxjrvs/boom/blob/main/docs/MIGRATING-0.23.md),
which covers the retirement of `copy.expand`, the two new load-time errors, and the behavior
changes to `secret`, `rollback`, `uninstall` and glob placement. *(An absolute link, not a
repo-relative one: this file is also rendered as a standalone docs page, where a relative path
into `docs/` would not resolve.)*

## The model (decided — don't relitigate)

A `boom` invocation does one of two things:

1. **Reconcile verbs** over a config repo's `boomfile.toml` — the `sync` verb runs on
   the bare `boom source` command (and its explicit `boom source sync` spelling); the
   rest are their own top-level commands:
   - `boom source` / `boom source sync` — reconcile the machine to the boomfile, running the `sync` verb (`--fix` repairs drift by overwriting conflicts; `--update` also updates outdated brew formulae)
   - `boom verify` — check drift, exit 0 ok / 2 warn / 1 fail (`--json` for a report; `--ci`
     narrows to a non-interactive schema-check gate, 0/1, no machine walk)
   - `boom status` — a read-only one-screen dashboard composing the health signals other
     commands already own (config, config-repo drift, last sync + checkpoints, fleet, lock,
     secrets); introduces no new state
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

2. **Discovered subcommands** — built-ins are the `@stricli` route map, in `src/cli.ts` order:
   <!-- commands:begin -->
   `verify`, `status`, `plan`, `uninstall`, `source`, `where`, `edit`, `rollback`,
   `checkpoint`, `upgrade`, `doctor`, `lock`, `adopt`, `init`, `fleet`, `module`, `code`,
   `mcp`, `askpass`, `completions`, `man`, `skill`.
   <!-- commands:end -->
   That list is asserted **equal** to `commandNames()` by `test/docs-hygiene.test.ts`, so adding
   a route without naming it here (or naming one that no longer routes) fails CI. `source`,
   `fleet`, `module`, `code` and `mcp` are themselves
   nested route maps (`fleet drift|diff`, `module search|add`). `boom init` is the greenfield
   cold-start (adopt → `git init` + commit → create remote → push → breadcrumb). User commands
   resolve at runtime from `<config>/commands/<name>.ts`.
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
fixed phase order:
`link → copy → tmpl → secret → dir → pkg → osx_default → launchd → systemd → run → check → hook`.
Resources:

- `link` / `copy` `= [{ src, dst, mode? }]` — place a repo file at `dst` (symlink vs
  byte-copy). `src` may be a **glob** (then `dst` is a directory and each match is placed
  under it, structure preserved below the pattern's static prefix); when a pattern matches both
  a directory and its descendants (`**`), the directory match is dropped in favour of the
  descendants, and a placement whose destination resolves inside the config repo is refused —
  boom never links the repo into itself. Neither form renders content — that is `tmpl`
- `tmpl = [{ src, dst, mode? }]` — render `src` to `dst`, interpolating `${NAME}` from the
  top-level `[vars]` table, plus `${env:VAR}`/`${host}`/`${os}`. The replacement for the
  retired `copy.expand` and a strict superset of it: one template with per-machine `[vars]`
  replaces N near-identical overlay files. An unknown `${NAME}` is a hard failure (never a
  dangling write). A boomfile still carrying `expand` fails at **load**, with a message naming
  the two-line migration
- `secret = [{ dst, ref? | template?, mode?, backend? }]` — render a secret to a file at sync
  time; `mode` defaults to `0600`. The `backend` is inferred from the ref scheme (`op://`→op,
  `env:`→env, `pass:`→pass, `*.age`→age, `*.sops`→sops) or set explicitly — 1Password
  (`op read`/`op inject`), a plain env var, `pass`, or an age/sops-encrypted file. Secrets stay
  out of the owned-destinations manifest, so orphan reaping never auto-deletes one. boom never
  journals or backs up the plaintext **it** renders (a fresh render's undo is a plain remove); a
  pre-existing file at `dst` is the user's, so it is **left alone** — replacing it takes
  `boom source --fix`, which displaces it into the run's backup tree first so `boom rollback`
  can put it back
- `dir = [{ path, mode?, remove_on_uninstall? }]` — ensure a standalone directory exists
  (declarative `mkdir -p`/`chmod`); `remove_on_uninstall = true` removes it on uninstall *only
  if empty*
- `pkg = [{ manager, file?, remove_on_uninstall? }]` — satisfy a package manager. `brew` runs `brew bundle` over
  `file` (default `Brewfile`); `mise` runs `mise install`; `apt`/`dnf`/`cargo`/`npm` (global)/
  `pipx`/`gem`/`flatpak` install a newline-separated `file` package list, each gating on its
  CLI being present (a missing tool is a reported failure, not a crash). `gh` installs `gh` CLI
  extensions from the same newline list, one owner-qualified `owner/repo` per line (four forks
  answer to `gh-stack`, so the owner is the identity) — `gh extension install`, verify diffs
  `gh extension list`, uninstall removes by bare name; declare it *after* the manager that
  installs `gh`, since there is no cross-section dependency mechanism. One array entry per
  manager; a new manager is one dispatch arm, not a new section key.
  `remove_on_uninstall` decides what `boom uninstall` reclaims, per entry. Omitted, it is
  today's behavior: the user-scoped managers remove what they installed, `apt`/`dnf` never do.
  `= true` opts a system manager **in** (`sudo apt-get remove -y <declared>`, only for packages
  actually installed) — opt-in because system packages are shared machine state, so the flag is
  a declaration of ownership. `= false` opts a user-scoped manager **out**. It is a load-time
  error on `brew`/`mise`: their declared set lives in a Brewfile / the repo's mise config and
  neither has a "remove exactly what this file declares" verb (`brew bundle cleanup` does the
  opposite) — tear those down with a `run` step bound to `on = "uninstall"`
- `osx_default = [{ domain, key, value, type? }]` — a `defaults write`; `type` is inferred
  from the TOML value (`bool`/`int`/`float`/`string`) and only stated to override an edge
  case. The prior value is journaled, so `boom rollback` restores it (or deletes a key boom
  introduced). `boom uninstall` does the same from the recorded *first* prior — the value the
  machine had before boom ever wrote the key — and skips the key untouched when no record
  survives retention, since deleting a default boom may not have introduced is unrecoverable
- `launchd = [{ src, dst? }]` — link a macOS LaunchAgent plist into
  `~/Library/LaunchAgents` and own its launchctl lifecycle (`load -w` on sync, `unload` on
  uninstall); darwin-only, `dst` defaults to `~/Library/LaunchAgents/<basename(src)>`
- `systemd = [{ name, exec, description?, timer?, enable?, env? }]` — the Linux twin of
  `launchd`: **generate** a `.service` (and, when `timer` is a systemd OnCalendar expression, a
  `.timer`) into `~/.config/systemd/user` and own its `systemctl --user` lifecycle
  (daemon-reload + `enable --now` on sync, `disable --now` on uninstall); linux-only. Because
  the unit text is generated, an unchanged stanza re-renders byte-identical → a no-op sync
- `run = [{ on, cmd, timeout?, unless?, creates? }]` — the inline imperative escape; `on` is a
  verb or a list of `"sync"|"verify"|"uninstall"`; `timeout` (seconds) caps a step's wall-clock
  so a hung command can't block reconcile. `unless` is a shell command used as a **predicate**
  (skip the step when it exits 0); `creates` is a path (`~`-expanded, relative to the repo —
  the step's own cwd) skipped when it already exists. Either one satisfied skips the step, and
  the guards apply to **every** verb the step binds to (on `on = "uninstall"`, `creates` reads
  "skip when the path exists", which is usually backwards — use `unless` there). `creates` is
  evaluated in a dry run; `unless` is **not** — a preview never executes user shell, it reports
  that it couldn't tell
- `check = [{ path, present?, absent?, message?, missing_file?, repair? }]` — content
  assertions: every `present` regex must match and every `absent` must not. On `verify` this
  folds into the exit code + JSON report; on `sync`, `repair` (a shell command, run only when
  the assertion currently fails) converges it. `missing_file` defaults to `fail`
- `hook = [{ name, with? }]` — load `hooks/<name>.ts`, the TS resource-type extension; `with`
  carries arbitrary (TOML-typed) values, not just strings

A section may carry `when = { os, host, profile }` to gate by machine, where each value is a
string **or** a list of strings (any-of within an axis, AND across axes); overlay
files `boomfile.<os|host|profile>.toml` are merged onto the base. `--profile`
(repeatable) activates named profiles; os/host auto-match (overridable via
`BOOM_OS`/`BOOM_HOST`). An overlay merges its `[vars]` and `[boom]` over the base's
**last-wins per key** as well as appending its sections, `[[section]]` is optional **in an
overlay only** (a vars-only overlay is legal; a base `boomfile.toml` with no sections is still
a hard load error, so an empty or half-written one can never read as "declare nothing" and
have every managed file reaped), and because `[boom].schedule` is an array a shallow last-wins
merge **replaces** the base's timer list rather than appending to it. `use` in an overlay is a
hard error — see below.

A top-level `use = [<module>, …]` composes other boom config repos — a git remote
(`owner/repo[@ref]`, a URL) or a path relative to this repo — whose sections are merged in
**before** this repo's own (so the repo can override a module). Modules resolve during
reconcile (remotes clone into a cache; a failed resolve warns and is skipped, never fatal);
`boom module` lists them and `--update` re-fetches. A module may itself declare `use`, composed
**recursively** (a resolution-stack guard breaks cycles). A module's sections resolve their
repo-relative paths against the **module's own directory**, so a module ships the dotfiles it
declares; its `[vars]` are the weakest layer (a nested module is weaker still, and the base
repo always wins a collision). Because modules compose *before* the base and an overlay loads
*last*, `use` in an overlay would invert that order — so it is rejected at load rather than
silently dropped. `boom module search <term>` / `add <name>` browse a curated registry of vetted
packs and splice a ref into `use`. A top-level `[vars]` table (a name→string map) supplies the
values `tmpl` resources interpolate.

**Duplicate file destinations resolve last-wins** across `[modules…, base, overlays…]` — and only
among the sections that *apply to this run*. `link`, `copy`, `tmpl` and (on macOS) `launchd` are
keyed on their expanded `dst` alone (a module `link` and a base `copy` to the same path are one
conflict, not two declarations), the loser is dropped at compose time rather than run and then
fought over, and each override is reported as a `CONFIG` note. A `secret` — and a `launchd` off
macOS — is keyed per kind instead, so it still beats a duplicate of *itself* but never overrides a
kind of a different name. Both gates exist for the same reason: only a kind that takes ownership of
the destination may take it away from another, because a winner that declares nothing leaves the
file declared by nobody — and orphan reaping deletes exactly that. A winner hidden behind `when`
would do the same, which is why gating is resolved before keying.
Keying happens before the repo is walked, so it cannot see glob expansion: two glob `src` entries
are never keyed against each other and can still collide on a concrete `dst` at run time, which
the manifest write collapses last-wins as a second line of defense.

### `[boom]` — machine-global self-wiring

A single top-level `[boom]` table folds boom-invoking-boom behaviors into the reconcile
boom already runs, so a consumer stops hand-rolling `run`/plist boilerplate for them. Every
field is opt-in; an absent (or all-off) table changes nothing. The behaviors are work items
run through the *same* guarded loop as section resources (`runWorkItems`,
`src/engine/settings.ts`) — so skill + timer writes are journaled and `boom rollback`-able —
verb-aware (sync installs/refreshes, verify reports drift, uninstall tears the timers down):

- `skill_on_sync = true` — regenerate `~/.claude/skills/boom/SKILL.md` from the running
  binary each sync, so the self-describing skill can't lag a `boom upgrade`.
- `upgrade_on_sync = "check" | "auto"` — after a sync, warn when a newer release ships
  (offline-safe, never fails the sync), or actually self-upgrade.
- `schedule = [{ cmd, every }]` — install/refresh a launchd timer (macOS-only) that runs
  `boom <cmd>` on the interval, e.g. `{ cmd = "verify", every = "15m" }` to catch drift or
  `{ cmd = "code fetch", every = "15m" }` to keep `origin/HEAD` warm for agent worktree cuts —
  without a hand-authored plist. Removing an entry unloads its timer on the next sync.
- `fleet = true` — after a sync, record this machine's summary (boom version, drift verdict,
  date) into `.boom/machines/<host>.json` in the config repo, so `boom fleet` can show a
  cross-machine view from the repo you already push (`fleet drift` narrows to the machines
  needing attention; `fleet diff <a> <b>` compares two). Low-churn: date-granular, written only
  when it changed.
- `notify = true` — when a (typically scheduled) `boom verify` finds drift, raise a desktop
  notification (macOS `osascript` / Linux `notify-send`) so the signal doesn't die in a timer
  log. Best-effort; a platform with no notifier is a silent no-op.
- `sudo_askpass = "<ref>"` — answer a *spawned tool's* `sudo` prompt from the vault instead of
  asking the operator. The one field here that isn't a work item: it's a run-scoped input,
  resolved through the same backends as the `secret` resource (`op://…`, `env:VAR`, `pass:…`).

  The background is that a tool boom spawns can escalate on its own — Homebrew runs `sudo` for any
  cask carrying a `launchctl`/`pkgutil` stanza, which `boom source --update` reaches whenever an
  outdated cask is declared (`greedy` or not). **By default boom just lets it ask you**: sudo
  writes its prompt to `/dev/tty`, which no amount of silenced stdout suppresses, so the only
  thing that ever hid it was boom's own spinner redrawing that line 11×/second — an escalating
  step therefore runs under a persistent label instead of an animation, and the prompt survives.
  That needs no configuration.

  A prompt you can see is still worth nothing if it doesn't say **what** wants the password, so a
  step that can escalate also names its asker two ways. `SUDO_PROMPT` relabels the prompt itself
  (`[boom] brew bundle needs administrator rights — password for jarvis:`), which sudo honors from
  the invoking environment and Homebrew forwards untouched. And because sudoers' escapes (`%p`,
  `%u`, `%H`) have nothing for the *command*, the specific culprit comes from the tool's own
  output: boom pipes the step's stdout and relays only Homebrew's `==>` headlines as live lines, so
  `▸ Upgrading cask tuple` sits directly above the prompt while the byte counts stay hidden under
  the band. Piping also costs the tool its tty, which conveniently drops its colors and progress
  bars; the prompt is unaffected, since `/dev/tty` is not stdout.

  This key is for when there is **nobody to ask** — an unattended sync (launchd timer, CI, remote
  session), where a visible prompt is still an indefinite block. Set it and a mutating sync
  exports `SUDO_ASKPASS` (sudo's own hook, and a documented Homebrew variable: it appends `-A`
  when it sees one; boom does the same for the `sudo` argv it builds itself for apt/dnf), pointing
  at a generated 0700 shim under the state dir that execs `boom askpass <ref>`. An executable is
  required because sudo takes a program path, not a command line — hence a shim rather than a bare
  env var. Only the *reference* is written to disk; the plaintext exists solely in the pipe
  between the helper and sudo, the same discipline `secret` applies by refusing to journal one.
  Configuring it also means nothing will prompt, so the animated spinner comes back.

  One caveat for the unattended case it targets: the `op` backend resolves through *your* 1Password
  session, so a launchd timer with no unlocked session can't read the vault. Use a backend that
  needs no session (`env:`), or keep mutating syncs interactive.

### Hooks = the resource-type extension contract

`hooks/<name>.ts` default-exports (or names) `sync`/`verify`/`uninstall` functions — plus an
optional `declare` run on *every* verb — receiving a `HookApi`:

```
{ with, verb, dryRun, env,                       // inputs
  repo, vars, os, host, profiles, linkMode, verbose, update,   // the run's context
  ok, warn, fail, note, plan, skip,              // the same output tiers a core resource uses
  declare(entry), journalWrite(op, file) }       // the two capabilities
```

Loaded by runtime `import()` (works inside the compiled binary). This replaces the
bash `_NAME_<verb>` hooks and is the public extension point. What a hook gets is what a
built-in resource gets:

- **Ownership** — `declare({ kind: "link" | "copy", dst, src })` puts a destination in the
  manifest, so orphan reaping treats it exactly like a link boom placed. It means *boom owns
  this and may delete it*; declare only what you placed. `declare` fires on verify and dry runs
  too, or a hook-declared file would read as drift on every verify. It is not an uninstall
  path: `boom uninstall` dispatches each section's uninstall verb and then clears the manifest
  without acting on it, so tearing a hook-placed destination down is the hook's own `uninstall`
  export. A hook boom cannot load (missing module, broken import) declares nothing, so that run
  skips orphan reaping entirely rather than reaping what the hook would have claimed.
- **Undo** — `await api.journalWrite(op, file)` writes the transaction's undo record (and backs
  up whatever is there) *before* the hook writes, so `boom rollback` reverses it. It is a
  documented no-op outside a mutating sync, so calling it unconditionally is safe.
- **`--fix` semantics** — `linkMode` tells a hook whether the user asked to overwrite, so it can
  hold the same never-clobber-an-unowned-file default the core resources hold.
- **Silence in steady state** — `skip()` collapses out of the default bands and `plan()` is the
  dry run's "would …" tier, so a converged hook prints nothing until `-v`.
- **The run's profile** — `os`/`host`/`profiles` come from the run's context, which
  `process.platform` cannot reproduce (it sees neither `--profile` nor `BOOM_OS`/`BOOM_HOST`).
- **Module-shippable** — a hook resolves from the declaring section's origin, so a `use`d module
  ships `hooks/<name>.ts` alongside the sections that name it.

A hook is still arbitrary code, so the `hook` side-effect marker stays in the journal regardless:
journaling part of a hook's work never makes all of it reversible.

What remains a **core** change is adding a new resource **type**: `SectionSchema` is a valibot
`strictObject` and `RESOURCES` is a static table — both deliberate consequences of the
typed-validated-TOML north star. Note also that `HookApi` is not importable by a hook module
(hooks are untyped `.ts` loaded by `import()`), so nothing type-checks a hook against it.

### Transaction + state

On-disk state lives in a single **bun:sqlite** database at
`${XDG_STATE_HOME:-~/.local/state}/boom/state.db` (`src/engine/db.ts`): the per-run
transaction journal (intent/done rows + undo token, a `committed` flag) and the `manifest`
of owned destinations. Each journal row commits atomically (WAL), so an interrupted run
leaves whole rows — there's no torn-record to guard against on read. Every run that writes
holds an exclusive lockfile under the state dir (`src/lib/lock.ts`) — `sync` **and**
`uninstall`, plus `rollback`, `rollback --to` and `checkpoint` — so concurrent runs can't race
on destinations or clobber each other's manifest; a stale lock from a crashed run (dead pid)
is reclaimed, and a read-only `rollback --dry-run` is deliberately left unlocked. `committed`
is set only when the run finished with zero failures, and only *after* the `[boom]`
self-wiring and the end-of-run finalize phases, both of which can still fail — a failure in
either leaves the run uncommitted, so `rollback --list` distinguishes a clean run from a
half-applied one. Each destructive filesystem op journals its whole undo — intent, the
displaced original, and the `done` row naming it — *before* the write, so no crash can orphan
a backup nothing points at. `source --resume` continues the interrupted run in place (its id + backup
tree) rather than opening a new one. Mutating runs also
**back up** any displaced file under `…/backups/<run-id>/`. `boom rollback` replays a run's
`done` rows in reverse (remove created links, restore backups, re-apply a macOS default's
prior value) — like a Mother Box, it remembers everything and can put it back; `--dry-run`
previews the replay. It never claims an undo it did not perform: a directory boom created is
reversed with `rmdir` (one the user has since filled is left in place and reported, never
recursively deleted), and a `defaults` restore that exits nonzero is a reported failure, not
a green line. `boom rollback --to <checkpoint>` exits 2 with a warning when the journal was
pruned past the checkpoint, so a partial rewind is never mistaken for a complete one. The manifest
drives orphan reaping (verify warns; sync reaps), and a legacy TSV manifest is
imported once on upgrade. Breadcrumbs (`config`, `code`) record the config repo (path +
remote) and code dir.

### `boom.lock` — version pinning

A boomfile declares *what* to install, not *which version*, so two machines syncing the same
config a week apart can land on different packages. `boom lock` (`src/engine/pinning.ts`) closes
that gap without changing the model: it resolves every declared package to the version actually
installed and writes them to `boom.lock` in the config repo — a committed, reviewable artifact,
not machine state (which is why it lives beside the boomfile and not under the state dir).
`boom lock --check` compares the machine against that file and exits on the usual warning-tier
ladder (0 clean / 2 drift / 1 failure), so it works as a CI gate. Distinct from `src/lib/lock.ts`,
which is the run mutex above — same word, unrelated concept.

### `boom code` — portals to the code dir

`boom code` crawls the code dir (`BOOM_CODE` → breadcrumb → `~/Code`) by the leaf rule: a git
repo is a leaf, never descended into. Two subcommands ride that crawl:

- **`boom code fetch`** — fan out `git fetch` across every repo, so `origin/HEAD` is warm when an
  agent cuts a worktree from it. Cheap and idempotent; the canonical `[boom] schedule` entry.
- **`boom code reap`** — sweep spent agent worktrees. It re-decides by *content* (git patch-id),
  not SHA identity, because a squash-merge rewrites history and leaves a fully-merged branch's
  commits existing nowhere by SHA. It removes only a worktree that is clean, unlocked (or locked
  by a dead pid), and either fully pushed or already merged; it deletes the directory, never the
  branch ref, so it cannot lose a commit. Default answer is *keep*; `--dry-run` classifies without
  touching anything, `--push` publishes a clean-but-unpushed worktree first, and `-i` decides per
  worktree.

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
    status.ts              boom source status (read-only drift vs origin, shared reportRepoDrift)
    push.ts reset.ts       boom source push / boom source reset
    overview.ts            boom status (read-only dashboard composing the existing readers)
    init.ts                boom init (greenfield: adopt → git init + commit → remote → breadcrumb)
    fleet.ts               boom fleet (list · drift · diff) over .boom/machines/<host>.json
    importers.ts           boom adopt --from (stow · chezmoi · yadm · dotbot · nix-darwin)
    registry.ts            data-driven resource table (phase order) + finalize hooks
    resources/             link · copy · tmpl · secret · dir · pkg · osx · launchd · systemd · run · check · hook
    secrets/backends.ts    pluggable secret backends (op · env · pass · age · sops)
    secrets/askpass.ts     SUDO_ASKPASS shim: answer a spawned tool's sudo prompt from the vault
    db.ts journal.ts       bun:sqlite store: transaction journal
    state.ts               the owned-destinations manifest (layout lives in lib/paths.ts)
    skill.ts               renders the Claude SKILL.md (commands/skill.ts is the CLI wrapper)
    pinning.ts             boom lock / --check: resolved package versions in boom.lock
    rollback.ts code.ts discovery.ts
  config/  schema.ts load.ts compose.ts remote.ts profile.ts modules.ts registry.ts (curated module packs)
  lib/     reporter.ts color.ts fs.ts paths.ts proc.ts git.ts release.ts version.ts
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
