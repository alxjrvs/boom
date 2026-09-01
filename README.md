# BoomTube

**BoomTube** is **declarative dev-machine setup** — it converges your machine
to a state you declare once: dotfiles, packages, and tools from a single
`boomfile.toml`, with drift detection. Its executable, **`boom`**,
runs the reconcile loop — `sync` / `verify` — journaling every change it makes so
`uninstall` can tear it back down. One self-contained binary, compiled from
**TypeScript on [Bun](https://bun.com)**, with zero runtime dependencies on your
machine.

Named for Jack Kirby's **Boom Tube** (the Fourth World portal): boom opens a
portal to your machine's ideal state.

📐 Design of record → [`SPEC.md`](SPEC.md)

> Status: **early** — a TypeScript rewrite of the original bash engine, extracted
> from [`alxjrvs/dotFiles`](https://github.com/alxjrvs/dotFiles).

## Install

```sh
# curl installer — downloads the binary for your platform, puts `boom` on PATH
curl -fsSL https://raw.githubusercontent.com/alxjrvs/boom/main/install.sh | sh

# …or Homebrew (this repo doubles as the tap). The formula name must be
# FULLY QUALIFIED: bare `boom` resolves to an unrelated homebrew-cask entry,
# and brew will happily report it "already installed" while this one is absent.
brew tap alxjrvs/boom https://github.com/alxjrvs/boom
brew install alxjrvs/boom/boom
```

In a Brewfile the same two hazards need spelling out, or `brew bundle` stops
half way on a fresh machine — brew refuses to load a formula from a
third-party tap until it is trusted:

```ruby
tap "alxjrvs/boom", "https://github.com/alxjrvs/boom", trusted: { formula: "boom" }
brew "alxjrvs/boom/boom"
```

One self-contained executable (macOS arm64/x64, Linux x64); the binary embeds the
Bun runtime, so nothing else is required. Override the install prefix with
`BOOM_PREFIX`.

## Bootstrap a machine

```sh
boom source set alxjrvs/dotfiles   # clone your remote dotfiles repo and sync it — one-shot bootstrap
boom source                        # thereafter: reconcile from the recorded config repo
```

`boom source set` takes a **remote reference** — `owner/repo`, `github:owner/repo`, a
git URL, optionally `@ref` — never an arbitrary local path. boom clones it into a
managed cache dir, records a breadcrumb, and syncs it. Pass `--no-sync` to clone and
record only — to review before reconciling, or to re-point at a different repo. The
fresh-machine one-liner is `curl install.sh | sh && boom source set owner/repo`.

## The reconcile loop

`sync` / `verify` / `uninstall` are **one verb-parameterized loop** over
a resource registry — siblings, not separate scripts. Repairing drift is not a
separate verb: it's `boom source --fix` (sync, but overwriting conflicts).

```sh
boom source             # make it so: symlink / copy / install / run from boomfile.toml
boom source --fix       # repair drift: overwrite conflicting targets (skipped by default)
boom source --commit    # commit local config-repo edits before pulling
boom source --resume    # continue an interrupted sync (skips completed steps)

boom verify             # check for drift — exit 0 ok / 2 warn / 1 fail
boom verify --json      # …as a structured drift report
boom verify --ci        # non-interactive config gate for CI (schema-check only; exit 0/1)
```

**No verb upgrades.** Reconciling is "what is declared is installed", never "what is installed
is current" — `brew bundle` always runs `--no-upgrade`, on every verb. Homebrew Bundle's upgrade
reaches casks whatever `greedy` says, and upgrading a cask replaces the `.app`, so it quits the
running program: a reconcile that closes your browser is not a reconcile. Upgrading is each
tool's own verb — `brew upgrade --formula`, `mise upgrade` — with the blast radius that tool
defines. `boom source --update` did this and was removed in 0.38
([migration](docs/MIGRATING-0.38.md)).

A shippable GitHub Action wrapping `verify --ci` lives in
[`examples/github-action/`](examples/github-action/) so a config repo can gate its own PRs.

`verify` reports whether the machine matches the boomfile. It does **not** audit package
versions against a lockfile — validity, not drift in what brew or mise resolved.

`sync` syncs the config repo against its remote first (`pull --rebase
--autostash`, so local edits ride along and land back on top). `verify` reports
"N commits behind" as drift — plus separate warnings for uncommitted or unpushed
local changes — without touching the working tree. A failed pull is *reported* but
never blocks reconciling from the last-known-good local clone. A conflicting
(non-boom-owned) file at a `link` destination is **skipped by default** (boom
never clobbers a file it doesn't own); pass `--fix` to overwrite it and repair
the drift.

### Config-repo git is just git

boom clones your config repo into a managed cache dir and reconciles from it. Operating
that clone is git's job, not boom's — `boom doctor` prints the path, and `git -C <dir> …`
does the rest. The `boom source status|diff|push|reset` wrappers were removed in 0.33
(see [docs/MIGRATING-0.33.md](docs/MIGRATING-0.33.md)); boom still *reports* config-repo
drift, because `verify` has to.

### Publishing local edits back

Editing a symlinked dotfile edits the clone's working tree, so boom already *sees* it: `verify`
reports "uncommitted local changes", then "local commit(s) not pushed to origin" once you commit
(pair it with `[boom] notify = true` and a scheduled `verify` to be told rather than to remember).

Getting it onto the remote is a **user command** — a name boom doesn't own resolves to
`<config>/commands/<name>.ts` in your config repo and runs as `(args, ctx) => number`. A worked one
ships in [`examples/dotfiles/commands/publish.ts`](examples/dotfiles/commands/publish.ts): copy it
to `commands/publish.ts` in your dotfiles repo and it is `boom publish`.

```sh
boom publish -m "zsh: add the fzf keybinding"   # commit, push a branch, open the PR
boom publish --no-pr                            # …just the branch
boom publish                                    # no local edits: realign after a merged PR
```

Two things it does that a hand-rolled `git push` gets wrong:

- **It never checks the branch out.** The clone *is* your live config — every symlink points into
  its working tree, so `git checkout -b` swaps `~/.zshrc` and everything else under you. It pushes
  `HEAD:refs/heads/<branch>` instead: the remote gets a branch, the working tree never moves.
- **It realigns once the PR lands.** A squash merge rewrites your commit, so the next
  `git pull --rebase` replays a patch that is already upstream and stops on a conflict — that is
  `boom source` failing on every run until someone untangles it by hand. Publish resets onto the
  upstream branch when, for every file its local-only commits touched, upstream's content already
  matches HEAD's — a reset that cannot lose a byte — and leaves anything else alone for you. That
  needs a clean tree, so it happens on the run *after* the merge: publish once when the PR lands and
  the next round of edits starts level.

### Housekeeping

```sh
boom doctor --config    # parse + schema-check the boomfile; change nothing (exit 0/1)
boom doctor             # check boom's own preconditions (tools, keychain, state)
boom doctor --fix       # …and mend the safe ones (state dir, boom skill)
boom skill              # emit a Claude Code SKILL.md (--install writes it to ~/.claude)
```

## The `boomfile.toml`

Your dotfiles repo's config is a typed, validated TOML document, grouped into
sections that run in phase order
(`link → copy → tmpl → dir → pkg → osx_default → launchd → run → hook`):

```toml
# Optional: named values `tmpl` templates interpolate as ${NAME} (per-machine via overlays).
[vars]
git_email = "me@example.com"

[[section]]
name = "Shell + git"
link = [
  { src = ".zshrc",     dst = "~/.zshrc" },
  { src = "ssh/config", dst = "~/.ssh/config", mode = "600" },
  { src = "zsh/*.zsh",  dst = "~/.config/zsh/" },   # a glob src fans out into the dst dir
]
dir  = [{ path = "~/.ssh/cm", mode = "700" }]       # ensure a directory exists (no file to place)
# Render a template with the [vars] above (${NAME}) — a superset of an overlay-per-machine.
tmpl = [{ src = "gitconfig.tmpl", dst = "~/.gitconfig" }]

[[section]]
name = "Packages"
# `remove_on_uninstall` picks what `boom uninstall` reclaims, per entry: omit it for today's
# behavior (user-scoped managers remove what they installed, apt/dnf never do), `= true` to opt
# apt/dnf in, `= false` to keep a global boom installed. Rejected on brew/mise.
pkg = [
  { manager = "brew", file = "Brewfile" },          # brew bundle over the Brewfile
  { manager = "mise" },                             # mise install (reads the repo's mise config)
  { manager = "cargo", file = "cargo.txt" },        # also: apt, dnf, npm (-g), pipx, gem, flatpak, gh (extensions)
  { manager = "apt", file = "apt.txt", remove_on_uninstall = true },
]

[[section]]
name = "macOS only"
when = { os = "darwin" }          # gate by os / host / profile (each takes a list too)
osx_default = [{ domain = "com.apple.dock", key = "autohide", value = true }]
launchd = [{ src = "launchd/com.me.agent.plist" }]   # link + launchctl load -w, idempotent

[[section]]
name = "Linux services"
when = { os = "linux" }
# A generated systemd *user* unit (the Linux twin of launchd) + an optional OnCalendar timer.
systemd = [{ name = "nightly-backup", exec = "/usr/local/bin/backup", timer = "daily" }]

[[section]]
name = "Guardrails"
# A path that must NOT exist: a path that must NOT exist. Sync removes it (into the backup tree, so
# it is recoverable from the run's backup tree), verify fails while it is there. For files a tool re-creates
# behind your back — an agent writing settings.local.json on an "always allow" click.
absent = [{ path = "~/.claude/settings.local.json", message = "machine-local override" }]

[[section]]
name = "Custom"
hook = [{ name = "op-agent", with = { vault = "claude-agent" } }]   # → hooks/op-agent.ts
```

Imperative escapes are `run` steps (a shell command) or a **hook** — a
`hooks/<name>.ts` module exporting `sync`/`verify`/`uninstall` that receives a typed
`HookApi`. That's the extension point for anything the declarative resources can't
express. Multi-machine setups gate sections with `when` or layer overlay files
(`boomfile.<os|host|profile>.toml`). An overlay may carry `[vars]` and `[boom]` as well as
sections — they merge over the base last-wins per key, and a `[vars]`-only overlay is the
lightest way to differentiate a machine. One thing to know: a last-wins merge on an array key
**replaces** rather than appends. When two layers declare the same destination, the **last one
wins** and the other is dropped before the run (reported as a note), instead of a losing link
surfacing as a verify failure nothing could ever converge.

A top-level `[boom]` table folds boom's own self-wiring into the reconcile — refresh the
Claude skill, nudge when a newer boom ships, and desktop-notify on drift — so
you stop hand-rolling those as `run` boilerplate:

```toml
[boom]
skill_on_sync   = true            # regenerate ~/.claude/skills/boom/SKILL.md each sync
upgrade_on_sync = "check"         # warn on a newer release; upgrade it the way you installed it
notify          = true            # desktop-notify when `boom verify` finds drift
```


boom also tells you *what* is asking, since a bare `Password:` mid-run is indistinguishable from
any other program on the machine deciding it wants one:

```
  ◇ brew bundle… (may ask for your password)
    ▸ Upgrading cask tuple
[boom] brew bundle needs administrator rights — password for jarvis:
```

The prompt line itself comes from `SUDO_PROMPT`; the specific cask comes from relaying Homebrew's
own `==>` headlines (sudo's prompt escapes can't name a command, so the tool's output has to).


## Security model

boom reconciles from a git remote **you** point it at, and a boomfile's `run` steps and
`hook` modules are executed as your user during `sync`. Sync pulls the config
repo *before* running those steps, so **anyone who can push to your config remote can run
arbitrary code on your machine on the next sync** — treat write access to that repo as
equivalent to shell access. Pin to a tag or SHA (`boom source set owner/repo@v1.2.3`) if
you want a fixed, reviewed state instead of tracking a moving branch. boom does no
credential handling of its own: git/SSH auth is whatever already works in your shell.
Downloaded release binaries are checksum-verified against the release's `SHA256SUMS`
(`install.sh`). Verification is not best-effort: if the manifest
can't be fetched, has no entry for the asset, doesn't match, or no `sha256sum`/`shasum` is
available, the install **fails** rather than proceeding unverified. `BOOM_SKIP_VERIFY=1`
is the single explicit opt-out.

## Develop

```sh
make check   # biome (lint + format) + tsc --noEmit + bun test  (what CI runs)
make test    # just the bun test suite
make build   # compile a standalone binary for the host → build/boom
make fmt     # biome autofix + format
```

Built with [`@stricli/core`](https://github.com/bloomberg/stricli) (CLI),
[valibot](https://valibot.dev) over Bun's own TOML parser (config), and Bun's
`--compile`. Tests sandbox a throwaway `$HOME` + `$XDG_STATE_HOME`, so they
never touch the real machine.
