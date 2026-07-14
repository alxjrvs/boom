# CLAUDE.md — BoomTube

## What this is

**BoomTube** is a **declarative machine reconciler** — a single self-contained binary (the
executable is **`boom`**), compiled from **TypeScript on Bun**, that converges a
machine to a declared state (dotfiles, packages, tools) from a declarative
`boomfile.toml`, with drift detection and rollback, then opens portals to your
code: reconcile fast, get out of the way, get to work. It is a rewrite of
the original bash engine (now removed); read [`SPEC.md`](SPEC.md) for the design
of record.

## North stars

1. **Native over special.** Stock tools and Bun built-ins over dependencies
   (`Bun.$`/`Bun.spawn`, `node:fs`, `Bun.color`, `bun:sqlite` if ever needed).
   Minimal ceremony; deleting custom code in favor of a built-in is the
   highest-value change.
2. **One TypeScript binary, zero runtime deps on the user's machine.** boom
   compiles via `bun build --compile` to a standalone executable (macOS/Linux).
   The ~62 MB embedded-runtime floor is an accepted tradeoff for type safety,
   testability, and a frictionless install. Config is **typed, validated TOML**
   (`boomfile.toml`), parsed once into the schema in `src/config/schema.ts`.
3. **Legible showpiece.** Small, exemplary, senior-engineer quality. Comments
   explain the *decision and the gotcha*, not the *what*.
4. **One model, two surfaces.** `sync`/`verify`/`repair`/`uninstall` are one
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
  user **hooks** are `hooks/<name>.ts` modules exporting `sync`/`verify`/`repair`
  that receive a `HookApi` ( `with` inputs, `ok`/`warn`/`fail`, `dryRun`, `env`).
- Mutating runs record a transaction journal in a `bun:sqlite` store
  (`${XDG_STATE_HOME:-~/.local/state}/boom/state.db`, `src/engine/db.ts`) and back up
  displaced files under `…/backups/<run-id>/`; `boom rollback` replays the journal
  (`--dry-run` previews it). The owned-destinations manifest lives in the same DB;
  breadcrumbs live beside it under the state dir.
- Commit messages: `type(scope): summary`. End with the co-author trailer.

## Merge policy (enforced by branch protection + CI)

- **Every change lands via PR; direct pushes to `main` are blocked.**
- **CI must be green before merge** — the required checks are `check` on Linux + macOS
  (biome + tsc + bun test + binary/generator smoke), `cross-compile`, and `version-guard`.
- **One merge, at most one release.** Each PR must move `package.json`'s version exactly
  one semver step from `main` — patch (`x.y.z+1`), minor (`x.y+1.0`), or major
  (`x+1.0.0`) — or leave it unchanged. Never skip (`0.0.1`→`0.0.3`) or jump
  (`0.0.1`→`3.0.0`). Enforced by the `version-guard` job in `.github/workflows/ci.yml`.

## Don't

- Don't reach for bash for the core reconcile path — the engine is TypeScript;
  use `Bun.$`/`Bun.spawnSync` only for genuinely external tools (brew/mise/claude).
- Don't add a hardcoded subcommand case — built-ins go in the route map, everything
  else is command discovery.
- Don't let `sync`/`verify`/`repair`/`uninstall` drift into separate code paths —
  they are one loop, parameterized by verb, over the resource registry.
- Don't pull a CLI framework that breaks `bun build --compile` (oclif/yargs/
  commander's discovery features do) — we use `@stricli/core` for that reason.
