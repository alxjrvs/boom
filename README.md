# BoomTube

**BoomTube** is **declarative dev-machine setup** — it converges your machine
to a state you declare once: dotfiles, packages, and tools from a single
`boomfile.toml`, with drift detection and rollback. Its executable, **`boom`**,
runs the reconcile loop — `sync` / `verify` — journals every change so it can be
rolled back, then gets out of your way and opens portals to your code. One
self-contained binary, compiled from **TypeScript on [Bun](https://bun.com)**,
with zero runtime dependencies on your machine.

Named for Jack Kirby's **Boom Tube** (the Fourth World portal): boom opens a
portal to your machine's ideal state, and to your code.

📖 **Docs site → [alxjrvs.github.io/boom](https://alxjrvs.github.io/boom/)**  ·
📐 Design of record → [`SPEC.md`](SPEC.md)

> Status: **early** — a TypeScript rewrite of the original bash engine, extracted
> from [`alxjrvs/dotFiles`](https://github.com/alxjrvs/dotFiles).

## Install

```sh
# curl installer — downloads the binary for your platform, puts `boom` on PATH
curl -fsSL https://raw.githubusercontent.com/alxjrvs/boom/main/install.sh | sh

# …or Homebrew (this repo doubles as the tap)
brew tap alxjrvs/boom https://github.com/alxjrvs/boom
brew install boom
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

Starting from an already-configured machine instead? `boom adopt` reverse-engineers a
reviewable `boomfile.toml` proposal — capturing your Homebrew/mise/apt packages and
common dotfiles — that you turn into your config repo. Migrating off another manager?
`boom adopt --from chezmoi|stow|yadm|dotbot|nix-darwin` translates its layout into that
proposal.

Greenfield — no dotfiles repo at all yet? `boom init [owner/repo]` runs the whole cold
start in one shot: `adopt` to scaffold the proposal, `git init` + commit, create the remote
(via `gh`), push, and record the breadcrumb — leaving you on a live, boom-managed config
repo. `--dry-run` previews every step and changes nothing; `--no-push` stops before touching
a remote.

## The reconcile loop

`sync` / `verify` / `uninstall` are **one verb-parameterized loop** over
a resource registry — siblings, not separate scripts. Repairing drift is not a
separate verb: it's `boom source --fix` (sync, but overwriting conflicts).

```sh
boom source             # make it so: symlink / copy / install / run from boomfile.toml
boom plan               # preview every change as a read-only plan (--fix previews drift repair)
boom source --fix       # repair drift: overwrite conflicting targets (skipped by default)
boom source --update    # also update outdated brewfile formulae, not just declared state
boom source --commit    # commit local config-repo edits before pulling
boom source --resume    # continue an interrupted sync (skips completed steps)

boom verify             # check for drift — exit 0 ok / 2 warn / 1 fail
boom verify --json      # …as a structured drift report
boom verify --ci        # non-interactive config gate for CI (schema-check only; exit 0/1)
boom status             # one-screen dashboard: config, repo drift, last sync, lock, secrets
boom rollback           # undo the most recent sync (restores backed-up files)
boom checkpoint <name>  # name the current state; boom rollback --to <name> returns to it
```

`boom status` composes the cheap health signals every other command already owns into a
single glance — read-only, no machine walk. A shippable GitHub Action wrapping `verify --ci`
lives in [`examples/github-action/`](examples/github-action/) so a config repo can gate its
own PRs.

`sync` syncs the config repo against its remote first (`pull --rebase
--autostash`, so local edits ride along and land back on top). `verify` reports
"N commits behind" as drift — plus separate warnings for uncommitted or unpushed
local changes — without touching the working tree. A failed pull is *reported* but
never blocks reconciling from the last-known-good local clone. A conflicting
(non-boom-owned) file at a `link` destination is **skipped by default** (boom
never clobbers a file it doesn't own); pass `--fix` to overwrite it and repair
the drift.

### Config-repo git, without leaving boom

`boom source` operates the managed config-repo clone (the source your machine is
reconciled from) without cd-ing into the cache dir it lives in:

```sh
boom source diff          # show uncommitted local changes in the config repo
boom source push          # commit local changes and open a PR for them
boom source push --merge  # …and let GitHub land it once its checks pass
boom source push --direct # …or skip the PR and push the branch straight up
boom source reset         # discard local changes, reset to origin
boom source reset --force # …including commits no remote has (refused otherwise)
```

### Housekeeping

```sh
boom adopt              # reverse-engineer a boomfile.toml proposal from this machine
boom edit               # open the boomfile in $EDITOR, validate on save, then push
boom doctor --config    # parse + schema-check the boomfile; change nothing (exit 0/1)
boom doctor             # check boom's own preconditions (tools, keychain, state)
boom doctor --fix       # …and mend the safe ones (state dir, boom skill)
boom doctor --secrets   # audit that every secret ref (op:// and pluggable backends) resolves
boom lock               # pin resolved package versions to boom.lock (--check reports drift)
boom module             # list `use` modules; module add <ref> splices one into your boomfile
boom where config|code|engine   # resolve where boom keeps things
boom upgrade            # upgrade the boom binary itself
boom completions bash|zsh|fish  # shell completions
boom man                # the man page
boom skill              # emit a Claude Code SKILL.md (--install writes it to ~/.claude)
```

Registering an MCP server the 1Password-native way is `boom mcp add <name> -- <server
cmd>` (it wraps the server in `op run --env-file` so secrets resolve from `op://` refs).

## The `boomfile.toml`

Your dotfiles repo's config is a typed, validated TOML document, grouped into
sections that run in phase order
(`link → copy → tmpl → secret → dir → pkg → osx_default → launchd → systemd → run → check → hook`):

```toml
# Optional: compose shared sections from other boom repos before your own (a git
# remote, or a path relative to this repo). `boom module add <ref>` splices one in;
# a module may itself `use` further modules — they compose recursively (cycles are broken).
# A module's paths resolve against the module's own directory, so a module ships its dotfiles.
# `use` belongs here, in the base file — it is rejected in an overlay (see below).
use = ["myorg/boom-base", "./modules/node-dev"]

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
name = "Secrets"
# Render a secret to a 0600 file at sync time — never journaled in plaintext. The backend is
# inferred from the ref scheme (op://, env:, pass:, *.age, *.sops) or set with `backend = …`.
# A pre-existing file at `dst` is left alone (skipped) unless you run `boom source --fix`.
secret = [{ dst = "~/.config/gh/token", ref = "op://Private/GitHub/token" }]

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
# Verify-time content assertions — legible where a grep-in-a-run would be escaping-heavy.
check = [{ path = "~/.claude/settings.json", absent = ["osxkeychain"], message = "cached-PAT regression" }]
# And the inverse: a path that must NOT exist. Sync removes it (into the backup tree, so
# `boom rollback` restores it), verify fails while it is there. For files a tool re-creates
# behind your back — an agent writing settings.local.json on an "always allow" click.
absent = [{ path = "~/.claude/settings.local.json", message = "machine-local override" }]

[[section]]
name = "Custom"
hook = [{ name = "op-agent", with = { vault = "claude-agent" } }]   # → hooks/op-agent.ts
```

Imperative escapes are `run` steps (a shell command) or a **hook** — a
`hooks/<name>.ts` module exporting `sync`/`verify`/`uninstall` that receives a typed
`HookApi`. That's the extension point for anything the declarative resources can't
express. Multi-machine setups gate sections with `when`, layer overlay files
(`boomfile.<os|host|profile>.toml`), or compose shared `use` modules. An overlay may carry
`[vars]` and `[boom]` as well as sections — they merge over the base last-wins per key, and a
`[vars]`-only overlay is the lightest way to differentiate a machine. Two things to know: a
a last-wins merge on an array key **replaces** rather than appends,
and `use` in an overlay is an error — modules compose *before* your own sections, so declaring
one in the file that loads *last* would invert that; put it in `boomfile.toml`. When two layers
declare the same destination, the **last one wins** and the other is dropped before the run
(reported as a note) — so overriding a module's `link` is just re-declaring the `dst` in your own
repo, instead of a losing link surfacing as a verify failure nothing could ever converge.

A top-level `[boom]` table folds boom's own self-wiring into the reconcile — refresh the
Claude skill, nudge/auto-upgrade when a newer boom ships, and desktop-notify on drift — so
you stop hand-rolling those as `run` boilerplate:

```toml
[boom]
skill_on_sync   = true            # regenerate ~/.claude/skills/boom/SKILL.md each sync
upgrade_on_sync = "check"         # "check" warns on a newer release; "auto" self-upgrades
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
(both `install.sh` and `boom upgrade`). Verification is not best-effort: if the manifest
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
