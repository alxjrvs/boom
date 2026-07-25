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
boom status             # one-screen dashboard: config, repo drift, last sync, fleet, lock, secrets
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
boom source push          # commit local changes and push them upstream
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
boom fleet              # every machine's last-sync summary; fleet drift | diff <a> <b> for more
boom module             # list `use` modules; module search <term> | add <name> for the registry
boom where config|code|engine   # resolve where boom keeps things
boom upgrade            # upgrade the boom binary itself
boom askpass <ref>      # resolve a secret ref to stdout (the SUDO_ASKPASS helper; see [boom])
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
# Optional: compose shared, vetted sections from other boom repos before your own (a git
# remote, or a path relative to this repo). `boom module search|add` browse a curated registry;
# a module may itself `use` further modules — they compose recursively (cycles are broken).
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
pkg = [
  { manager = "brew", file = "Brewfile" },          # brew bundle over the Brewfile
  { manager = "mise" },                             # mise install (reads the repo's mise config)
  { manager = "cargo", file = "cargo.txt" },        # also: apt, dnf, npm (-g), pipx, gem, flatpak
]

[[section]]
name = "Secrets"
# Render a secret to a 0600 file at sync time — never journaled in plaintext. The backend is
# inferred from the ref scheme (op://, env:, pass:, *.age, *.sops) or set with `backend = …`.
secret = [{ dst = "~/.config/gh/token", ref = "op://Private/GitHub/token" }]

[[section]]
name = "macOS only"
when = { os = "darwin" }          # gate by os / host / profile
osx_default = [{ domain = "com.apple.dock", key = "autohide", value = true }]
launchd = [{ src = "launchd/com.me.agent.plist" }]   # link + launchctl load -w, idempotent

[[section]]
name = "Linux services"
when = { os = "linux" }
# A generated systemd *user* unit (the Linux twin of launchd) + an optional OnCalendar timer.
systemd = [{ name = "sync-code", exec = "boom code fetch", timer = "hourly" }]

[[section]]
name = "Guardrails"
# Verify-time content assertions — legible where a grep-in-a-run would be escaping-heavy.
check = [{ path = "~/.claude/settings.json", absent = ["osxkeychain"], message = "cached-PAT regression" }]

[[section]]
name = "Custom"
hook = [{ name = "op-agent", with = { vault = "claude-agent" } }]   # → hooks/op-agent.ts
```

Imperative escapes are `run` steps (a shell command) or a **hook** — a
`hooks/<name>.ts` module exporting `sync`/`verify`/`uninstall` that receives a typed
`HookApi`. That's the extension point for anything the declarative resources can't
express. Multi-machine setups gate sections with `when`, layer overlay files
(`boomfile.<os|host|profile>.toml`), or compose shared `use` modules.

A top-level `[boom]` table folds boom's own self-wiring into the reconcile — refresh the
Claude skill, nudge/auto-upgrade when a newer boom ships, record a fleet summary,
desktop-notify on drift, answer a tool's `sudo` prompt from the vault, and manage scheduled
`boom` launchd timers (macOS) — so you stop hand-rolling those as `run`/plist boilerplate:

```toml
[boom]
skill_on_sync   = true            # regenerate ~/.claude/skills/boom/SKILL.md each sync
upgrade_on_sync = "check"         # "check" warns on a newer release; "auto" self-upgrades
fleet           = true            # record this machine's summary into the repo for `boom fleet`
notify          = true            # desktop-notify when a scheduled `boom verify` finds drift
sudo_askpass    = "op://Private/Mac/password"   # answer a tool's sudo prompt from the vault
schedule = [
  { cmd = "verify",     every = "15m" },   # launchd timer: boom verify every 15m (macOS)
  { cmd = "code fetch", every = "15m" },   # keep every code repo's origin warm for agents
]
```

`sudo_askpass` is about `boom source --update`, where Homebrew shells out to `sudo` for any cask
with a `launchctl`/`pkgutil` stanza. **By default boom simply lets it ask you** — a step that can
escalate runs under a persistent label rather than the animated spinner, because the spinner
redrawing that line 11×/second was the one and only reason the prompt ever went missing (sudo
writes it to `/dev/tty`, which silencing stdout does not touch). Answer it and the sync continues.

boom also tells you *what* is asking, since a bare `Password:` mid-run is indistinguishable from
any other program on the machine deciding it wants one:

```
  ◇ brew bundle… (may ask for your password)
    ▸ Upgrading cask tuple
[boom] brew bundle needs administrator rights — password for jarvis:
```

The prompt line itself comes from `SUDO_PROMPT`; the specific cask comes from relaying Homebrew's
own `==>` headlines (sudo's prompt escapes can't name a command, so the tool's output has to).

Set `sudo_askpass` for the case where nobody is *there* to answer — an unattended sync from a
launchd timer or CI, where a visible prompt is still an indefinite block. Point it at any secret
reference (`op://…`, `env:VAR`, `pass:…` — the same vocabulary and backends as the `secret`
resource) and boom hands spawned tools a `SUDO_ASKPASS` helper that resolves it on demand. The
reference is what lands on disk; the password only ever exists in the pipe between the helper and
`sudo`. Note that the `op` backend needs your unlocked 1Password session, so for a genuinely
headless run use a backend that doesn't (`env:`).

## Code portals

`boom code` opens portals to the repos under your code dir (default `~/Code`):

```sh
boom code init ~/Code    # record your code dir
boom code claude         # symlink every repo into one dir, open `claude agents` there
boom code cmux           # one cmux workspace per repo
boom code fetch          # git fetch every repo (keep origin warm for agent worktrees)
boom code reap           # remove spent agent worktrees (keeps every branch)
boom code reap -i        # ...and ask what to do with the ones it won't touch
```

`code claude` flattens every repo into a symlink farm so each is `@`-taggable for
agent dispatch even with no running agents; `code cmux` opens one workspace per
repo. All honor `--dry-run` and only spawn the backend tool when it's present.

`code reap` cleans up after agent worktrees. Claude Code refuses to remove a
worktree whose HEAD commits exist on no remote — but it tests *SHA* identity, so a
squash-merged branch always fails it: the content landed on the default branch under
a new SHA, and the branch's own commits genuinely exist nowhere by SHA even though
every line of them is merged. Worktrees therefore pile up and sessions can't be
closed. `reap` re-asks the question by **content**, using git's patch-id equivalence,
and removes a worktree only when it is clean, unlocked (or locked by a dead process),
and either fully pushed or already merged. It deletes the directory and never the
branch ref, so nothing it does can lose a commit.

Its default answer is *keep* — anything it cannot prove safe stays exactly where it
is, and a removal failure is a warning rather than an error, so a scheduled sweep
can never wedge. `--dry-run` classifies without touching anything.

A killed session leaves its worktree *locked*, and git won't remove a locked tree even
under `--force`. When the lock names a process that is no longer alive, `reap` clears
the stale lock and reclaims the worktree; a lock whose holder is still running is left
strictly alone. Removal failures report git's own reason rather than a generic error.

`--push` closes the remaining gap. A clean worktree held back only because its
commits exist nowhere but this machine is *published* first (`git push -u origin
<branch>`, never forced), which makes the work verifiably safe and lets it reap on
the same rule as everything else. It applies only to that one case — never to a
dirty tree, a live session, or a detached HEAD, which has no branch to publish. If
the push fails for any reason, the worktree is kept.

`--interactive` / `-i` works the kept pile by hand. After the sweep has proved it
can't clear a worktree, it asks — one at a time, naming the reason and the branch:

```
SU-SRD/rail-top-right — 2 commit(s) not on any remote
  p=push & remove  d=DELETE worktree + branch rail-top-right — loses these commits
  s=skip (keep it)  q=stop asking
  choice
```

`p` is offered only when there's something publishable; `d` is the one genuinely
destructive action in the command (`git branch -D` after the directory is gone, since
git won't drop a checked-out branch); `s` is the default, so pressing return always
keeps. `q` stops the questions without stopping the safe cleanup. Only worktrees the
sweep *kept* are ever offered — a live session or an unreadable repo is skipped
silently, because there the right answer is never a question. A non-TTY is never
prompted and takes the do-nothing answer, so `-i` is harmless in a launchd timer.

## Security model

boom reconciles from a git remote **you** point it at, and a boomfile's `run` steps and
`hook` modules are executed as your user during `sync`. Sync pulls the config
repo *before* running those steps, so **anyone who can push to your config remote can run
arbitrary code on your machine on the next sync** — treat write access to that repo as
equivalent to shell access. Pin to a tag or SHA (`boom source set owner/repo@v1.2.3`) if
you want a fixed, reviewed state instead of tracking a moving branch. boom does no
credential handling of its own: git/SSH auth is whatever already works in your shell.
Downloaded release binaries are checksum-verified against the release's `SHA256SUMS`
(both `install.sh` and `boom upgrade`).

## Develop

```sh
make check   # biome (lint + format) + tsc --noEmit + bun test  (what CI runs)
make test    # just the bun test suite
make build   # compile a standalone binary for the host → build/boom
make fmt     # biome autofix + format
```

Built with [`@stricli/core`](https://github.com/bloomberg/stricli) (CLI),
[valibot](https://valibot.dev) + [smol-toml](https://github.com/squirrelchat/smol-toml)
(config), and Bun's `--compile`. Tests sandbox a throwaway `$HOME` +
`$XDG_STATE_HOME`, so they never touch the real machine.
