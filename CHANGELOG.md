# Changelog

Release notes for the changes a running machine depends on: removed verbs and flags, config keys
that stop loading, and behavior that changes without a config edit. Each release's `Why` is kept
short on purpose; the argument that justified a removal lives in the PR that made it.

Anchors are stable (`CHANGELOG.md#0370`), so code comments and runtime warnings can point here.

Everything before 1.0 is pre-1.0 churn, deliberately taken in whole releases rather than dripped
out. [`SPEC.md`](SPEC.md) describes the **current** design; this file is the record of how it got
there.

---

## 0.39.0

Two removals. Both fail loudly rather than being accepted and ignored.

### Removed: `boom verify --ci`

The flag abandoned the verify verb and ran the doctor engine's config check, a command that
exists on its own with the same exit contract (0 valid / 1 invalid) and the same output.

| Removed | Native equivalent |
| --- | --- |
| `boom verify --ci` | `boom doctor --config` |

The shipped GitHub Action example (`examples/github-action`) runs `boom doctor --config`.

### Retired config keys now fail to load

`secret`, `[boom] schedule`, `[boom] sudo_askpass` and `upgrade_on_sync = "auto"` were accepted
and ignored (with a warning) after their features were removed. A boomfile carrying one now fails
at load, and the error names this entry and the replacement:

| Key | Delete it and… |
| --- | --- |
| `secret = […]` | resolve at point of use (`op run --env-file=F -- CMD`), or render from a `run` step |
| `[boom] schedule` | link a plist with the `launchd` resource |
| `[boom] sudo_askpass` | export `SUDO_ASKPASS` yourself; boom honours an inherited one |
| `upgrade_on_sync = "auto"` | use `"check"`; upgrading is your package manager's job |

`copy.expand` has failed at load since 0.23 and is unchanged.

---

## 0.38.0

One removal, and it is a flag rather than config.

### Removed: `boom source --update`

The flag opted a sync into upgrading outdated Homebrew packages. `brew bundle` now runs with
`--no-upgrade` on every verb, unconditionally.

| Removed | Native equivalent |
| --- | --- |
| `boom source --update` | `brew upgrade --formula`, and `mise upgrade` |

**Why.** Homebrew Bundle's upgrade covers casks as well as formulae, whatever `greedy` says, and
upgrading a cask replaces the `.app` and quits the running program. A reconcile that closes your
browser is not a reconcile: reconciling answers "is what I declared installed?", never "is what is
installed current?". The flag also never reached mise. Both upgrades already exist as each tool's
own verb, with the blast radius that tool defines.

The flag is **not** accepted-and-ignored: `boom source --update` fails to parse
(`No flag registered for --update`) rather than running and quietly doing something else. A
retired config key is worth accepting for a release; a retired flag typed by hand is better off
failing loudly.

### `HookApi` loses `update`

With the flag gone the field could only ever be `false`. If a hook branches on `api.update`,
delete the branch. Everything else in `HookApi` is untouched.

### Unchanged

Cask installation, its sudo escalation and `SUDO_PROMPT` labelling, `brew bundle cleanup`
reporting, and `brew bundle check` on `verify`. Drift is still "declared and not installed"; a
merely outdated package was never drift.

---

## 0.37.0

One removal. If your boomfile declares no `secret` entries, there is nothing to do.

### Removed: the `secret` resource

`secret = [{ dst, ref | template, mode?, backend? }]` resolved a vault reference and wrote the
plaintext to a file at sync time. The resource, its backends and `boom doctor --secrets` are gone.

**Why.** Writing a secret to a file is writing a secret somebody can read. boom's own reference
consumer forbids exactly that, and after five releases nothing had ever declared one. It was also
the single largest source of subtlety in the composer: one of two kinds that could *win* a
destination without *owning* it.

**Instead.** Resolve at point of use: `op run --env-file=.env.op -- your-command`. For a tool that
genuinely requires a file, render it from a `run` step you own, so the write is explicit:

```toml
[[section.run]]
on = "sync"
cmd = 'op inject -i templates/gh-token.tmpl -o ~/.config/gh/token && chmod 600 ~/.config/gh/token'
```

### The key still parses, and `verify` exits 2 until you delete it

A boomfile carrying `secret = […]` still loads; the entry is accepted and ignored, like `schedule`
and `[boom].sudo_askpass`. It is not silent: every verb warns once with a **count, never the
paths**. The warning lands in verify's attention tier, so `boom verify` returns `2` while a
retired declaration remains. `boom source` and `boom verify --ci` are unaffected.

Anything boom previously rendered is left where it is. Secrets were never in the owned
manifest, so orphan reaping has no claim on them. Delete those files yourself.

### Removed: `boom doctor --secrets`

`boom doctor` still checks for the 1Password service-account token in the keychain, and no
longer gates that check on declared secrets. Presence is the whole signal.

---

## 0.36.0

One removal, and one setting value that now means something slightly different.

### Removed: `boom upgrade`

The verb that downloaded a newer release and rewrote the running binary in place is gone, along
with `--check`.

**Why.** A self-replacing binary and a package manager cannot both own the same file. `boom
upgrade` writing into a brew-managed prefix desynchronises brew's manifest from what is on disk,
and the next `brew upgrade` silently reverts to whatever the formula pins.

**Instead.** Upgrade boom the way you installed it:

```sh
brew upgrade alxjrvs/boom/boom      # the name must be qualified; bare `boom` is an unrelated cask
curl -fsSL .../install.sh | sh      # the curl-pipe bootstrap, re-run
```

`install.sh` still verifies the download against the release's `SHA256SUMS` and refuses to
install unverified.

### `upgrade_on_sync = "auto"` is retired, and still accepted

`"auto"` called `boom upgrade`, so it goes with it. A boomfile carrying it still loads and now
behaves exactly like `"check"`: after a sync, boom prints a one-line notice when a newer release is
available, and says once that `"auto"` was treated as `"check"`. Change it at your leisure.

---

## 0.35.0

One removal. If your boomfile has no `[[section.check]]`, there is nothing to do.

### Removed: the `check` resource

Gone with its `json` and `cmd` assertions, `repair`, `missing_file`, and the `present`/`absent`
regex pair. A boomfile declaring one fails to load with `check` as an unknown key.

**Why.** No consumer, and a footgun: a `cmd` check ran arbitrary shell during `verify`, a verb
documented as read-only and enforced by nothing.

**Instead.** A verify-time `run` step, which reports through the same drift exit code and honours
`timeout`, `unless` and `creates`:

```toml
[[section.run]]
on = "verify"
cmd = "grep -q 'op-agent' ~/.claude/settings.json || { echo 'cached-PAT regression'; exit 1; }"
```

For "this path must not exist", `absent` is unchanged.

---

## 0.34.0

No migration was written for this release.

---

## 0.33.0

Removes the four `boom source` subcommands that wrapped git. Nothing in your boomfile changes.

### Removed: `boom source status|diff|push|reset`

Run git against the managed clone directly. `boom doctor` prints its path; below it is `<dir>`.

| Removed | Native equivalent |
| --- | --- |
| `boom source status` | `git -C <dir> status -sb` |
| `boom source diff` | `git -C <dir> diff HEAD` |
| `boom source reset` | `git -C <dir> reset --hard origin/<branch>` |
| `boom source push` | `git -C <dir> commit -am "…" && git -C <dir> push`, then `gh pr create` |

`reset` also ran `git clean -fd` and refused to discard unpublished commits without `--force`;
both are yours to decide now. `push` published `HEAD` as `boom/<slug>-<sha>` without checking the
branch out; that is `git -C <dir> push origin HEAD:refs/heads/<branch>` then `gh pr create`.

**Why.** A second, weaker spelling of commands the user already has, at the cost of ~730 lines
and a `gh` dependency in the engine. Deleting a wrapper for a built-in is the highest-value change
boom can make.

**Not gone.** Drift reporting: `boom verify` still reports commits behind origin, unpushed local
commits and an uncommitted tree, and `boom source set` still refuses to re-clone over
uncommitted or unpushed work.

### Removed: the pre-sqlite manifest import

`readManifest` no longer falls back to the legacy TSV at `~/.local/state/boom/manifest`. It only
mattered for a machine upgrading from a pre-0.4.0 boom that had not synced since. The symptom is
silent: boom forgets which destinations it owns, so orphan reaping stops. One `boom source`
rebuilds the manifest and restores reaping.

---

## 0.32.0

Removes three resource-level surfaces that had no user. Unlike 0.31 these **are load-time
errors**: `boom verify`, `boom doctor --config` and `boom source` all fail until the file is fixed.

### Removed: `systemd`

A `[[section.systemd]]` entry is now an unknown key. There is no in-boom replacement: write the
unit yourself, place it with `copy` or `link`, and enable it with a `run` step.

### Removed: seven package managers (`brew`, `mise`, `gh` remain)

`apt`, `dnf`, `cargo`, `npm`, `pipx`, `gem` and `flatpak` are gone from the `manager` picklist.
The replacement is what these arms were, a shell-out with a presence check:

```toml
run = [{ cmd = "cargo install ripgrep", unless = "command -v rg" }]
```

### Removed: three secret backends (`op` and `env` remained, until 0.37)

`pass`, `age` and `sops` are gone from the `backend` picklist.

**Why.** Each was a working feature with no user. boom's only consumer is a single macOS machine
installing through `brew`, `mise` and `gh`. This is a bet rather than a cleanup: if a Linux box
ever appears, it is a revert and not a rewrite.

---

## 0.31.0

Ten verbs are gone and one `[boom]` key is retired. No boomfile edit is required, but scripts,
agents and launchd timers that invoke a removed verb will break, and one breaks quietly.

### ⚠️ If your boomfile has `[boom] schedule`, unload its timers by hand

`schedule` generated `com.boomtube.*` LaunchAgents and reaped them when you removed an entry.
The generator is gone, **and so is the reaper**. Timers a previous version installed stay loaded
and keep firing. Check and clear them:

```sh
launchctl list | grep com.boomtube
launchctl bootout gui/$(id -u)/com.boomtube.<name>
rm ~/Library/LaunchAgents/com.boomtube.<name>.plist
```

To keep running boom on a timer, author a plist and let the `launchd` resource own it. The key
itself is still accepted, parsed and ignored, so a boomfile carrying it does not fail to load.

### Removed: ten commands

| Gone | Reach for |
| --- | --- |
| `code` (`init`/`claude`/`cmux`/`fetch`/`reap`) | — |
| `status` | `verify` for the machine |
| `where` | the paths directly: config repo at `~/.local/state/boom/config-repo` |
| `lock` | — |
| `rollback`, `checkpoint` | — (see below) |
| `plan` | `source --dry-run` |
| `edit` | `$EDITOR ~/.local/state/boom/config-repo` |
| `mcp` | your client's own MCP registration |
| `completions`, `man` | `boom --help` |

Shell completions installed from a previous `boom completions` still exist on disk and will
suggest verbs that no longer route. Delete them.

### `boom verify` no longer audits package drift

`lock` is gone and so is the audit: verify reports whether the machine matches the boomfile,
validity, not whether a resolved package moved underneath you. An existing `boom.lock` is inert.
Delete it.

### There is no undo verb, but originals are still preserved

`boom rollback` is gone. The journal is not: `displace()` still moves an existing file into
`backups/<run-id>/` before an overwrite, and `--resume` still reads the last uncommitted run.
What changed is that nothing replays it for you; recovery from a bad sync is a manual copy out
of that tree.

### A failing `run` step reports everything it printed

All output is reported, indented, and stdout is captured too. Package managers are unchanged:
brew and mise failures still report a one-line tail.

---

## 0.30.0

The module system (`use = [...]` and shared modules) was removed. `use` is not a key the
boomfile schema accepts; a boomfile carrying one fails to load with an unknown-key error.

---

## 0.23.0

The release where boom stopped claiming things it hadn't done. Much of what it introduced was
later removed (see 0.30, 0.31 and 0.37 above); this entry records only what still holds.

### Removed: `copy.expand`, in favour of `tmpl`

`copy` places bytes; `tmpl` renders. `tmpl` interpolates `${env:VAR}`, `${host}`, `${os}` and
`${NAME}` from the top-level `[vars]` table, and an unknown `${NAME}` is a hard failure rather
than a dangling write.

```toml
[vars]
email = "you@example.com"

[[section]]
name = "Git"
tmpl = [{ src = "gitconfig", dst = "~/.gitconfig" }]
```

### `remove_on_uninstall` on a `brew`/`mise` `pkg` entry is a load error

Neither manager has a "remove exactly what this file declares" verb, so boom refuses the key and
points at the honest alternative:

```toml
run = [{ on = "uninstall", cmd = "brew bundle cleanup --file Brewfile --force" }]
```

### A `**` glob links per-file only, and never into the config repo

A `src` pattern matching both a directory and its descendants links the descendants only, and
any placement whose destination resolves inside the config repo is a hard failure. `src = "dir/*"`
still links a matched subdirectory whole.

### `boom uninstall` puts macOS defaults back

`osx_default` uninstall restores the **first** journaled prior, the value the machine had before
boom ever touched the key, or deletes a key boom introduced. When no record survives journal
retention it skips the key and says so. `boom uninstall` may therefore restart
Dock/Finder/SystemUIServer.

### Mutating verbs take the run lock

An overlapping run fails fast and cleanly:

```
another boom run is in progress (pid 12345) — wait for it to finish, or remove <path> if it crashed
```

### Duplicate destinations are last-wins

When two layers declare the same expanded `dst`, the last one wins and the loser is dropped at
compose time. Only sections that apply to this run participate.

### Added

- `run.unless` / `run.creates` idempotence guards.
- List-valued `when`: any-of within an axis, AND across axes.
- `pkg manager = "gh"` for `gh` CLI extensions, one owner-qualified `owner/repo` per line.
- `pkg.remove_on_uninstall`, per entry.
- First-class hooks: run context, the same output tiers a core resource uses, `declare()` to
  put a destination in the owned manifest.
- `[vars]`-only and `[boom]`-only overlays.
- A hook with no `verify` export prints an `unchecked` note on `boom verify`.
- `boom source --dry-run` evaluates `run.creates` but never executes `run.unless`.
