# BoomTube

**BoomTube** is a **workspace manager** — it provisions your machine and your
code workspaces fast, then gets out of your way so you can work. Its executable,
**`boom`**, reconciles your machine from a declarative `boomfile.toml` —
`sync` / `verify` / `fix` — rolls back any change, and opens portals to your
code workspaces. One self-contained binary, compiled from **TypeScript on
[Bun](https://bun.com)**, with zero runtime dependencies on your machine.

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

## The reconcile loop

`sync` / `verify` / `fix` / `uninstall` are **one verb-parameterized loop** over
a resource registry — siblings, not separate scripts.

```sh
boom source             # make it so: symlink / copy / install / run from boomfile.toml
boom source --dry-run   # preview every change; touch nothing
boom source --skip      # skip conflicting targets instead of overwriting them
boom source --upgrade   # also upgrade outdated brewfile formulae, not just declared state
boom source --commit    # commit local config-repo edits before pulling
boom source --resume    # continue an interrupted sync (skips completed steps)

boom verify             # check for drift — exit 0 ok / 2 warn / 1 fail
boom verify --json      # …as a structured drift report
boom fix             # fix drift (sync, overwriting conflicts)
boom rollback           # undo the most recent sync (restores backed-up files)
```

`sync`/`fix` sync the config repo against its remote first (`pull --rebase
--autostash`, so local edits ride along and land back on top). `verify` reports
"N commits behind" as drift — plus separate warnings for uncommitted or unpushed
local changes — without touching the working tree. A failed pull is *reported* but
never blocks reconciling from the last-known-good local clone. A conflicting
(non-boom-owned) file at a `link` destination is **overwritten by default**; pass
`--skip` to leave it alone.

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
boom validate           # parse + schema-check the boomfile; change nothing
boom doctor             # check boom's own preconditions (tools, keychain, state)
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
(`link → copy → glob → packages → osx_default → run → hook`):

```toml
[[section]]
name = "Shell + git"
link = [
  { src = ".zshrc",     dst = "~/.zshrc" },
  { src = "ssh/config", dst = "~/.ssh/config", mode = "600" },
]
glob = [{ pattern = "zsh/[0-9]*.zsh", into = "~/.config/zsh/" }]

[[section]]
name = "Packages"
brewfile = "Brewfile"
mise = true

[[section]]
name = "macOS only"
when = { os = "darwin" }          # gate by os / host / profile
run  = [{ on = "sync", cmd = "defaults write com.apple.dock autohide -bool true" }]

[[section]]
name = "Secrets"
hook = [{ name = "op-agent", with = { vault = "claude-agent" } }]   # → hooks/op-agent.ts
```

Imperative escapes are `run` steps (a shell command) or a **hook** — a
`hooks/<name>.ts` module exporting `sync`/`verify`/`fix` that receives a typed
`HookApi`. That's the extension point for anything the declarative resources can't
express. Multi-machine setups gate sections with `when`, or layer overlay files
(`boomfile.<os|host|profile>.toml`).

## Code portals

`boom code` opens portals to the repos under your code dir (default `~/Code`):

```sh
boom code init ~/Code    # record your code dir
boom code claude         # symlink every repo into one dir, open `claude agents` there
boom code cmux           # one cmux workspace per repo
```

`code claude` flattens every repo into a symlink farm so each is `@`-taggable for
agent dispatch even with no running agents; `code cmux` opens one workspace per
repo. Both honor `--dry-run` and only spawn the backend tool when it's present.

## Security model

boom reconciles from a git remote **you** point it at, and a boomfile's `run` steps and
`hook` modules are executed as your user during `sync`/`fix`. Sync pulls the config
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
