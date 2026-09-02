# CLAUDE.md — BoomTube

## What this is

**BoomTube** is **declarative dev-machine setup** — a single self-contained binary (the
executable is **`boom`**), compiled from **TypeScript on Bun**, that converges a
machine to a declared state (dotfiles, packages, tools) from a declarative
`boomfile.toml`, with drift detection and a recoverable teardown: reconcile fast, get out of
the way, get to work. Read [`SPEC.md`](SPEC.md) for the design of record.

## North stars

1. **Native over special.** Stock tools and Bun built-ins over dependencies
   (`Bun.$`/`Bun.spawn`, `node:fs`, `Bun.color`, `bun:sqlite`).
   Minimal ceremony; deleting custom code in favor of a built-in is the
   highest-value change.
2. **One TypeScript binary, zero runtime deps on the user's machine.** boom
   compiles via `bun build --compile` to a standalone executable (macOS/Linux).
   The 60–85 MB embedded-runtime floor (per target; macOS arm64 is the smallest) is an accepted tradeoff for type safety,
   testability, and a frictionless install. Config is **typed, validated TOML**
   (`boomfile.toml`), parsed once into the schema in `src/config/schema.ts`.
3. **Legible showpiece.** Small, exemplary, senior-engineer quality. Comments
   explain the *decision and the gotcha*, not the *what*.
4. **One model, two surfaces.** `sync`/`verify`/`uninstall` are one
   verb-parameterized loop (`src/engine/reconcile.ts`) over a resource-type
   registry. Commands are *discovered*, never a growing hardcoded dispatch:
   built-ins are the `@stricli` route map; user commands resolve at runtime from
   `<config>/commands/*.ts`.

## Conventions

- Every `.ts` file must pass `biome check` (lint + format) and `tsc --noEmit`.
- Tests are `bun test`; sandbox a throwaway `$HOME` + `$XDG_STATE_HOME` so they
  never touch the real machine. Use `Bun.spawnSync` (not piped `Bun.spawn`) when a
  test spawns the compiled binary (oven-sh/bun#24690).
- Resources are handlers implementing the verb contract (`src/engine/resources/`);
  user **hooks** are `hooks/<name>.ts` modules exporting `sync`/`verify`/`uninstall` (+ `declare`)
  that receive a `HookApi` ( `with` inputs, `ok`/`warn`/`fail`, `dryRun`, `env`).
- Mutating runs record a transaction journal in a `bun:sqlite` store
  (`${XDG_STATE_HOME:-~/.local/state}/boom/state.db`, `src/engine/db.ts`) and back up
  displaced files under `…/backups/<run-id>/`, so an overwrite or a reap is recoverable and
  `boom uninstall` can put a macOS default's pre-boom value back. Nothing replays the journal
  automatically. The owned-destinations manifest lives in the same DB;
  breadcrumbs live beside it under the state dir.
- Commit messages: `type(scope): summary`. End with the co-author trailer.

## Releases

- **Version lockstep.** A release bump is `package.json`, and that is now the only place a
  version is hand-written. Do **not** hand-edit `Formula/boom.rb`: the release workflow writes
  its version and sha256s from the tag and opens its own auto-merging PR, so a manual bump is
  overwritten.

## Merge policy (enforced by branch protection + CI)

- **Every change lands via PR; direct pushes to `main` are blocked.**
- **CI must be green before merge** — the single required check is `ci-gate`, which fails if
  `check` on Linux + macOS (biome + tsc + bun test + binary/generator smoke), `cross-compile`,
  or `version-guard` fails. `action-smoke` (the shipped GitHub Action + install.sh against the
  live latest release) runs on every PR but is deliberately outside the gate: a public download
  must never block a merge.
- **One merge, at most one release.** Each PR must move `package.json`'s version exactly
  one semver step from `main` — patch (`x.y.z+1`), minor (`x.y+1.0`), or major
  (`x+1.0.0`) — or leave it unchanged. Never skip (`0.0.1`→`0.0.3`) or jump
  (`0.0.1`→`3.0.0`). Enforced by the `version-guard` job in `.github/workflows/ci.yml`.

## Don't

- Don't reach for bash for the core reconcile path — the engine is TypeScript;
  use `Bun.$`/`Bun.spawnSync` only for genuinely external tools (git/brew/mise/gh/launchctl/defaults).
- Don't add a hardcoded subcommand case — built-ins go in the route map, everything
  else is command discovery.
- Don't let `sync`/`verify`/`uninstall` drift into separate code paths —
  they are one loop, parameterized by verb, over the resource registry.
- Don't pull a CLI framework that breaks `bun build --compile` (oclif/yargs/
  commander's discovery features do) — we use `@stricli/core` for that reason.
