// The boomfile.toml schema (nested-by-section). This typed contract is the source of
// truth shared by the loader and the reconcile engine. Within a section, resources run by phase:
//   link → copy → tmpl → secret → dir → pkg → osx_default → launchd → systemd → run → check → hook
// — the order engine/registry.ts's table executes and SPEC.md states.
import * as v from "valibot";

// A Unix permission bitmask as an octal string ("644", "0700"). Validated here at the
// boundary so a bad value fails config load with a clear message, instead of a bare
// Number.parseInt(mode, 8) deep in the engine turning "abc" into NaN and chmod throwing.
const ModeSchema = v.pipe(
  v.string(),
  v.regex(/^[0-7]{3,4}$/, 'mode must be an octal string like "644" or "0700"'),
);

// strictObject (not object): unknown keys are a hard error, not silently dropped — so a
// mistyped `pkg`/`osx_defalt` in a boomfile surfaces as a schema failure at load, which is
// the whole point of a "typed, validated TOML" config.
//
// One `file` shape covers both `link` and `copy` (they differ only in symlink-vs-copy).
// `src` may be a *glob* pattern — then `dst` is treated as a directory and every match is
// placed under it, preserving the path structure below the glob's static prefix. Neither
// form renders content: a file whose text must differ per machine is a `tmpl`, which reads
// the same `${env:VAR}`/`${host}`/`${os}` vocabulary plus `${NAME}` from `[vars]`.
const FileSchema = v.strictObject({
  src: v.string(),
  dst: v.string(),
  mode: v.optional(ModeSchema),
  // Retired, and kept *declared* so the failure can name the migration: dropping the key
  // outright leaves strictObject's generic "unknown key", which says the config is wrong but
  // not what to do about it. `v.never` rejects any present value (an absent key still parses
  // through `v.optional`). Delete the key at 1.0, once the message has outlived its usefulness.
  // A template literal with escaped `\${`: these are placeholder *spellings* for the reader, and
  // spelling them in a plain string trips noTemplateCurlyInString (which cannot tell prose from a
  // forgotten interpolation).
  expand: v.optional(
    v.never(
      "`copy.expand` was retired in favour of `tmpl` — replace this entry with " +
        `\`tmpl = [{ src, dst, mode? }]\`, which renders the same \${env:VAR}/\${host}/\${os} ` +
        `plus \${NAME} from [vars]`,
    ),
  ),
});

// A package manager to satisfy: one array entry per manager, replacing the old scalar
// `brewfile = "…"` + boolean `mise = true` (the two resources that broke the array-of-tables
// shape every other resource has). `file` is the manager's manifest: a Brewfile path for
// `brew` (default "Brewfile"); a newline-separated package list for `apt`/`dnf` (Linux) and the
// user-scoped managers `cargo`/`npm` (global)/`pipx`/`gem`/`flatpak` (`flatpak` Linux-only), `#`
// comments allowed; `mise` reads the repo's own mise config and ignores it. Each manager is one
// dispatch arm in packages.ts — the registry north star, not a top-level key per manager.
//
// `gh` installs `gh` CLI extensions from the same newline-separated list, one `owner/repo` per
// line. **Owner-qualified, never the bare name**: four community forks answer to `gh-stack`, so
// the owner *is* the identity — `gh extension install stack` is ambiguous and unpinnable. Ordering
// gotcha: this arm shells out to `gh`, so declare it *after* whichever `pkg` entry installs `gh`
// (entries run in array order, sections in declaration order). boom has no cross-section
// dependency mechanism; get the order wrong on a fresh machine and the arm reports
// `gh not installed`.
//
// `remove_on_uninstall` settles the uninstall asymmetry with one explicit key instead of nine
// implicit policies. Absent = today's behavior exactly, so no existing boomfile changes: the six
// user-scoped managers (cargo/npm/pipx/gem/flatpak/gh) remove what they installed, apt/dnf never
// do. `= true` opts apt/dnf **in** (a root-level `apt-get remove -y` of the declared list — hence
// opt-in, per entry); `= false` opts a user-scoped manager **out**, for a global tool boom installs
// but must not reclaim. Spelled to match `dir`'s `remove_on_uninstall` rather than a bare
// `uninstall`. Rejected on brew/mise below — the `v.check` rides on the *object* because the
// constraint is cross-field (the key's legality depends on `manager`).
// `cleanup` (brew only) closes the one-directional gap in `brew bundle`: it installs what the
// Brewfile names and NEVER removes what the Brewfile omits, so a hand-installed package stays
// forever while a fresh machine silently never gets it. Drift in the direction nothing reports.
//
// Absent = today's behavior. `"check"` makes `verify` report installed-but-undeclared as drift.
// `"uninstall"` additionally lets `sync` remove them (`brew bundle cleanup --force`).
//
// Split in two on purpose, and `"check"` is the one to reach for first: `brew bundle cleanup`
// removes everything the Brewfile does not name, which on a machine that has ever installed
// something by hand is a much larger set than expected. Seeing the list before authorizing the
// removal is the whole difference between converging and losing a tool you needed.
//
// This is deliberately NOT `remove_on_uninstall`, which is rejected below and stays rejected:
// that key means "remove exactly what this manifest declares" and `cleanup` is its inverse —
// remove exactly what it does not.
const PkgSchema = v.pipe(
  v.strictObject({
    manager: v.picklist(["brew", "mise", "apt", "dnf", "cargo", "npm", "pipx", "gem", "flatpak", "gh"]),
    file: v.optional(v.string()),
    remove_on_uninstall: v.optional(v.boolean()),
    cleanup: v.optional(v.picklist(["check", "uninstall"])),
  }),
  v.check(
    (p) => p.remove_on_uninstall === undefined || (p.manager !== "brew" && p.manager !== "mise"),
    "`remove_on_uninstall` isn't supported for `brew`/`mise` — their declared set lives in a " +
      "Brewfile / the repo's mise config, and neither has a \"remove exactly what this file " +
      'declares" verb (`brew bundle cleanup` does the opposite). Tear those down with a `run` ' +
      'step bound to `on = "uninstall"`.',
  ),
  v.check(
    (p) => p.cleanup === undefined || p.manager === "brew",
    "`cleanup` is brew-only — it wraps `brew bundle cleanup`, which has no equivalent in the " +
      "other managers. For those, the declared set is the manifest and `remove_on_uninstall` " +
      "governs teardown.",
  ),
);

// A path that must NOT exist: sync removes it, verify fails while it is there, uninstall
// leaves it alone. The inverse of every other resource, and the gap `check` cannot fill —
// `check` asserts things *about* a file that exists, and its `missing_file = "pass"` says
// "absent is acceptable", never "absent is required".
//
// The shape comes up wherever a tool writes its own config behind your back: Claude Code
// creates `settings.local.json` on an "always allow" click, and `.gitignore` can stop such a
// file being committed but never stops it existing — so a permission nobody reviewed lives on
// disk, invisible to every gate that reads tracked files.
//
// Removal goes through the journal, so the file lands in the run's backup tree and
// `boom rollback` restores it. `recursive` is required for a directory: without it one typo in
// a path is a silent recursive delete on the next sync.
const AbsentSchema = v.strictObject({
  path: v.string(),
  message: v.optional(v.string()),
  recursive: v.optional(v.boolean()),
});

// The verbs a `run` step can bind to. `on` accepts a single verb or a list, so "run on sync
// *and* uninstall" is one entry, not a duplicated pair.
const VerbSchema = v.picklist(["sync", "verify", "uninstall"]);

const RunSchema = v.strictObject({
  on: v.union([VerbSchema, v.array(VerbSchema)]),
  cmd: v.string(),
  // Optional wall-clock cap (seconds). A hung `run` step would otherwise block the whole
  // reconcile indefinitely; with this set, boom kills the step and reports a timeout
  // failure. Omit for no limit (the historical behavior).
  timeout: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  // Idempotence guards. A `run` step otherwise fires on every reconcile, which is why real
  // boomfiles hand-roll `foo list | grep -q bar || foo add bar` into `cmd`; hoisting the
  // predicate into the schema makes "already done" declarative and keeps the report honest
  // (a skipped step says so instead of pretending to converge). `unless` is a shell
  // *predicate* — exit 0 means "already satisfied, skip" — not a second step to run; it is
  // the same conditionally-executed-shell shape `check.repair` already carries, and it
  // inherits that resource's dry-run discipline (never spawned by a preview). `creates` is a
  // path (`~`-expanded; relative resolves against the repo, matching the step's own cwd):
  // skip when it exists. Both set ⇒ skip when *either* is satisfied (OR).
  //
  // Gotcha: the guards gate every verb the step binds to — there is no verb-specific branch,
  // because the engine is one loop. On an `on = "uninstall"` step `creates` therefore reads
  // "skip when the path exists", which is backwards for a teardown; use `unless` there.
  unless: v.optional(v.string()),
  creates: v.optional(v.string()),
});

// A hook's `with` inputs carry arbitrary TOML values (numbers, bools, arrays, tables) — not
// just strings — so a hook receives them already typed instead of re-parsing "true"/"5".
// This is the public extension contract; widening it now (pre-1.0) avoids a breaking change
// once hooks proliferate.
const HookSchema = v.strictObject({
  name: v.string(),
  with: v.optional(v.record(v.string(), v.unknown())),
});

// A macOS default: `defaults write <domain> <key> -<type> <value>` (OS-gated to darwin).
// `type` is optional: TOML already types the value (`true`→bool, `3`→int, `0.5`→float,
// `"x"`→string), so it's inferred from the value and only needs stating to override an edge
// case (force a float for an integer-valued float, or a string for a numeric string).
const OsxDefaultSchema = v.strictObject({
  domain: v.string(),
  key: v.string(),
  type: v.optional(v.picklist(["bool", "int", "float", "string"])),
  value: v.union([v.string(), v.number(), v.boolean()]),
});

// A standalone directory to ensure exists (with an optional mode) — the declarative form of
// a `run` + `mkdir -p`/`chmod`. `remove_on_uninstall = true` opts into removing it on
// uninstall *only if empty* (dirs may hold user data, so the default is to leave it).
const DirSchema = v.strictObject({
  path: v.string(),
  mode: v.optional(ModeSchema),
  remove_on_uninstall: v.optional(v.boolean()),
});

// A content assertion on a file: every `present` regex must match and every `absent` regex
// must not. On `verify` a failure contributes to the exit code + JSON report; on `sync`, if
// `repair` is set and the assertion currently fails, that shell command runs to make it so —
// so `check` converges drift like every other resource instead of only reporting it.
// `missing_file` picks how a nonexistent file is treated (default `fail` — a guardrail that
// silently stops guarding when its file vanishes is worse than useless).
//
// Three kinds of assertion, all sharing `message`/`repair`/`missing_file`:
//
//   present/absent  regexes over the file's TEXT
//   json            assertions over the file's PARSED structure
//   cmd             a command's exit status and output
//
// The last two exist because a regex over text is the wrong tool for the two things consumers
// kept hand-rolling `run` steps for. Asserting a JSON key by regex means writing
// `'"model"\s*:\s*"[^"]*fable'` and hoping formatting never changes; asserting that a command
// succeeds means a `run` step with `unless`, which reports through a shell exit code rather
// than the drift report. Both were common enough in boom's own reference consumer to account
// for most of its verify-only `run` steps.

// One assertion against a parsed JSON document. `key` is a dot path; a numeric segment indexes
// an array (`hooks.PreToolUse.0.matcher`). Exactly one predicate per entry.
const JsonAssertSchema = v.pipe(
  v.strictObject({
    key: v.string(),
    // Deep-equality against a literal. Scalars cover the real cases; an object/array literal
    // works too, and compares structurally.
    equals: v.optional(v.union([v.string(), v.number(), v.boolean(), v.null_()])),
    // The key resolves to something (including `null`, which is a value a config can mean).
    present: v.optional(v.boolean()),
    // The key does not resolve at all.
    absent: v.optional(v.boolean()),
    // An array-valued key includes this element.
    contains: v.optional(v.union([v.string(), v.number(), v.boolean()])),
  }),
  v.check(
    (e) =>
      [
        e.equals !== undefined,
        e.present !== undefined,
        e.absent !== undefined,
        e.contains !== undefined,
      ].filter(Boolean).length === 1,
    "a json assertion needs exactly one of equals / present / absent / contains",
  ),
);

const CheckSchema = v.pipe(
  v.strictObject({
    // Optional so a `cmd` check — which asserts about a command rather than a file — does not
    // have to invent a path. Required for every file-shaped assertion; see the check below.
    path: v.optional(v.string()),
    present: v.optional(v.array(v.string())),
    absent: v.optional(v.array(v.string())),
    json: v.optional(v.array(JsonAssertSchema)),
    // Assert about a COMMAND rather than a file: it must exit `exit` (default 0), and its
    // combined output must match every `stdout_present` regex and no `stdout_absent` one.
    // Read-only by contract — this runs on `verify`, so a `cmd` that mutates anything turns a
    // read-only drift check into a write. Use `repair` for the mutating half.
    cmd: v.optional(v.string()),
    exit: v.optional(v.number()),
    stdout_present: v.optional(v.array(v.string())),
    stdout_absent: v.optional(v.array(v.string())),
    message: v.optional(v.string()),
    missing_file: v.optional(v.picklist(["skip", "fail", "pass"])),
    repair: v.optional(v.string()),
  }),
  v.check(
    (e) => (e.path === undefined) !== (e.cmd === undefined),
    "a check needs exactly one of `path` (a file assertion) or `cmd` (a command assertion)",
  ),
  v.check(
    (e) =>
      e.cmd === undefined ||
      (e.present === undefined &&
        e.absent === undefined &&
        e.json === undefined &&
        e.missing_file === undefined),
    "a `cmd` check uses exit / stdout_present / stdout_absent — present, absent, json and missing_file are for a `path` check",
  ),
  v.check(
    (e) =>
      e.path === undefined ||
      (e.exit === undefined && e.stdout_present === undefined && e.stdout_absent === undefined),
    "exit / stdout_present / stdout_absent belong to a `cmd` check, not a `path` check",
  ),
);

// A rendered secret: resolve a secret reference (or a whole template of them) to a file at sync
// time, so a machine's secret-bearing config is declared like everything else instead of living
// out of band. `ref` is a single reference (`op://vault/item/field`, `env:VAR`, `pass:path`, or
// an encrypted file path); `template` is a repo-relative file whose embedded references are
// filled in — exactly one is required. `backend` picks the resolver (op/env/pass/age/sops); when
// absent it's inferred from the ref scheme (`op://`→op, `env:`→env, `pass:`→pass) or a file
// extension (`.age`→age, `.sops.*`/`.enc`→sops), defaulting to op so every existing `op://…`
// boomfile keeps working untouched. boom never journals or backs up the plaintext IT renders —
// a fresh render's undo is a plain remove — but a pre-existing file at `dst` is the user's, so
// it is left alone by default and only displaced (backed up, recoverably) under
// `boom source --fix`. `mode` defaults to 0600 (a secret nobody else can read). The declarative
// counterpart to `tmpl`, for secrets.
const SecretSchema = v.pipe(
  v.strictObject({
    dst: v.string(),
    ref: v.optional(v.string()),
    template: v.optional(v.string()),
    backend: v.optional(v.picklist(["op", "env", "pass", "age", "sops"])),
    mode: v.optional(ModeSchema),
  }),
  v.check(
    (s) => (s.ref === undefined) !== (s.template === undefined),
    "a secret needs exactly one of `ref` (an op:// reference) or `template` (a file of op:// references)",
  ),
);

// A rendered template: read one repo-relative `src`, substitute `${NAME}` placeholders from
// the top-level `[vars]` table (plus the `${env:VAR}`/`${host}`/`${os}` vocabulary), and write
// the result to `dst`. The replacement for the retired `copy.expand`, which rendered that same
// vocabulary and nothing else: one template + per-profile vars instead of N near-identical
// machine-specific overlay files. An unknown `${NAME}` is a hard failure (a silently-unresolved
// placeholder in a config is worse than a loud error), whereas a literal shell `${FOO:-bar}`
// (anything but a bare identifier) is left verbatim.
const TmplSchema = v.strictObject({
  src: v.string(),
  dst: v.string(),
  mode: v.optional(ModeSchema),
});

// A macOS LaunchAgent: link a plist into ~/Library/LaunchAgents and own its launchctl
// lifecycle (load -w on sync, unload on uninstall). OS-gated to darwin. `dst` defaults to
// ~/Library/LaunchAgents/<basename(src)>.
const LaunchdSchema = v.strictObject({
  src: v.string(),
  dst: v.optional(v.string()),
});

// A systemd *user* unit: the Linux twin of `launchd`. boom renders a `.service` (and, when
// `timer` is set, a `.timer`) from these fields into ~/.config/systemd/user and owns its
// `systemctl --user` lifecycle (daemon-reload + enable --now on sync, disable --now on
// uninstall). OS-gated to linux. Unlike `launchd` (which links a user-authored plist), the
// unit text is generated here, so an unchanged stanza re-renders byte-identical → a no-op
// sync. `timer` is a systemd OnCalendar expression ("daily", "*-*-* 04:00:00"); with it set,
// the timer (not the service) is what gets enabled. `env` becomes `Environment=K=V` lines.
const SystemdSchema = v.strictObject({
  name: v.string(),
  description: v.optional(v.string()),
  exec: v.string(),
  timer: v.optional(v.string()),
  enable: v.optional(v.boolean()),
  env: v.optional(v.record(v.string(), v.string())),
});

const OsSchema = v.picklist(["darwin", "linux"]);

// A section/overlay gate: runs only when every specified constraint matches the
// host. `os`/`host` auto-match the machine; `profile` requires `--profile <name>`.
//
// Each axis takes a scalar *or* a list: a list is any-of **within** an axis, while separate
// axes still AND. That is the only shape that expresses "the laptops" or "work or personal"
// without duplicating the whole section per value — and a bare scalar stays valid, meaning
// exactly the one-element list, so every existing boomfile parses unchanged.
const anyOfSchema = <T extends v.GenericSchema>(s: T) => v.optional(v.union([s, v.array(s)]));

const WhenSchema = v.strictObject({
  os: anyOfSchema(OsSchema),
  host: anyOfSchema(v.string()),
  profile: anyOfSchema(v.string()),
});

const SectionSchema = v.strictObject({
  name: v.string(),
  when: v.optional(WhenSchema),
  link: v.optional(v.array(FileSchema)),
  copy: v.optional(v.array(FileSchema)),
  dir: v.optional(v.array(DirSchema)),
  pkg: v.optional(v.array(PkgSchema)),
  osx_default: v.optional(v.array(OsxDefaultSchema)),
  launchd: v.optional(v.array(LaunchdSchema)),
  tmpl: v.optional(v.array(TmplSchema)),
  secret: v.optional(v.array(SecretSchema)),
  systemd: v.optional(v.array(SystemdSchema)),
  run: v.optional(v.array(RunSchema)),
  check: v.optional(v.array(CheckSchema)),
  absent: v.optional(v.array(AbsentSchema)),
  hook: v.optional(v.array(HookSchema)),
});

// A schedule interval: a bare number (seconds) or a `<n>s|m|h` string ("15m", "1h", "30s").
// launchd's StartInterval is in seconds; parseInterval (lib/launchd.ts) normalizes into it.
const IntervalSchema = v.pipe(
  v.string(),
  v.regex(/^\d+[smh]?$/, 'interval must be like "15m", "1h", "30s", or a bare seconds count'),
);

// A scheduled boom invocation: run `boom <cmd>` on the `every` interval via a launchd timer
// (macOS-only). `cmd` is a boom subcommand line ("verify", "code fetch"); one array entry
// replaces the old bespoke `verify_schedule` / `code_fetch_schedule` keys and lets any boom
// command be scheduled without growing a new schema key each time.
const ScheduleSchema = v.strictObject({
  cmd: v.string(),
  every: IntervalSchema,
});

// The top-level `[boom]` table: machine-global, self-wiring behaviors folded into the
// reconcile boom already runs — so a consumer stops hand-rolling `run`/plist boilerplate for
// boom-invoking-boom. Every field is opt-in; an absent `[boom]` table changes nothing.
const BoomSettingsSchema = v.strictObject({
  // Regenerate ~/.claude/skills/boom/SKILL.md from the running binary on every sync, so the
  // self-describing skill can never lag a `boom upgrade`.
  skill_on_sync: v.optional(v.boolean()),
  // After a sync: `check` prints a one-line notice when a newer boom release is available
  // (cheap, non-fatal, offline-safe); `auto` also self-upgrades (opt-in; hands-off machines).
  upgrade_on_sync: v.optional(v.picklist(["check", "auto"])),
  // Install/refresh launchd timers that run `boom <cmd>` on an interval (macOS-only).
  schedule: v.optional(v.array(ScheduleSchema)),
  // RETIRED, and deliberately still accepted. The vault-backed askpass helper this named was
  // removed: it made `boom askpass <ref>` a real command that printed a resolved secret to
  // stdout, which is a second way to read a vault value under a program name a machine's own
  // controls are unlikely to have denied.
  //
  // Unlike `copy.expand` above, this is NOT `v.never`. That pattern is right when the migration
  // is another config key — the error names it and the user edits one line. Here the migration
  // is an ENVIRONMENT action (export SUDO_ASKPASS yourself), which no config edit expresses, so
  // failing the whole boomfile would strand a machine over a key whose replacement isn't in the
  // file at all. The value is parsed and ignored; reconcile warns when it is set. Delete the key
  // at 1.0, once the warning has outlived its usefulness.
  sudo_askpass: v.optional(v.string()),
  // After a sync, commit a one-file summary of this machine's state (boom version, drift
  // verdict, timestamp) to `.boom/machines/<host>.json` in the config repo — so `boom fleet`
  // can answer "which of my machines are drifted / on what version" from the repo you already
  // push. Opt-in: it makes sync write + commit to the repo, which a hands-off machine may not want.
  fleet: v.optional(v.boolean()),
  // When a scheduled `verify` finds drift, raise a desktop notification (macOS osascript /
  // Linux notify-send) instead of letting the 0/2/1 exit code die in a timer log. Opt-in;
  // a no-op on a machine with no notifier.
  notify: v.optional(v.boolean()),
});

export const BoomfileSchema = v.strictObject({
  boom: v.optional(BoomSettingsSchema),
  // Machine-global substitution values for the `tmpl` resource. A flat string→string map,
  // typically differentiated per machine via a `boomfile.<profile>.toml` overlay — the whole
  // point of `tmpl` over N overlay files is that only these values change, not the template.
  vars: v.optional(v.record(v.string(), v.string())),
  // REQUIRED, and it must stay that way — see OverlaySchema below. A base boomfile.toml with no
  // `[[section]]` is not "a config that declares nothing", it is a config that failed to load
  // (empty file, half-written file, commented-out sections). Accepting it hands reconcile an
  // empty `declared` set, and orphan reaping then removes every destination in the prior
  // manifest and exits 0 — a silent wipe of the machine. Loud failure here is the guard.
  section: v.array(SectionSchema),
});

// The schema for an OVERLAY (`boomfile.<os|host|profile>.toml`) — the base schema with `section`
// made optional, and ONLY there. An overlay legitimately declares nothing but `[vars]`/`[boom]`:
// it is a per-machine *modification* of a base that was already validated, so "no sections" is a
// real, intended shape. The base file has no such reading, which is why this is a second schema
// rather than a widening of BoomfileSchema — one file's harmless default is the other's data loss.
//
// Spread over `.entries` (not `v.partial`): `v.partial` yields a bare `v.optional`, so
// `overlay.section` would be `Section[] | undefined` at every reader. The `[]` DEFAULT keeps
// `v.InferOutput` non-optional. `strictObject` is preserved, so a typo'd `[[sections]]` in an
// overlay is still an unknown top-level key and still fails.
export const OverlaySchema = v.strictObject({
  ...BoomfileSchema.entries,
  section: v.optional(v.array(SectionSchema), []),
});

export type File = v.InferOutput<typeof FileSchema>;
export type Pkg = v.InferOutput<typeof PkgSchema>;
export type Dir = v.InferOutput<typeof DirSchema>;
export type Check = v.InferOutput<typeof CheckSchema>;
export type Absent = v.InferOutput<typeof AbsentSchema>;
export type Secret = v.InferOutput<typeof SecretSchema>;
export type Tmpl = v.InferOutput<typeof TmplSchema>;
export type Launchd = v.InferOutput<typeof LaunchdSchema>;
export type Systemd = v.InferOutput<typeof SystemdSchema>;
export type Run = v.InferOutput<typeof RunSchema>;
export type Hook = v.InferOutput<typeof HookSchema>;
export type OsxDefault = v.InferOutput<typeof OsxDefaultSchema>;
export type Schedule = v.InferOutput<typeof ScheduleSchema>;
export type Section = v.InferOutput<typeof SectionSchema>;
export type BoomSettings = v.InferOutput<typeof BoomSettingsSchema>;
export type Boomfile = v.InferOutput<typeof BoomfileSchema>;
export type Overlay = v.InferOutput<typeof OverlaySchema>;
