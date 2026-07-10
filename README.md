# BoomTube

**BoomTube** is a **workspace manager** — it provisions your machine and your
code workspaces fast, then gets out of your way so you can work. Its executable,
**`botu`**, reconciles your machine from a declarative `botufile.toml` —
`apply` / `verify` / `repair` — rolls back any change, and opens portals to your
code workspaces. One self-contained binary, compiled from **TypeScript on
[Bun](https://bun.com)**, with zero runtime dependencies on your machine.

Named for Jack Kirby's **Boom Tube** (the Fourth World portal): botu opens a
portal to your machine's ideal state, and to your code.

📖 **Docs site → [alxjrvs.github.io/botu](https://alxjrvs.github.io/botu/)**  ·
📐 Design of record → [`SPEC.md`](SPEC.md)

> Status: **early** — a TypeScript rewrite of the original bash engine, extracted
> from [`alxjrvs/dotFiles`](https://github.com/alxjrvs/dotFiles).

## Install

```sh
# curl installer — downloads the binary for your platform, puts `botu` on PATH
curl -fsSL https://raw.githubusercontent.com/alxjrvs/botu/main/install.sh | sh

# …or Homebrew (this repo doubles as the tap)
brew tap alxjrvs/botu https://github.com/alxjrvs/botu
brew install botu
```

One self-contained executable (macOS arm64/x64, Linux x64); the binary embeds the
Bun runtime, so nothing else is required. Override the install prefix with
`BOTU_PREFIX`.

## Bootstrap a machine

```sh
botu source set alxjrvs/dotfiles   # clone your remote dotfiles repo and apply it — one-shot bootstrap
botu apply                         # thereafter: reconcile from the recorded config repo
```

`botu source set` takes a **remote reference** — `owner/repo`, `github:owner/repo`, a
git URL, optionally `@ref` — never an arbitrary local path. botu clones it into a
managed cache dir, records a breadcrumb, and applies it. Pass `--no-apply` to clone and
record only — to review before reconciling, or to re-point at a different repo. The
fresh-machine one-liner is `curl install.sh | sh && botu source set owner/repo`.

## The reconcile loop

`apply` / `verify` / `repair` / `uninstall` are **one verb-parameterized loop** over
a resource registry — siblings, not separate scripts.

```sh
botu apply              # make it so: symlink / copy / install / run from botufile.toml
botu apply --dry-run    # preview every change; touch nothing
botu apply --skip       # skip conflicting targets instead of overwriting them
botu apply --upgrade    # also upgrade outdated brewfile formulae, not just declared state
botu apply --commit     # commit local config-repo edits before pulling
botu apply --resume     # continue an interrupted apply (skips completed steps)

botu verify             # check for drift — exit 0 ok / 2 warn / 1 fail
botu verify --json      # …as a structured drift report
botu repair             # repair drift (apply, overwriting conflicts)
botu rollback           # undo the most recent apply (restores backed-up files)
```

`apply`/`repair` sync the config repo against its remote first (`pull --rebase
--autostash`, so local edits ride along and land back on top). `verify` reports
"N commits behind" as drift — plus separate warnings for uncommitted or unpushed
local changes — without touching the working tree. A failed pull is *reported* but
never blocks reconciling from the last-known-good local clone. A conflicting
(non-botu-owned) file at a `link` destination is **overwritten by default**; pass
`--skip` to leave it alone.

### Config-repo git, without leaving botu

`botu source` operates the managed config-repo clone (the source your machine is
reconciled from) without cd-ing into the cache dir it lives in:

```sh
botu source diff          # show uncommitted local changes in the config repo
botu source commit        # commit local changes in the config repo
botu source push          # push the config repo's local commits upstream
botu source reset         # discard local changes, reset to origin
botu source reset --force # …including commits no remote has (refused otherwise)
```

### Housekeeping

```sh
botu validate           # parse + schema-check the botufile; change nothing
botu doctor             # check botu's own preconditions (tools, keychain, state)
botu where config|code|engine   # resolve where botu keeps things
botu upgrade            # upgrade the botu binary itself
botu completions bash|zsh|fish  # shell completions
botu man                # the man page
```

## The `botufile.toml`

Your dotfiles repo's config is a typed, validated TOML document, grouped into
sections that run in phase order (`link → copy → glob → packages → run → hook`):

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
run  = [{ on = "apply", cmd = "defaults write com.apple.dock autohide -bool true" }]

[[section]]
name = "Secrets"
hook = [{ name = "op-agent", with = { vault = "claude-agent" } }]   # → hooks/op-agent.ts
```

Imperative escapes are `run` steps (a shell command) or a **hook** — a
`hooks/<name>.ts` module exporting `apply`/`verify`/`repair` that receives a typed
`HookApi`. That's the extension point for anything the declarative resources can't
express. Multi-machine setups gate sections with `when`, or layer overlay files
(`botufile.<os|host|profile>.toml`).

## Code portals

`botu code` opens portals to the repos under your code dir (default `~/Code`):

```sh
botu code init ~/Code    # record your code dir
botu code claude         # symlink every repo into one dir, open `claude agents` there
botu code cmux           # one cmux workspace per repo
```

`code claude` flattens every repo into a symlink farm so each is `@`-taggable for
agent dispatch even with no running agents; `code cmux` opens one workspace per
repo. Both honor `--dry-run` and only spawn the backend tool when it's present.

## Develop

```sh
make check   # biome (lint + format) + tsc --noEmit + bun test  (what CI runs)
make test    # just the bun test suite
make build   # compile a standalone binary for the host → build/botu
make fmt     # biome autofix + format
```

Built with [`@stricli/core`](https://github.com/bloomberg/stricli) (CLI),
[valibot](https://valibot.dev) + [smol-toml](https://github.com/squirrelchat/smol-toml)
(config), and Bun's `--compile`. Tests sandbox a throwaway `$HOME` +
`$XDG_STATE_HOME`, so they never touch the real machine.
