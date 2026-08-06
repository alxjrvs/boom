# Migrating to boom 0.23.0

0.23 is the release where boom stopped claiming things it hadn't done. Three of the changes need
an edit to your `boomfile.toml` before **any** boom command will run; the rest need no edit but
make a run behave differently, and one of those can silently stop a scheduled job from doing its
job. Read the ⚠️ bullet even if you read nothing else.

Everything here is pre-1.0 churn, deliberately taken in one release rather than dripped out.

---

## Breaking — a config edit is required

These are **load-time** errors. Config is parsed before any verb runs, so `boom verify`,
`boom status` and `boom plan` fail exactly like `boom source` does until the file is fixed. That
is the point: a config that can't be satisfied should never look half-fine.

### 1. `copy.expand` is gone — use `tmpl`

`copy` places bytes; it never rendered them well. `tmpl` is the real resource, and a strict
superset of what `expand` did.

**Before**

```toml
[[section]]
name = "Git"
copy = [{ src = "gitconfig", dst = "~/.gitconfig", expand = true }]
```

**After**

```toml
[vars]
email = "you@example.com"

[[section]]
name = "Git"
tmpl = [{ src = "gitconfig", dst = "~/.gitconfig" }]
```

`tmpl` interpolates everything `expand` did — `${env:VAR}`, `${host}`, `${os}` — **plus**
`${NAME}` from the top-level `[vars]` table, which is what lets one template replace N
near-identical overlay files. An unknown `${NAME}` is a hard failure rather than a dangling
write, so a typo can't ship a half-rendered file.

Find every affected entry:

```sh
grep -rn 'expand' <config-repo>/boomfile*.toml
```

The key is still *declared* in the schema, purely so the failure names the migration instead of
reading "unknown key `expand`". It comes out at 1.0.

### 2. `use` in an overlay is a load error

**Before** (`boomfile.darwin.toml`)

```toml
use = ["myorg/boom-mac"]
```

**After** — move it into the base `boomfile.toml`:

```toml
use = ["myorg/boom-base", "myorg/boom-mac"]
```

Modules compose **before** the base repo's own sections, so the base can override a module.
An overlay loads **last**. Honoring a `use` there would invert that order — the module you
declared latest would compose earliest, and nothing about the file would say so. Rejected at
load rather than silently dropped.

If a module is genuinely machine-specific, gate its *sections* with `when` (which now takes a
list per axis) rather than gating the `use`.

### 3. `remove_on_uninstall` on a `brew`/`mise` `pkg` entry is a load error

Nobody can have one today — the key is new in this release — but it is worth knowing why the
one obvious spelling is rejected:

```toml
# rejected at load
pkg = [{ manager = "brew", file = "Brewfile", remove_on_uninstall = true }]
```

A Brewfile / the repo's mise config *is* the declared set, and neither manager has a "remove
exactly what this file declares" verb (`brew bundle cleanup` does the opposite — it removes what
the file *doesn't* declare). Rather than pretend, boom refuses the key and points at the honest
alternative:

```toml
run = [{ on = "uninstall", cmd = "brew bundle cleanup --file Brewfile --force" }]
```

---

## Behavior changes — no edit, but a run does something different

### ⚠️ `secret` no longer clobbers a file it didn't render — so a **rotated** secret needs `--fix`

This is the one that can quietly stop working.

Before 0.23, `secret` removed whatever sat at `dst` and wrote its own render over it, every run,
with no backup. That is the never-clobber-an-unowned-file rule broken on the *default* path, on
the one resource whose destinations hold credentials.

Now a pre-existing file at a `secret` `dst` is left **byte- and mode-identical**, and the report
names the flag that would replace it:

```
~/.config/gh/token exists — left alone (boom source --fix replaces it)
```

`boom source --fix` replaces it, displacing the original into `…/backups/<run-id>/` first, so
`boom rollback` puts it back.

**The consequence to plan for:** boom keeps no ownership record for secrets, so it cannot tell
its own previous render from a file you wrote. A **rotated** secret therefore does *not*
re-render on a plain `boom source` — the old value is a pre-existing file, and it is left alone.
A `[boom] schedule` entry or launchd timer running bare `boom source` **silently stops rotating**
until you do something about it.

The narrow fix is to delete the stale file and let the next plain sync render it fresh — nothing
is in the way, so no flag is needed. The blunt fix is to schedule the flag:

```toml
[boom]
schedule = [{ cmd = "source --fix", every = "6h" }]
```

Weigh that one: `--fix` is machine-wide, not secret-scoped, so an unattended `--fix` also
overwrites every *other* conflicting destination it finds. Prefer it only where the machine is
meant to be fully boom-owned. A first-time render is
unaffected — nothing is in the way, so it just writes, and its undo stays a plain remove: boom
still never journals or backs up the plaintext **it** renders.

One accepted cost of `--fix`: because there is no ownership record, overwriting boom's *own*
prior render does place that older plaintext under `…/backups/<run-id>/` for the retention window
(~10 runs). The backup tree is created at mode `0700`. `--fix` over an already-current secret is
a no-op — it does not re-render and does not back anything up — so the steady-state path never
accumulates copies.

### A `**` glob links per-file only, and never into the config repo

A `src` pattern that matched both a directory and its descendants (`nvim/**`) used to place a
symlink for the directory **and** one for each file under it. The next placement's destination
then resolved *through* that fresh symlink, back into the config repo — so under `--fix` boom
moved its own sources into the backup tree and replaced them with self-referential links.

Now the directory match is dropped in favour of its descendants, and any placement whose
destination resolves inside the config repo is a hard failure:

```
~/.config/nvim/init.lua resolves inside the config repo — refusing to link the repo into itself
```

Two things follow. If you relied (probably accidentally) on `**` producing a directory-level
symlink *plus* per-file links, you now get per-file links only — `src = "dir/*"` still links a
matched subdirectory whole, which is the supported way to ask for that. And a machine already
damaged by the old behavior **exits 1** until it is cleaned up: the loudness is intentional.
Recover the displaced sources from `…/backups/<run-id>/`, or re-clone the config repo.

### `boom rollback` stops reporting undos it didn't perform

- A directory boom created is reversed with **`rmdir`**, never `rm -rf`. One you have since
  filled is left in place and reported (`left in place — not empty`), exit 0. One you already
  deleted yourself counts as reversed, not failed.
  **Forward-only**: journals written before 0.23 recorded a plain remove for those directories
  and keep the old recursive semantics. Only runs made by 0.23+ carry the safe token.
- A `defaults` restore that exits nonzero is a **failure** (exit 1) with the exit code in the
  message, instead of a green `restored default …` line over a restore that never happened.
- `boom rollback --to <checkpoint>` **exits 2** with a warning when the journal was pruned past
  that checkpoint, rather than exiting 0 over a partial rewind. It also now exits 2 for the
  pre-existing "not reversible (run/hook side effects)" warnings — honest, but an exit-code
  change if you script it.

### `boom uninstall` puts macOS defaults back

`osx_default` uninstall used to return early and leave every `defaults write` boom had made in
place. It now restores the **first** journaled prior — the value the machine had before boom
ever touched the key, not boom's own previous value — or deletes a key boom introduced. When no
record survives journal retention it skips the key untouched and says so, because deleting a
default boom may not have introduced is unrecoverable.

Two consequences: `boom uninstall` may now **restart Dock/Finder/SystemUIServer** (same reason
sync does), and a machine that synced `osx_default` entries before 0.23 may have lost its
original priors to pruning — those keys are skipped, not guessed at.

### `uninstall`, `rollback` and `checkpoint` take the run lock

Only `sync` held the exclusive run lock, while `uninstall` removed destinations a concurrent sync
was re-creating and both rewrote the same manifest. All mutating verbs now take it, so an
overlapping scheduled sync makes one of the two fail fast and cleanly:

```
another boom run is in progress (pid 12345) — wait for it to finish, or remove <path> if it crashed
```

A read-only `rollback --dry-run` is deliberately left unlocked.

### Duplicate destinations are last-wins

When two layers of `[modules…, base, overlays…]` declare the same expanded `dst`, the **last**
one wins and the loser is dropped at compose time (reported as a `CONFIG` note under `--verbose`)
instead of both running and fighting over the file. `link` was previously first-wins, so a base
repo trying to override a module's `link` lost to the module.

Only sections that apply to *this* run participate — gating is resolved before keying, so a
winner hidden behind `when` can't take a destination away and then decline to place it.

### A module ships its own files

A module's sections now resolve repo-relative paths against the **module's own directory**, so a
`use`d module can ship the dotfiles and `hooks/<name>.ts` it declares instead of requiring you to
vendor them. A module's `[vars]` are a real layer — the weakest one (a nested module weaker
still; your base repo always wins a collision).

### `code reap` is stack-aware

`boom code reap` judges a stacked worktree **layer by layer** and **skips** one whose recorded
`gh stack` still has open layers, naming the count (`stack #112 — 2 of 3 layers open`) — the
answer to a half-landed stack is `gh stack merge`, not a per-worktree decision. The upside is the
case that used to be un-reapable at all: a stack lands as N separate squash commits, which the
whole-tree content test could never match, so a fully-merged stack was kept forever.
And `--push` **never** publishes a worktree holding stack state: a stack is published by
`gh stack submit`, so pushing one layer is at best a no-op.

Removing a stacked worktree drops that worktree's local stack topology (`gh stack` records it in
the worktree's own admin dir). No commit is lost — `reap` never deletes a branch ref —
and `gh stack checkout <n>` re-attaches.

### Smaller things

- A hook with no `verify` export now prints an `unchecked` note on `boom verify` (exit code
  unchanged) instead of being silently absent from the report.
- `boom plan` / `boom source --dry-run` evaluate `run.creates` but **never execute
  `run.unless`** — a preview does not run user shell, so it reports that it couldn't tell.
- `boom plan --help`'s `--verbose` brief changed by one phrase (`only pending changes` →
  `only changes + attention`), matching what the reporter actually shows.

---

## New — additive, nothing to do

- **`run.unless` / `run.creates`** — idempotence guards. `unless` is a shell predicate (skip when
  it exits 0); `creates` is a path (skip when it already exists). Either one satisfied skips the
  step, on every verb the step binds to.
- **List-valued `when`** — `when = { os = ["darwin", "linux"], profile = ["work", "ci"] }`.
  Any-of within an axis, AND across axes.
- **`pkg manager = "gh"`** — `gh` CLI extensions from a newline-separated list, one
  owner-qualified `owner/repo` per line (four forks answer to `gh-stack`, so the owner is the
  identity). Declare it *after* the `pkg` entry that installs `gh` — boom has no cross-section
  dependency mechanism.
- **`pkg.remove_on_uninstall`** — per entry. Omitted is today's behavior exactly; `= true` opts
  `apt`/`dnf` in; `= false` opts a user-scoped manager out.
- **First-class hooks** — a hook now gets the run's context (`repo`, `vars`, `os`, `host`,
  `profiles`, `linkMode`, `verbose`, `update`), the same output tiers a core resource uses
  (`ok`/`warn`/`fail`/`note`/`plan`/`skip`), `declare()` to put a destination in the owned
  manifest, and `journalWrite()` to record its undo *before* it writes so `boom rollback`
  reverses it. Modules can ship one.
- **Vars-only and `[boom]`-only overlays** — `[[section]]` is optional in an overlay, so a
  `[vars]`-only file is the lightest way to differentiate a machine.

---

See [`SPEC.md`](../SPEC.md) for the design of record, and `boom man` for the shipped reference.
