// The boomfile.toml schema (nested-by-section). This typed contract is the source of
// truth shared by the loader and the reconcile engine. Within a section, resources run
// by phase:  link → copy → secret → dir → pkg → osx_default → launchd → run → check → hook.
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
// placed under it, preserving the path structure below the glob's static prefix. `expand`
// (honored by `copy` only — a symlink has no content to render) substitutes `${env:VAR}` /
// `${host}` / `${os}` in the file before writing: the escape hatch for the one dotfile that
// must differ per machine, without dropping to a hook.
export const FileSchema = v.strictObject({
  src: v.string(),
  dst: v.string(),
  mode: v.optional(ModeSchema),
  expand: v.optional(v.boolean()),
});

// A package manager to satisfy: one array entry per manager, replacing the old scalar
// `brewfile = "…"` + boolean `mise = true` (the two resources that broke the array-of-tables
// shape every other resource has). `file` is the manager's manifest: a Brewfile path for
// `brew` (default "Brewfile"); a newline-separated package list for `apt`/`dnf` (Linux) and the
// user-scoped managers `cargo`/`npm` (global)/`pipx`/`gem`/`flatpak` (`flatpak` Linux-only), `#`
// comments allowed; `mise` reads the repo's own mise config and ignores it. Each manager is one
// dispatch arm in packages.ts — the registry north star, not a top-level key per manager.
export const PkgSchema = v.strictObject({
  manager: v.picklist(["brew", "mise", "apt", "dnf", "cargo", "npm", "pipx", "gem", "flatpak"]),
  file: v.optional(v.string()),
});

// The verbs a `run` step can bind to. `on` accepts a single verb or a list, so "run on sync
// *and* uninstall" is one entry, not a duplicated pair.
const VerbSchema = v.picklist(["sync", "verify", "uninstall"]);

export const RunSchema = v.strictObject({
  on: v.union([VerbSchema, v.array(VerbSchema)]),
  cmd: v.string(),
  // Optional wall-clock cap (seconds). A hung `run` step would otherwise block the whole
  // reconcile indefinitely; with this set, boom kills the step and reports a timeout
  // failure. Omit for no limit (the historical behavior).
  timeout: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

// A hook's `with` inputs carry arbitrary TOML values (numbers, bools, arrays, tables) — not
// just strings — so a hook receives them already typed instead of re-parsing "true"/"5".
// This is the public extension contract; widening it now (pre-1.0) avoids a breaking change
// once hooks proliferate.
export const HookSchema = v.strictObject({
  name: v.string(),
  with: v.optional(v.record(v.string(), v.unknown())),
});

// A macOS default: `defaults write <domain> <key> -<type> <value>` (OS-gated to darwin).
// `type` is optional: TOML already types the value (`true`→bool, `3`→int, `0.5`→float,
// `"x"`→string), so it's inferred from the value and only needs stating to override an edge
// case (force a float for an integer-valued float, or a string for a numeric string).
export const OsxDefaultSchema = v.strictObject({
  domain: v.string(),
  key: v.string(),
  type: v.optional(v.picklist(["bool", "int", "float", "string"])),
  value: v.union([v.string(), v.number(), v.boolean()]),
});

// A standalone directory to ensure exists (with an optional mode) — the declarative form of
// a `run` + `mkdir -p`/`chmod`. `remove_on_uninstall = true` opts into removing it on
// uninstall *only if empty* (dirs may hold user data, so the default is to leave it).
export const DirSchema = v.strictObject({
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
export const CheckSchema = v.strictObject({
  path: v.string(),
  present: v.optional(v.array(v.string())),
  absent: v.optional(v.array(v.string())),
  message: v.optional(v.string()),
  missing_file: v.optional(v.picklist(["skip", "fail", "pass"])),
  repair: v.optional(v.string()),
});

// A rendered secret: resolve a secret reference (or a whole template of them) to a file at sync
// time, so a machine's secret-bearing config is declared like everything else instead of living
// out of band. `ref` is a single reference (`op://vault/item/field`, `env:VAR`, `pass:path`, or
// an encrypted file path); `template` is a repo-relative file whose embedded references are
// filled in — exactly one is required. `backend` picks the resolver (op/env/pass/age/sops); when
// absent it's inferred from the ref scheme (`op://`→op, `env:`→env, `pass:`→pass) or a file
// extension (`.age`→age, `.sops.*`/`.enc`→sops), defaulting to op so every existing `op://…`
// boomfile keeps working untouched. The plaintext is never journaled or backed up (that would
// defeat the point), so a secret's undo is a plain remove, and `mode` defaults to 0600 (a secret
// nobody else can read). The declarative counterpart to `copy` + `expand`, for secrets.
export const SecretSchema = v.pipe(
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
// the top-level `[vars]` table (plus the `${env:VAR}`/`${host}`/`${os}` vocabulary `copy`'s
// `expand` already understands), and write the result to `dst`. The first-class,
// strict-superset form of `copy` + `expand`: one template + per-profile vars instead of N
// near-identical machine-specific overlay files. An unknown `${NAME}` is a hard failure (a
// silently-unresolved placeholder in a config is worse than a loud error), whereas a literal
// shell `${FOO:-bar}` (anything but a bare identifier) is left verbatim like `expand` does.
export const TmplSchema = v.strictObject({
  src: v.string(),
  dst: v.string(),
  mode: v.optional(ModeSchema),
});

// A macOS LaunchAgent: link a plist into ~/Library/LaunchAgents and own its launchctl
// lifecycle (load -w on sync, unload on uninstall). OS-gated to darwin. `dst` defaults to
// ~/Library/LaunchAgents/<basename(src)>.
export const LaunchdSchema = v.strictObject({
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
export const SystemdSchema = v.strictObject({
  name: v.string(),
  description: v.optional(v.string()),
  exec: v.string(),
  timer: v.optional(v.string()),
  enable: v.optional(v.boolean()),
  env: v.optional(v.record(v.string(), v.string())),
});

// A section/overlay gate: runs only when every specified constraint matches the
// host. `os`/`host` auto-match the machine; `profile` requires `--profile <name>`.
export const WhenSchema = v.strictObject({
  os: v.optional(v.picklist(["darwin", "linux"])),
  host: v.optional(v.string()),
  profile: v.optional(v.string()),
});

export const SectionSchema = v.strictObject({
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
export const ScheduleSchema = v.strictObject({
  cmd: v.string(),
  every: IntervalSchema,
});

// The top-level `[boom]` table: machine-global, self-wiring behaviors folded into the
// reconcile boom already runs — so a consumer stops hand-rolling `run`/plist boilerplate for
// boom-invoking-boom. Every field is opt-in; an absent `[boom]` table changes nothing.
export const BoomSettingsSchema = v.strictObject({
  // Regenerate ~/.claude/skills/boom/SKILL.md from the running binary on every sync, so the
  // self-describing skill can never lag a `boom upgrade`.
  skill_on_sync: v.optional(v.boolean()),
  // After a sync: `check` prints a one-line notice when a newer boom release is available
  // (cheap, non-fatal, offline-safe); `auto` also self-upgrades (opt-in; hands-off machines).
  upgrade_on_sync: v.optional(v.picklist(["check", "auto"])),
  // Install/refresh launchd timers that run `boom <cmd>` on an interval (macOS-only).
  schedule: v.optional(v.array(ScheduleSchema)),
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

// A reusable config module: another boom config repo (`owner/repo[@ref]`, a git URL, or a
// path relative to this repo) whose sections are merged in after the base boomfile — so a
// team can compose a machine from vetted, shared pieces instead of authoring every section
// by hand. Resolved + merged during reconcile (not at every config load), and fetched into a
// modules cache; a module's own sections still gate by their `when`. See config/modules.ts.
const UseSchema = v.pipe(
  v.string(),
  v.regex(/\S/, "a module reference must be a non-empty owner/repo, git URL, or path"),
);

export const BoomfileSchema = v.strictObject({
  boom: v.optional(BoomSettingsSchema),
  // Modules to compose in before this repo's own sections (resolved during reconcile).
  use: v.optional(v.array(UseSchema)),
  // Machine-global substitution values for the `tmpl` resource. A flat string→string map,
  // typically differentiated per machine via a `boomfile.<profile>.toml` overlay — the whole
  // point of `tmpl` over N overlay files is that only these values change, not the template.
  vars: v.optional(v.record(v.string(), v.string())),
  section: v.array(SectionSchema),
});

export type When = v.InferOutput<typeof WhenSchema>;
export type File = v.InferOutput<typeof FileSchema>;
export type Pkg = v.InferOutput<typeof PkgSchema>;
export type Dir = v.InferOutput<typeof DirSchema>;
export type Check = v.InferOutput<typeof CheckSchema>;
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
