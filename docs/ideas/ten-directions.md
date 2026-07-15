# Ten directions for boom

Grounded in the v0.16.2 surface: the verb-parameterized reconcile loop over the
resource registry (`src/engine/registry.ts`), the `bun:sqlite` journal + rollback,
the config-repo-only model, `[boom]` self-wiring, and the `code`/`mcp` portals.

Grouped by axis. Effort is rough (S/M/L). "Slots in" points at the seam.

---

## Easier onboarding

### 1. `boom adopt` — reverse-engineer a config from an existing machine
**The single biggest onboarding lever.** Today you must hand-author `boomfile.toml`
*and* already have a git remote before boom does anything. The hard part of every
dotfile manager (stow, chezmoi) is the cold start from a messy machine. `boom adopt`
scans what's already there — existing `~/.config` symlinks and dotfiles, `brew leaves`
/ `brew bundle dump`, `mise ls`, changed macOS `defaults`, `~/Library/LaunchAgents`
plists — and generates a `boomfile.toml` + moves the referenced files into a scaffolded
repo. Output is a *proposal* you review, not an auto-commit.
- **Why it fits:** inverts the reconcile engine — the registry already knows how to
  read every resource's live state for `verify`; adopt reuses those readers to emit
  declarations instead of comparing them.
- **Slots in:** new `src/engine/adopt.ts` calling per-resource "describe current" fns;
  new `boom init`/`boom adopt` route. **Effort: L.**

### 2. Guided first-run: turn `doctor` into a fixer (`doctor --fix`)
`boom doctor` today *checks* preconditions (config, tools, keychain, state) and
*suggests* fixes. Make it converge them: missing git/brew/op → offer to install;
no config breadcrumb → branch into `init` (scaffold) or `source set` (adopt a repo);
no `op-agent` token → run provisioning. End every fresh machine at a green doctor.
- **Why it fits:** doctor already enumerates each precondition with a remedy string;
  this attaches an action to each remedy.
- **Slots in:** `src/engine/doctor.ts` gains a `fix` per check; `--fix` flag. **Effort: M.**

### 3. `boom edit` — edit-validate-push against the managed clone
You can find the config repo (`boom where config`) but there's no affordance to edit
it. `boom edit` opens the boomfile in `$EDITOR` against the managed clone, runs
`doctor --config` (parse/schema gate) on save, and offers `source push`. Removes the
"where is my config even checked out" round-trip that every small tweak costs today.
- **Slots in:** thin command over `where`, `doctor --config`, and `source push`. **Effort: S.**

---

## Better management

### 4. `boom plan` — a first-class, structured preview
`--dry-run` exists but is a side-mode of sync. Promote it to a Terraform-style `plan`
that groups the pending delta by action (**create / update / delete / skip**) across
the category bands, and — critically — surfaces the exact set of *conflicting,
non-boom-owned* files that `--fix` would overwrite. Right now that conflict set is
invisible until you pass `--fix` and trust it.
- **Why it fits:** verify already walks every resource read-only and computes drift;
  plan is verify with a change-oriented projection instead of a pass/fail verdict.
- **Slots in:** new projection over the reconcile walk; reuse `src/lib/reporter.ts`
  bands. **Effort: M.**

### 5. Fleet awareness — commit a per-machine last-sync summary
`state.db` is per-machine, so there's no answer to "which of my machines are drifted,
on what boom version, synced when." On each sync, write a small
`.boom/machines/<host>.json` (version, timestamp, drift verdict, section count) into
the config repo. `boom fleet` (or `source status --all`) then reads them for a
cross-machine view. Cheap because it rides the config repo you already push.
- **Why it fits:** the config repo is already the source of truth and already committed
  to; this adds one journaled write at the end of a successful run.
- **Slots in:** end of `reconcile.ts` (behind a `[boom]` opt-in); new `fleet` reader. **Effort: M.**

### 6. Named checkpoints / snapshot rollback
`rollback` today targets the most-recent run (or `--run-id`) and prunes to the last 10.
Add `boom checkpoint <name>` to pin a run so it survives pruning, and
`boom rollback --to <name>` to restore to a labelled known-good state ("before I
touched my macOS defaults"). Small ergonomic layer over the journal that makes
rollback a deliberate tool rather than an undo-last.
- **Slots in:** a `label` column on `runs`; exempt labelled runs from `pruneRuns`. **Effort: S.**

### 7. Drift monitor with desktop notifications
`[boom] schedule` already runs `boom <cmd>` on launchd timers, and verify already
emits a 0/2/1 drift verdict — but the signal dies in a log file. Formalize a drift
monitor: a scheduled `verify` that fires a macOS notification (and a Linux
`notify-send` analog) when it finds drift, so you *know* your machine wandered instead
of discovering it next sync.
- **Slots in:** a notifier in `src/lib/`, wired from the scheduled verify path;
  opt-in via `[boom]`. **Effort: S–M.**

---

## New feature surface / directions

### 8. `secret` / `template` resource — close the declarative loop
boom leans hard on 1Password (`op run`, `op-agent`, MCP secrets) but there is **no
resource type that renders a secret into a file.** A `secret`/`template` resource
resolves `op://` references (or `${op:…}`) into a `dst` at sync time — mode 0600,
plaintext never journaled and never written to `backups/`. This is the missing piece
of "declarative machine": right now secret-bearing config files are out of band.
- **Why it fits:** it's one more registry row + handler in `src/engine/resources/`,
  the exact "adding a resource is one table entry" property the engine is built for.
- **Slots in:** `RESOURCES` table + `resources/secret.ts` + schema. **Effort: M.**

### 9. `boom.lock` — resolved-version reproducibility
`pkg` delegates to `brew bundle` / `mise install`, but nothing pins *resolved* versions,
so machine B converges to "latest at sync time," not "exactly what machine A has."
Capture resolved brew formula + mise tool versions into a `boom.lock`, and let
`sync --locked` converge to it. This is the north-star "converge to a declared state"
taken to its logical end — true reproducibility across machines and across time.
- **Slots in:** pkg handlers gain a "resolve + record" step; lockfile read on `--locked`.
  **Effort: L.**

### 10. Shareable modules — compose a config from vetted pieces
`--profile` overlays let *you* fork your own config, but a new teammate still authors
from a blank file. Add a lightweight module import — a section-set published as a repo
that a boomfile references (`use = "boomtube/node-dev@v1"`), resolved and merged like
an overlay. Onboarding a new dev becomes "compose vetted modules" rather than "write
everything." The ecosystem play (Nix flakes / Ansible Galaxy, kept deliberately small).
- **Why it fits:** the overlay/profile merge machinery in `src/config/profile.ts`
  already merges config trees; a module is a remote overlay with provenance.
- **Slots in:** `use` key in schema; fetch + merge in the config loader. **Effort: L.**

---

## Bonus (not a feature — a chore worth doing first)

**Reconcile the docs to the live schema.** `README.md` and `CLAUDE.md` still document
the pre-`pkg`/`schedule` config — `glob`, scalar `brewfile`/`mise = true`,
`verify_schedule`/`code_fetch_schedule`/`upgrade_check_on_sync`. The README's example
`boomfile.toml` would now fail `strictObject` validation. `SPEC.md` is the accurate
one. Several of the ideas above (adopt, modules, secret resource) touch the schema, so
truing up the docs is a cheap prerequisite. Also: `src/commands/where.ts` carries stale
"code lands in M5" milestone comments though `code` is fully shipped.
