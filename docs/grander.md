# Design retrospective — the "grander changes"

This doc began as an exploration of four structural changes to the (then) bash
engine. All four shipped — folded into the TypeScript rewrite ([`SPEC.md`](../SPEC.md)) —
so this is now a record of the decisions and where each landed.

## The language question (resolved)

The exploration originally argued the reconcile engine should stay bash, because
the config *was* bash (the engine `source`d the `boomfile`). That premise was
deliberately overturned: boom was rewritten end-to-end in **TypeScript on Bun**,
shipped as a single self-contained binary, and the config became typed,
validated **TOML** (`boomfile.toml`). The ~62 MB compiled-binary floor is the
accepted cost; the payoff is type safety, real tests, and a frictionless install.
The old "config is bash / no JSON manifest" north star was retired accordingly.

## The four directions — and where they shipped

### 1. Fate of the orchestrator half → **M5**
`code` is no longer "unfinished bash." Command discovery is now explicit: built-ins
are the `@stricli` route map; user commands resolve at runtime from
`<config>/commands/<name>.ts` (`src/engine/discovery.ts`). `code` does a leaf-rule
repo crawl and dispatches per repo; `where config|code|engine` is the single resolver
(killing the old breadcrumb triplication). `mcp` was ported. The placeholder
`watchtower` was dropped (the op-based audit never materialized); `doctor` now covers
the precondition-check role it gestured at.

### 2. Apply transaction / journal → **M3**
Mutating runs journal to `…/boom/journal/<run-id>.ndjson` (intent/done + undo
token, committed marker) and back up displaced files instead of destroying them.
`boom rollback` replays the journal in reverse; `apply --resume` skips done steps;
`verify --json` emits a structured drift report; orphan reaping is rebuilt on the
manifest. (`src/engine/journal.ts`, `state.ts`, `rollback.ts`.)

### 3. Hook contract → the resource-type API → **M2**
The hook is the public extension point: `hooks/<name>.ts` modules exporting
`apply`/`verify`/`repair` that receive a typed `HookApi`. Built-in resources
(link/copy/glob/run/packages) implement the same verb contract in a registry
(`src/engine/registry.ts`, `resources/`). No JSON-config manifest — the *config*
is TOML data, but the *extension* contract is typed TypeScript.

### 4. Host/OS profiles → **M4**
Sections carry `when = { os, host, profile }`; overlay files
`boomfile.<os|host|profile>.toml` merge onto the base; `--profile` (repeatable)
activates named profiles, os/host auto-match. (`src/config/profile.ts`.)

## What stayed true

"One model, two surfaces" survived the rewrite intact: `apply`/`verify`/`repair`/
`uninstall` are still one verb-parameterized loop (`src/engine/reconcile.ts`),
and subcommands are still discovered, never a hardcoded dispatch table — just in
TypeScript now.
