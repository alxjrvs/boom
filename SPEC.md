# BoomTube — design spec

**BoomTube** is **declarative dev-machine setup**: a single self-contained binary
(executable: **`boom`**), compiled from **TypeScript on Bun**, that converges a
machine to a declared state — dotfiles, packages, and tools from one
`boomfile.toml`, with drift detection — and a journal that preserves whatever it displaces.
Named for Kirby's **Boom Tube** — an instant conduit between worlds —
it opens a portal to your machine's ideal state, and to your code.

It began as a bash prototype (extracted from `alxjrvs/dotFiles`) and was rewritten
to TypeScript; this document is the design of record for that engine.

This document describes the **current** design, not how it got here. When a release changes
behavior a running machine depends on, the upgrade path is a migration note beside it:

- [`docs/MIGRATING-0.33.md`](https://github.com/alxjrvs/boom/blob/main/docs/MIGRATING-0.33.md) —
  the four config-repo git subcommands (`source status|diff|push|reset`) removed in favor of
  running git against the clone directly. No config edit is required.
- [`docs/MIGRATING-0.32.md`](https://github.com/alxjrvs/boom/blob/main/docs/MIGRATING-0.32.md) —
  `systemd`, seven package managers and three secret backends removed. Unlike 0.31 these ARE
  load-time errors: a boomfile naming one fails to parse until it is edited.
- [`docs/MIGRATING-0.31.md`](https://github.com/alxjrvs/boom/blob/main/docs/MIGRATING-0.31.md) —
  ten verbs removed and `[boom] schedule` retired. No config edit is required, but a machine that
  had `schedule` keeps its LaunchAgents loaded, because the reaper went with the generator.
- [`docs/MIGRATING-0.23.md`](https://github.com/alxjrvs/boom/blob/main/docs/MIGRATING-0.23.md) —
  the retirement of `copy.expand`, the two new load-time errors, and the behavior changes to
  `secret`, `rollback`, `uninstall` and glob placement. Written while `rollback` still existed.

*(Absolute links, not repo-relative ones: this file is read on GitHub and from the installed
binary's own help, where a relative path into `docs/` would not resolve.)*

## The model (decided — don't relitigate)

A `boom` invocation does one of two things:

1. **Reconcile verbs** over a config repo's `boomfile.toml` — the `sync` verb runs on
   the bare `boom source` command (and its explicit `boom source sync` spelling); the
   rest are their own top-level commands:
   - `boom source` / `boom source sync` — reconcile the machine to the boomfile, running the `sync` verb (`--fix` repairs drift by overwriting conflicts; `--update` also updates outdated brew formulae)
   - `boom verify` — check drift, exit 0 ok / 2 warn / 1 fail (`--json` for a report; `--ci`
     narrows to a non-interactive schema-check gate, 0/1, no machine walk)
   - `boom uninstall`
   These share **one verb-parameterized loop** (`src/engine/reconcile.ts`) over a
   resource-type registry — siblings, not separate scripts. `source --resume` continues an
   interrupted one. A
   conflicting (non-boom-owned) file at a `link` destination is **skipped by
   default** (boom never clobbers a file it doesn't own); `source --fix` opts into
   overwriting it — that's how drift is repaired, so there's no separate `fix` verb.
   `sync` is the one canonical reconcile name; bare `boom source` is its shorthand
   (the namespace's default command), not a separate alias.

   The `sync` verb (never `verify`/`uninstall`) also syncs the config repo's own git
   state against its remote first (`src/engine/sync.ts`): by default `pull --rebase
   --autostash`s, so any uncommitted local edits ride along and land back on top;
   `source --commit` commits local edits first instead of autostashing them, so
   they replay as a real commit on the rebase (`-m` names the message).

2. **Discovered subcommands** — built-ins are the `@stricli` route map, in `src/cli.ts` order:
   <!-- commands:begin -->
   `verify`, `uninstall`, `source`, `upgrade`, `doctor`, `skill`.
   <!-- commands:end -->
   That list is asserted **equal** to `commandNames()` by `test/docs-hygiene.test.ts`, so adding
   a route without naming it here (or naming one that no longer routes) fails CI. `source` is
   itself a nested route map. User commands
   resolve at runtime from `<config>/commands/<name>.ts`.
   The route map is the **single registry, with no hardcoded dispatch anywhere**: `index.ts`
   decides built-in-vs-discovered by asking the route map itself
   (`getRoutingTargetForInput`), and `src/commands/catalog.ts` *derives* command names +
   briefs from that same route map for `boom skill` — one source of truth, no parallel table
   to keep in sync. That is why removing a verb is a one-line edit here: the shell completions
   and man page it also fed were derived, and were deleted with their commands.

### The journal, without an undo verb

Every mutation is still journaled, and an overwrite still **displaces** the original into
`backups/<run-id>/` at 0700 rather than destroying it. What is gone is `boom rollback`: nothing
replays those records automatically any more. Two consumers keep the journal load-bearing —
`displace()` is what makes `source --fix` non-destructive, and `--resume` reads the last
uncommitted run to continue it rather than opening a second.

So a bad sync is recovered by hand, from a backup tree that is still written for exactly that
purpose. That is the trade: the records cost what they always did, and reading them is now a
person's job.

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
`source --commit` commits local edits first instead of autostashing them.

A rebase conflict aborts cleanly (`git rebase --abort`, which also restores the
autostash) and is reported as a failure, but reconcile still proceeds from the local
state as it was before the rebase attempt.

A pinned `@ref` (tag/sha, detached HEAD) is reported as static rather than checked for
drift. Auth is whatever git/SSH already works in the user's shell — no boom-side
credential handling.

Operating that clone is git's job. boom clones it, reconciles from it, and *reports* its
drift (`verify` must, to answer "am I in sync?"), but it does not wrap git: the
`boom source status|diff|push|reset` verbs were removed in 0.33 because each was a
second, weaker spelling of a command the user already has, against a path `boom doctor`
already prints — `git -C <dir> status -sb`, `diff HEAD`, `reset --hard origin/<branch>`,
`commit && push`. See `docs/MIGRATING-0.33.md`.

`linkRemoteConfigRepo` still refuses to wipe a managed clone that has either uncommitted
changes or commits not yet pushed (checked separately — `git status --porcelain` never
reports ahead-of-upstream): push or discard that work first, then re-link.

### Config is typed TOML, not code

`boomfile.toml` is a TOML document validated against a schema (`src/config/schema.ts`,
valibot). It is grouped into `[[section]]`s; within a section, resources run in a
fixed phase order:
`link → copy → tmpl → secret → dir → pkg → osx_default → launchd → run → check → absent → hook`.
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
  `env:`→env) or set explicitly — 1Password (`op read`/`op inject`) or a plain env var.
  Secrets stay
  out of the owned-destinations manifest, so orphan reaping never auto-deletes one. boom never
  journals or backs up the plaintext **it** renders (a fresh render's undo is a plain remove); a
  pre-existing file at `dst` is the user's, so it is **left alone** — replacing it takes
  `boom source --fix`, which displaces it into the run's backup tree first so the original
  can put it back
- `dir = [{ path, mode?, remove_on_uninstall? }]` — ensure a standalone directory exists
  (declarative `mkdir -p`/`chmod`); `remove_on_uninstall = true` removes it on uninstall *only
  if empty*
- `pkg = [{ manager, file?, remove_on_uninstall? }]` — satisfy a package manager. `brew` runs
  `brew bundle` over `file` (default `Brewfile`); `mise` runs `mise install`; `gh` installs `gh`
  CLI extensions from a newline-separated `file` list, one owner-qualified `owner/repo` per line
  (four forks answer to `gh-stack`, so the owner is the identity) — `gh extension install`,
  verify diffs `gh extension list`, uninstall removes by bare name; declare it *after* the
  manager that installs `gh`, since there is no cross-section dependency mechanism. Each gates on
  its CLI being present (a missing tool is a reported failure, not a crash). One array entry per
  manager; a new manager is one dispatch arm, not a new section key.
  `remove_on_uninstall` decides what `boom uninstall` reclaims, per entry. Omitted, `gh` removes
  what it installed; `= false` opts it out. It is a load-time error on `brew`/`mise`: their
  declared set lives in a Brewfile / the repo's mise config and neither has a "remove exactly
  what this file declares" verb (`brew bundle cleanup` does the opposite) — tear those down with
  a `run` step bound to `on = "uninstall"`
- `osx_default = [{ domain, key, value, type? }]` — a `defaults write`; `type` is inferred
  from the TOML value (`bool`/`int`/`float`/`string`) and only stated to override an edge
  case. The prior value is journaled, so it can be recovered by hand (including a key boom
  introduced). `boom uninstall` does the same from the recorded *first* prior — the value the
  machine had before boom ever wrote the key — and skips the key untouched when no record
  survives retention, since deleting a default boom may not have introduced is unrecoverable
- `launchd = [{ src, dst? }]` — link a macOS LaunchAgent plist into
  `~/Library/LaunchAgents` and own its launchctl lifecycle (`load -w` on sync, `unload` on
  uninstall); darwin-only, `dst` defaults to `~/Library/LaunchAgents/<basename(src)>`
- `run = [{ on, cmd, timeout?, unless?, creates? }]` — the inline imperative escape; `on` is a
  verb or a list of `"sync"|"verify"|"uninstall"`; `timeout` (seconds) caps a step's wall-clock
  so a hung command can't block reconcile. `unless` is a shell command used as a **predicate**
  (skip the step when it exits 0); `creates` is a path (`~`-expanded, relative to the repo —
  the step's own cwd) skipped when it already exists. Either one satisfied skips the step, and
  the guards apply to **every** verb the step binds to (on `on = "uninstall"`, `creates` reads
  "skip when the path exists", which is usually backwards — use `unless` there). `creates` is
  evaluated in a dry run; `unless` is **not** — a preview never executes user shell, it reports
  that it couldn't tell
- `check = [{ path, present?, absent?, json?, message?, missing_file?, repair? }]` — content
  assertions: every `present` regex must match and every `absent` must not. On `verify` this
  folds into the exit code + JSON report; on `sync`, `repair` (a shell command, run only when
  the assertion currently fails) converges it. `missing_file` defaults to `fail`
- `json = [{ key, equals? | present? | absent? | contains? }]` on a `check` — assertions
  against the **parsed** document rather than its text. `key` is a dot path where a numeric
  segment indexes an array (`hooks.PreToolUse.0.matcher`); exactly one predicate per entry.
  A regex over JSON text means writing `'"model"\s*:\s*"[^"]*fable'` and hoping the formatting
  never changes, and it cannot express "this array contains that element" at all — which is why
  consumers reach for `jq` inside `run` steps instead. `absent` and a `null` value are
  deliberately different answers, because `null` is a thing a config can mean. A document that
  does not parse fails once with the parse error, rather than once per assertion
- `check = [{ cmd, exit?, stdout_present?, stdout_absent?, message?, repair? }]` — the same
  resource asserting about a **command** instead of a file: it must exit `exit` (default 0) and
  its combined output must match every `stdout_present` regex and no `stdout_absent` one.
  stderr counts as output, since a tool that reports a problem on stderr and still exits 0 is
  exactly what such an assertion is written to catch. The `run`-with-`unless` shape reported
  through a shell exit code; this reports through the drift report, the exit code and `--json`
  like every other resource. **Read-only by contract** — it runs during `verify`, so a mutating
  `cmd` turns a read-only drift check into a write; the mutating half is `repair`. Exactly one
  of `path` or `cmd` per entry
- `absent = [{ path, message?, recursive? }]` — a path that must **not** exist: `sync` removes
  it, `verify` fails while it is there, `uninstall` leaves it alone (boom did not create it).
  The inverse of `check`, and the shape `check` cannot express — `missing_file = "pass"` says
  absent is *acceptable*, never *required*. For files a tool re-creates behind your back: an
  editor's local override, a credential cache, a `settings.local.json` an agent writes on an
  "always allow" click. Removal goes through the journal, so the file lands in the run's backup
  tree and is recoverable from there — the difference between this and a `run` step calling
  `rm`, which destroys. A directory needs `recursive = true`, so one typo in a path is not a
  silent recursive delete
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
have every managed file reaped), and because a shallow last-wins merge on an ARRAY key is a
replace rather than an append, an overlay declaring one drops the base's entries entirely.

A top-level `[vars]` table (a name→string map) supplies the values `tmpl` resources
interpolate.

**Duplicate file destinations resolve last-wins** across `[base, overlays…]` — and only
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
`src/engine/settings.ts`) — so skill writes are journaled and recoverable —
verb-aware (sync installs/refreshes, verify reports drift, uninstall tears the timers down):

- `skill_on_sync = true` — regenerate `~/.claude/skills/boom/SKILL.md` from the running
  binary each sync, so the self-describing skill can't lag a `boom upgrade`.
- `upgrade_on_sync = "check" | "auto"` — after a sync, warn when a newer release ships
  (offline-safe, never fails the sync), or actually self-upgrade.
- `schedule` — **RETIRED.** boom used to generate and reap `com.boomtube.*` launchd timers
  from this array. The key is still *accepted* (parsed, ignored) rather than rejected, because
  `[boom]` is a strict table and failing a whole boomfile over a key that used to work is the
  worse outcome. To run boom on a timer now, author a plist and link it with the `launchd`
  resource, which owns the load/unload lifecycle.
- `notify = true` — when `boom verify` finds drift, raise a desktop notification (macOS
  `osascript` / Linux `notify-send`) so the signal doesn't die in a log. Verb-driven, not
  schedule-gated: a hand-run verify notifies the same way. Best-effort; a platform with no
  notifier is a silent no-op.
### Escalation, and why there is no askpass key

A tool boom spawns can escalate on its own — Homebrew runs `sudo` for any cask carrying a
`launchctl`/`pkgutil` stanza, which `boom source --update` reaches whenever an outdated cask is
declared (`greedy` or not). **boom lets it ask you.** sudo writes its prompt to `/dev/tty`, which
no amount of silenced stdout suppresses, so the only thing that ever hid it was boom's own spinner
redrawing that line 11×/second — an escalating step therefore runs under a persistent label instead
of an animation, and the prompt survives. That needs no configuration.

A prompt you can see is still worth nothing if it doesn't say **what** wants the password, so a
step that can escalate names its asker two ways. `SUDO_PROMPT` relabels the prompt itself
(`[boom] brew bundle needs administrator rights — password for jarvis:`), which sudo honors from
the invoking environment and Homebrew forwards untouched. And because sudoers' escapes (`%p`, `%u`,
`%H`) have nothing for the *command*, the specific culprit comes from the tool's own output: boom
pipes the step's stdout and relays only Homebrew's `==>` headlines as live lines, so
`▸ Upgrading cask tuple` sits directly above the prompt while the byte counts stay hidden under the
band. Piping also costs the tool its tty, which conveniently drops its colors and progress bars;
the prompt is unaffected, since `/dev/tty` is not stdout.

There was a vault-backed key here for the unattended case (a launchd timer, CI), and a matching
`boom askpass` command. **The command is gone; the key is retired.** The command printed a
resolved secret to stdout, which is a second way to read a vault value under a program name a
machine's own controls are unlikely to have denied. Its own documentation argued the verb needed no
fence because "anyone who can run `boom askpass op://…` can run `op read op://…` directly" — false
on any machine that restricts the vault CLI, which is exactly the machine that most needs the
guarantee. No configured user was found; the feature was carrying that exposure for nobody.

`sudo_askpass` is still **accepted and ignored**, so a boomfile carrying it keeps loading. That is
deliberate, and it is a different call from `copy.expand`, which is declared `v.never` so the
failure can name its replacement. That pattern fits when the migration is another config key — the
error names it and you edit one line. Here the migration is an *environment* action, which no
config edit expresses, so failing the whole boomfile would strand a machine over a key whose
replacement isn't in the file at all. A mutating sync warns when the key is set; the key is deleted
at 1.0.

If you need an unattended escalating sync, export `SUDO_ASKPASS` yourself — it is sudo's variable,
not boom's, and boom still honors one it inherits: it skips the prompt label and the header relay
(nothing is going to ask). Otherwise keep mutating syncs interactive.

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
  up whatever is there) *before* the hook writes, so the original survives it. It is a
  documented no-op outside a mutating sync, so calling it unconditionally is safe.
- **`--fix` semantics** — `linkMode` tells a hook whether the user asked to overwrite, so it can
  hold the same never-clobber-an-unowned-file default the core resources hold.
- **Silence in steady state** — `skip()` collapses out of the default bands and `plan()` is the
  dry run's "would …" tier, so a converged hook prints nothing until `-v`.
- **The run's profile** — `os`/`host`/`profiles` come from the run's context, which
  `process.platform` cannot reproduce (it sees neither `--profile` nor `BOOM_OS`/`BOOM_HOST`).

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
`uninstall` — so concurrent runs can't race
on destinations or clobber each other's manifest; a stale lock from a crashed run (dead pid)
is reclaimed. `committed`
is set only when the run finished with zero failures, and only *after* the `[boom]`
self-wiring and the end-of-run finalize phases, both of which can still fail — a failure in
either leaves the run uncommitted, so `--resume` distinguishes a clean run from a
half-applied one. Each destructive filesystem op journals its whole undo — intent, the
displaced original, and the `done` row naming it — *before* the write, so no crash can orphan
a backup nothing points at. `source --resume` continues the interrupted run in place (its id + backup
tree) rather than opening a new one. Mutating runs also
**back up** any displaced file under `…/backups/<run-id>/`. No command replays those rows (see
*The journal, without an undo verb* above); what the record buys is that nothing an overwrite
or a reap replaced was destroyed, and a row names where each original went. `boom uninstall`
undoes what boom installed by removing it — reading the `meta` stash for the one non-file
effect, a macOS default's pre-boom prior (`defaults write` it back, or `defaults delete` a key
boom introduced). The manifest drives orphan reaping (verify warns; sync reaps). The `config`
breadcrumb records the config repo (path + remote).

## Stack

| Concern | Choice |
|---------|--------|
| CLI | `@stricli/core` — the only framework that compiles cleanly under `bun build --compile` |
| Config | TOML via `Bun.TOML.parse` (`lib/toml.ts` re-adds the line number Bun omits), validated by `valibot` |
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
                           the sync/set route map — set is the bootstrap),
                           upgrade, doctor (--config folds in the former validate), skill;
                           catalog.ts (names+briefs + nested subcommands derived from the
                           route map, for `boom skill`); flags.ts (shared parsers)
  engine/
    reconcile.ts           the one verb loop
    sync.ts                pre-reconcile config-repo fetch/pull(--rebase --autostash)-and-report
                           (+ the `--commit` half: commit local edits instead of autostashing)
    registry.ts            data-driven resource table (phase order) + finalize hooks
    resources/             link · copy · tmpl · secret · dir · pkg · osx · launchd · run · check · hook
    secrets/backends.ts    pluggable secret backends (op · env)
    db.ts journal.ts       bun:sqlite store: transaction journal
    state.ts               the owned-destinations manifest (layout lives in lib/paths.ts)
    skill.ts               renders the Claude SKILL.md (commands/skill.ts is the CLI wrapper)
    settings.ts            the `[boom]` self-wiring table (skill install/refresh)
    doctor.ts validate.ts types.ts discovery.ts
  config/  schema.ts load.ts compose.ts remote.ts profile.ts
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
