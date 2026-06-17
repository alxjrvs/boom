# BoomTube

**BoomTube** is a small, installable **dotfiles + workspace engine**. Its
executable, **`botu`**, lets you `apply`/`verify`/`fix` your machine from a
declarative `botufile.toml`, roll back any change, and open portals to your code
workspaces. A single self-contained binary, compiled from **TypeScript on
[Bun](https://bun.com)** — no runtime dependencies on your machine.

Named for Jack Kirby's **Boom Tube** (the Fourth World portal): BoomTube opens
portals to your machine's ideal state, and to your code. You drive it with the
`botu` command.

> Status: **early** — a TypeScript rewrite of the original bash engine, extracted
> from [`alxjrvs/dotFiles`](https://github.com/alxjrvs/dotFiles). See
> [`SPEC.md`](SPEC.md) for the design of record.

## Quickstart

```sh
botu init ~/dotfiles     # record your dotfiles repo (+ writes botuinit.sh there)
botu apply               # symlink/copy/install/run from its botufile.toml
botu verify              # check for drift (exit 0 ok / 2 warn / 1 fail)
botu verify --json       # … as a structured drift report
botu fix                 # repair drift
botu rollback            # undo the last apply (restores backed-up files)

botu code init ~/Code    # record your code dir
botu code claude         # symlink every repo into one dir, open `claude agents` there
botu code cmux           # one cmux workspace per repo
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

Imperative escapes are `run` steps (a shell command) or a **hook**: a
`hooks/<name>.ts` module exporting `apply`/`verify`/`fix` functions — the
extension point for anything the declarative resources can't express.
Multi-machine setups gate sections with `when`, or layer overlay files
(`botufile.<os|host|profile>.toml`).

Coming from the old bash `botufile`? See
[`docs/migration-prompt.md`](docs/migration-prompt.md) — a prompt that converts it
to `botufile.toml` and ports bash hooks to TypeScript.

## Install

```sh
# curl installer — downloads the binary for your platform, puts `botu` on PATH
curl -fsSL https://raw.githubusercontent.com/alxjrvs/botu/main/install.sh | sh

# …or Homebrew (this repo doubles as the tap)
brew tap alxjrvs/botu https://github.com/alxjrvs/botu
brew install botu
```

botu ships as one self-contained executable (macOS arm64/x64, Linux x64); the
binary embeds the Bun runtime, so nothing else is required. Override the install
prefix with `BOTU_PREFIX`.

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
