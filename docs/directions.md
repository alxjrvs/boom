# Directions — where boom could go next

A forward-looking companion to [`grander.md`](grander.md) (which records changes
that *shipped*). This is the opposite: ten directions on the table as of
**v0.17.0**, grounded in the current architecture and deliberately *non*-duplicative
of what already exists (secret / adopt / plan / fleet / checkpoints / lock / edit /
modules / `doctor --fix`). Each entry names what it wraps or extends and roughly
where it would land — none of these are committed, and the list is meant to be
argued with, sliced, and reordered.

Read [`SPEC.md`](../SPEC.md) for the design of record and [`CLAUDE.md`](../CLAUDE.md)
for the north stars every one of these has to answer to (native over special; one
binary, zero runtime deps; legible showpiece; one model, two surfaces).

## Easier onboarding

### 1. `boom init` — the cold-start wizard
`adopt` makes the *proposal* (it reads a machine and drafts a `boomfile.toml`); it
does not own the *repo lifecycle*. `boom init` would chain the whole cold start:
`adopt` → scaffold a config-repo skeleton → `git init` → create the remote (via `gh`
or the GitHub API) → push → drop the breadcrumb. The clean seam is that `adopt`
stays a pure proposer and `init` owns everything that turns that proposal into a
live, pushed, boom-managed repo. This is the single biggest lever on time-to-first-run.

### 2. Migration importers — `boom adopt --from <manager>`
Eat the competing dotfile managers. `boom adopt --from chezmoi|stow|dotbot|nix-darwin|yadm`
would translate an existing manager's layout into a `boomfile.toml` + resource set.
It rides the existing `adopt` proposal machinery — each importer is just a different
front-end that emits the same intermediate representation adopt already produces —
so the blast radius is one importer module per source, not a new subsystem.

## More features — resources & platform

### 3. A `systemd` user-service / timer resource
launchd and `[boom] schedule` are macOS-only today, which means the reconcile loop
has no real Linux parity for "keep this running / run this on a timer." A `systemd`
resource (user services + timers) implements the standard verb contract
(`sync`/`verify`/`repair`/`uninstall`) in the registry (`src/engine/resources/`),
giving Linux first-class scheduled/managed processes without a second code path.

### 4. Pluggable secret backends
`secret` is hardwired to 1Password (`op`). Abstracting it behind a backend interface —
age/sops, `pass`, gpg, plain env alongside `op` — unlocks three things boom can't do
today: committed *encrypted* secrets in the config repo, CI dry-runs with no vault,
and airgapped machines. The resource contract doesn't change; only the resolver does,
so this is an interface extraction rather than a new resource.

### 5. More `pkg` manager arms
`adopt` already *detects* packages from cargo, `npm -g`, pipx, gem, and flatpak — but
the `pkg` resource can't *manage* them (brew/mise today). Closing that gap is mostly
additive: each manager is another arm behind the same `pkg` verb contract, and the
detection half already exists, so adopt and sync finally agree on the same package set.

### 6. `tmpl` — a real templating resource
The existing `expand` mechanism substitutes into files but encourages overlay-file
sprawl (a variant file per machine). A first-class `tmpl` resource with a `[vars]`
table in `boomfile.toml` would be a strict superset — render one template with
per-profile vars instead of maintaining N near-identical overlays — folding a common
reason people reach for overlays back into typed config.

## Better management & observability

### 7. `boom status` — the one-screen dashboard
Everything needed for an at-a-glance machine health view already exists as separate
commands: drift verdict, config-repo git state, checkpoints, fleet record, secret and
lock health. `boom status` composes them into one screen. It introduces **no new
state** — it's pure composition over existing readers — which is exactly why it's
cheap and high-signal.

### 8. Fleet as a control plane
Fleet records per-machine state today; the next step is making it *comparative*:
`fleet diff <hostA> <hostB>` (what differs between two machines' declared/actual state)
and `fleet drift` (which machines have wandered from their config), backed by richer
per-machine records. This turns fleet from a registry into an operations surface.

### 9. GitHub Action + `verify --ci`
`doctor --config` already validates a config repo; wrapping it in a shipped GitHub
Action + a `verify --ci` mode (non-interactive, structured exit codes, no machine
mutation) lets the config repo gate its own PRs — the same drift/validation guarantees
boom gives a machine, applied to the repo that describes the machine.

## Structural / growth

### 10. Module registry — `boom module search|add`
`use = [...]` already pulls in modules, but there's no ecosystem to pull *from*. A
curated registry of vetted packs (`node-dev`, `rust`, `sane-macos-defaults`, …) plus
`boom module search|add` turns modules from a local convenience into a real
distribution surface. Paired with lifting the current one-level nesting cap so packs
can compose, this is the path from "my dotfiles" to "shared, versioned setup."

## Honorable mentions

Raised, but not in the ten — smaller or more speculative:

- **`boom doctor --secrets`** — audit stale / expiring `op://` (and future-backend)
  references before they fail a run.
- **More code-portal backends** — tmux, zellij, VS Code (today only claude / cmux).
- **Project-local `.boom/boomfile.toml`** — per-project tooling that layers onto the
  machine config.
- **Enforceable `boom.lock`** — promote the lock from advisory to a real pin.

## Suggested sequencing

Not a commitment — a starting bid for prioritization:

- **Now** — `boom status` (#7) and `boom init` (#1): highest leverage, mostly
  composition/orchestration over existing pieces, no new state or resource contract.
- **Next** — pluggable secret backends (#4), the `systemd` resource (#3), and the extra
  `pkg` arms (#5): each is an extraction or additive arm behind a contract that already
  exists, and each removes a real "boom can't do X here" gap.
- **Later** — the module registry (#10), fleet-as-control-plane (#8), migration
  importers (#2), `tmpl` (#6), and the CI action (#9): larger surface, ecosystem, or
  external-integration bets worth doing deliberately rather than fast.
