# CLAUDE.md — botu

## What this is

`botu` is an installable dotfiles + workspace engine — a single self-contained
binary, compiled from **TypeScript on Bun**, that reconciles a machine from a
declarative `botufile.toml`. It is a rewrite of the original bash engine (now
removed); read [`SPEC.md`](SPEC.md) for the design of record.

## North stars

1. **Native over special.** Stock tools and Bun built-ins over dependencies
   (`Bun.$`/`Bun.spawn`, `node:fs`, `Bun.color`, `bun:sqlite` if ever needed).
   Minimal ceremony; deleting custom code in favor of a built-in is the
   highest-value change.
2. **One TypeScript binary, zero runtime deps on the user's machine.** botu
   compiles via `bun build --compile` to a standalone executable (macOS/Linux).
   The ~62 MB embedded-runtime floor is an accepted tradeoff for type safety,
   testability, and a frictionless install. Config is **typed, validated TOML**
   (`botufile.toml`), parsed once into the schema in `src/config/schema.ts`.
3. **Legible showpiece.** Small, exemplary, senior-engineer quality. Comments
   explain the *decision and the gotcha*, not the *what*.
4. **One model, two surfaces.** `apply`/`verify`/`fix`/`uninstall` are one
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
  user **hooks** are `hooks/<name>.ts` modules exporting `apply`/`verify`/`fix`
  that receive a `HookApi` ( `with` inputs, `ok`/`warn`/`fail`, `dryRun`, `env`).
- Mutating runs journal to `${XDG_STATE_HOME:-~/.local/state}/botu/journal/` and
  back up displaced files; `botu rollback` replays the journal. Breadcrumbs +
  manifest live under the same state dir.
- Commit messages: `type(scope): summary`. End with the co-author trailer.

## Don't

- Don't reach for bash for the core reconcile path — the engine is TypeScript;
  use `Bun.$`/`Bun.spawnSync` only for genuinely external tools (brew/mise/claude).
- Don't add a hardcoded subcommand case — built-ins go in the route map, everything
  else is command discovery.
- Don't let `apply`/`verify`/`fix`/`uninstall` drift into separate code paths —
  they are one loop, parameterized by verb, over the resource registry.
- Don't pull a CLI framework that breaks `bun build --compile` (oclif/yargs/
  commander's discovery features do) — we use `@stricli/core` for that reason.
