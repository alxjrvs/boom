# botu — grander changes (design exploration)

Companion to [`SPEC.md`](../SPEC.md). SPEC is the *decided* model and build list;
this doc explores four structural changes that go beyond the build list. None
are committed — each ends with a recommendation and the cost of *not* doing it.

These are deliberately framed against the north stars (native over special, just
bash + git, legible showpiece, one model / two surfaces) and against the audit
findings (`audit/`). Where a sketch resolves a finding, it's tagged.

**Framing.** The audit graded the *reconcile engine* A/A-: it is essentially
done and excellent. None of these changes are about fixing badness. They are
about **scope, ambition, and positioning** — turning a clean tool into a clean
*platform*. They share one through-line:

> The pure-bash reconcile core is botu's identity and must stay bash. Everything
> orbiting it — the commands, the resource types, the profiles, the state — is
> where the grander moves live, and several of them are *more* native, not less.

---

## 0. The language question (why none of this is a rewrite)

The tempting "grand change" is a rewrite (Go/Rust). It is the one move that
**dissolves botu instead of elevating it**, because the config *is* the host
language:

- `engine/run:321` — `source "$REPO/botufile"`. The botufile is a bash program;
  the primitives (`link`, `glob`, `hook`, `on apply <cmd>` at `run:263`) are bash
  functions in the *same* interpreter. A compiled engine must either shell out to
  bash to source config (more moving parts) or invent a structured config format
  — i.e. reintroduce the `dot.json` + jq manifest that `SPEC.md:35` says was tried
  and removed.
- The single-static-binary upside (kill the launcher self-resolution problem) is
  already banked: `engine/botu:25-34` resolves the symlink chain and is graded A.

So the engine stays bash. **But the language question has a real answer for the
*commands*** — see §1. The seam where bash hurts (JSON, sockets, concurrency) is
exactly the seam between the two products, and the command-discovery contract
already lets those commands be any executable.

---

## 1. Decide the fate of the workspace-orchestrator half

**Resolves:** maintainability M-1, the test-quality / documentation / ontology
"honest stub" findings, and the language question for the part that fights bash.

### Current state

botu is two programs in one binary:

1. **Reconcile** (`apply`/`verify`/`fix`/`uninstall` → `engine/run`) — bash by
   identity, complete, A-grade.
2. **Orchestrate** (`engine/commands/code`, `watchtower`) — crawl repos, drive
   cmux sockets, parse `claude agents --json`, manage background processes.
   Stubs (`code:12-13` "PROTOTYPE: ... print the plan"). This half pulls four
   audit dimensions down to "honest but unfinished."

The orchestrator is a *different kind of program*: I/O-bound, JSON-heavy,
concurrent. JSON-in-bash is the worst ergonomics botu will ever have.

### The key fact

Tier-2 command dispatch `exec`s the file (`engine/botu:143`):

```bash
[[ -x "$_base/$cmd" ]] && exec "$_base/$cmd" "$@"
```

A discovered command **does not have to be bash.** `code` already sources
nothing from the engine (`code:14`) — it's a standalone executable that happens
to be bash today. It could be a Go binary or a `jq`-using script tomorrow and the
dispatcher would not change.

### Options

- **A — Commit fully, in bash.** Build `code claude`/`cmux`/`watchtower` as real
  bash. Keeps the "two portals" story (`SPEC.md:6-8`) but inherits JSON-in-bash
  pain and is the most code for the least-suited language.
- **B — Split out.** Move orchestration to a separate tool that *consumes* botu.
  Keeps the engine pure but forks the "one binary, two portals" vision and the
  install story.
- **C — Keep in-engine, but make commands explicitly polyglot. (Recommended.)**
  Reframe `code`/`watchtower` from "unfinished bash" to "commands behind a stable
  exec contract, in whatever language fits." The UX stays unified (one `botu`,
  two portals); the part that fights bash is freed from bash.

### Sketch for C

Codify the **command ABI** in SPEC: argv in, exit code out, no sourcing of engine
internals (already honored by `code`). To let a polyglot command reuse botu's
resolution without re-implementing it, add a tiny query surface:

```
botu where config     # prints the dotfiles repo path (or exits 1)
botu where code        # prints the code dir
botu where engine      # prints ENGINE_DIR
```

This **also kills maintainability finding M-2**: `_crumb`/`_resolve_*` is
duplicated near-identically across `engine/botu:36`, `engine/commands/code:16`,
and `test/helper.bash`. `botu where` becomes the single source of truth a Go/jq
command (or a bash one) calls instead of re-deriving the breadcrumb.

**Decision to make:** stop treating the orchestrator as "bash we'll finish" and
declare it "polyglot commands behind a contract." That single reframing resolves
the orchestrator's fate *and* the language question at once.

---

## 2. A real apply transaction / journal

**Resolves:** reliability F1 (no rollback, partial-apply leaves inconsistent
state) and F4 (`rm -rf "$dst"` in `lib.sh:55`). Gives `verify` a machine-readable
output story.

### Current state

State is a flat **manifest** of declared destinations
(`…/botu/manifest`, written `run:359-368`), used for orphan reaping (`run:334`)
and uninstall. It is overwritten wholesale at the end of a run (`run:363`,
`: > "$_MANIFEST"`). There is no record of *what changed this run* and no way to
undo. A mid-apply failure (or the EXIT-trap lock release at `run:57`) leaves a
half-reconciled machine.

`_symlink` destroys on overwrite (`lib.sh:55`, `rm -rf -- "$dst"`) — the
displaced file is gone.

### Sketch

Introduce an append-only **journal** per run plus **backups** instead of
destructive removal.

```
…/botu/journal/<run-id>.log       # run-id = <utc-stamp>-<pid>
…/botu/backups/<run-id>/<path>    # displaced files, for restore
```

Each mutation writes two records — intent before, result after:

```
INTENT link  ~/.zshrc → $REPO/.zshrc
DONE   link  ~/.zshrc  undo=remove
INTENT link  ~/.gitconfig → $REPO/.gitconfig
DONE   link  ~/.gitconfig  undo=restore:backups/<run-id>/.gitconfig
```

The `undo` token is everything needed to reverse one step: `remove` for a
freshly-created link; `restore:<path>` for an overwrite (where `_symlink` now
*moves* the old file into `backups/` rather than `rm -rf`-ing it — this is also
the F4 fix).

Transaction semantics:

- A clean run appends a final `COMMITTED` record; backups older than the last *N*
  committed runs are pruned.
- A journal left **un-committed** (interrupted run) is detected on the next
  `botu apply`/`verify`: verify warns ("last apply did not complete"), and a new
  verb `botu rollback [run-id]` replays `DONE` records in reverse (remove created
  links, restore backups).
- `botu apply --resume` (optional) continues an interrupted journal instead of
  restarting.

Structured drift, reusing the per-primitive verify logic already at
`run:112-127`:

```
botu verify --json   # [{decl:"link", dst:"~/.zshrc", state:"ok"},
                     #  {decl:"link", dst:"~/.gitconfig", state:"drifted",
                     #   detail:"→ /other, expected $REPO/.gitconfig"}, …]
```

Machine-readable verify feeds CI and a future `code`/portal status view.

### Discipline

This adds state management to a core the audit praised for *not* over-reaching
(architecture F1/F2 already flag the side-effecting globals and the 398-line
`run`). Keep the journal a plain text file and rollback a reverse-replay; factor
the journal/backup helpers into `lib.sh` so `run` doesn't grow. Bash handles
append-to-file and move-file fine — no new dependency.

**Cost of not doing it:** botu mutates `$HOME` with no undo. For a tool whose
whole job is mutating machines, "I can put it back" is the reliability ceiling.

---

## 3. Promote the hook contract to *the* public resource-type API

**Resolves:** documentation F2 (the DSL/extension reference is the thinnest
quadrant) and, in its stretch form, architecture F2 (everything concentrated in
`run`). This is the biggest *positioning* lever.

### Current state

`hook NAME k=v` (`run:239`) sources `hooks/NAME.sh`, calls `_NAME_<verb>`, and
passes `k=v` as `$BOTU_k`. SPEC frames it as "the imperative residue the DSL
can't express" (`SPEC.md:48`) — an escape hatch. The built-in primitives
(`link`/`copy`/`glob`/`brewfile`/`mise_install`/`osx_default`/`on`) are
privileged bash functions inside `run` with a `case "$VERB"` each.

### The insight

`_NAME_apply/_verify/_fix` reading `$BOTU_<key>` **is a custom resource type with
declared inputs** — the exact shape of the built-ins' internal `case "$VERB"`.
The escape hatch is already the extension point; it's just not named, documented,
or governed as one.

### Sketch — document and govern the ABI

Define a **resource-type ABI** (the contract a hook may rely on and must honor):

```
# A resource type: hooks/<name>.sh (config repo) or an installed resource path.
#   _<name>_apply      make it so  (also used for fix unless _<name>_fix exists)
#   _<name>_verify     report drift via _ok/_warn/_fail; MUST NOT mutate
#   _<name>_uninstall  (optional) reverse what apply created
#
# Inputs : $BOTU_<key> from `hook <name> key=val …`
# Given  : $VERB, $DRY_RUN, $LINK_MODE, $BOTU_CONFIG, and _ok/_warn/_fail/_note
# Must   : honor $DRY_RUN; be idempotent; tally ONLY via _ok/_warn/_fail
```

Then three concrete additions:

1. **Third-party resource discovery.** Today hooks come only from the config repo
   (`run:243`). Add an installed resource path (parallel to command discovery in
   `engine/botu:142`) so a community `1password-item` or `npm-global` resource
   type can ship as a package. *This* is the "tiny, legible, bash-native
   alternative to chezmoi / nix-home-manager for the 80% case" positioning —
   extensible without forking the engine.
2. **Scaffolder + lint.** `botu hook --new <name>` writes a stub with the three
   verb functions; a `verify`-time lint warns if a hook ignores `$DRY_RUN` or
   omits `_verify`.
3. **Reference docs.** Promote the ABI from a `run` comment to a first-class
   section in README/SPEC — directly closing documentation F2, since the
   extension contract is the primary public API and currently lives only in code.

### Stretch (aggressive): built-ins become resource types

Move `link`/`copy`/… out of `run` into `engine/resources/<name>.sh`, sourced the
same way hooks are. This dogfoods the ABI and shrinks the 398-line `run`
(architecture F2). It touches the A-grade core, so only pursue it if `run`'s size
becomes a real maintenance problem — otherwise the documented ABI + discovery
path (above) is the high-value / low-risk 80%.

**Cost of not doing it:** the most differentiating thing botu has — a clean,
verb-parameterized extension model — stays an undocumented escape hatch instead
of the headline.

---

## 4. Host / OS profiles

**Resolves:** the biggest *functional* gap for the actual dotfiles use case.
Builds directly on machinery that already exists.

### Current state

The example botufile is a single flat machine (`examples/dotfiles/botufile`).
`osx_default` already OS-gates internally (`run:218`,
`[[ "$(os_kind)" == "darwin" ]] || return 0`) and `os_kind` returns
`darwin`/`linux`/`unknown` (`lib.sh:21`). Because `lib.sh` is sourced before the
botufile (`run:61` then `run:321`), `os_kind` is *already in scope* for botufile
authors — but there's no legible, `--only`-integrated way to say "this on macOS,
that on Linux, this only on host X." The real use case (laptop vs server vs fresh
VM share ~80%, differ ~20%) is unserved.

### Sketch — two layers, both pure bash, no JSON

**(a) Inline guards** — mirror the existing `on <verb>` guard shape (`run:263`):

```bash
on_os   darwin  link karabiner/karabiner.json ~/.config/karabiner/karabiner.json
on_os   linux   on apply systemctl --user enable foo
on_host server  link nginx/nginx.conf /etc/nginx/nginx.conf
```

`on_os <os> <primitive…>` runs the primitive only when `os_kind` matches;
`on_host <name>` gates on `$(hostname -s)`. Both are verb-aware and `--only`-aware
exactly like the current primitives (a guard wrapping a dispatch).

**(b) Profile blocks + overlay files** for larger divergence:

```bash
profile laptop          # like `section`: opens a gated region + a --only tag
link work/.gitconfig ~/.gitconfig
profile server
on apply systemctl --user enable backup.timer
```

`profile NAME` sets a gate (as `section` does at `run:89`); subsequent lines run
only if `NAME` is in the **active profile set**. The active set comes from
`botu apply --profile laptop` (additive to the always-on base) or auto-matches
`$(hostname -s)`. For hosts that diverge a lot, additive **overlay files** avoid
in-file branching entirely:

```
botufile               # shared base (always sourced)
botufile.darwin        # sourced when os_kind == darwin
botufile.<hostname>    # sourced on that host
botufile.<profile>     # sourced when --profile <profile>
```

The engine sources base, then each matching overlay (`run:321` becomes a small
loop). No new syntax, clean separation, scales to many machines.

### North-star check

`on_os` / `on_host` / `profile` are verb-aware primitives identical in shape to
the existing ones — a `case`/gate, `--only`-aware, dry-run-aware. No JSON, no new
config format. This is *more* native, not less.

**Cost of not doing it:** dotfiles tools live or die on multi-host. Without
first-class profiles, every user hand-rolls `if [[ $(os_kind) … ]]` (legal, since
the botufile is bash) — but it's invisible to `--only`, undocumented, and the
single biggest reason someone picks chezmoi/nix over botu.

---

## Sequencing

A pragmatic order, cheapest-decisive first:

1. **§1 decision** (reframe commands as polyglot + `botu where`) — mostly a SPEC
   edit + a small query surface; unblocks finishing the orchestrator and kills
   M-2. Low code, high clarity.
2. **§4 profiles** — highest functional payoff; builds on `os_kind`/`on`; pure
   additive primitives.
3. **§3 ABI docs + discovery** — turns the existing escape hatch into the
   headline; closes documentation F2.
4. **§2 journal/rollback** — the deepest core change; do it deliberately, factor
   helpers into `lib.sh`, and treat the structured `verify --json` as the first
   increment (read-only, low-risk) before rollback.

The stretch goals (§3 built-ins-as-resources) wait until their host finding
(`run` size) actually bites.
