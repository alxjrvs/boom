// The boomfile.toml schema (nested-by-section). This typed contract is the source of
// truth shared by the loader and the reconcile engine. Within a section, resources run
// by phase:  link → copy → glob → packages (brewfile/mise) → osx_default → run → hook.
import * as v from "valibot";

// A Unix permission bitmask as an octal string ("644", "0700"). Validated here at the
// boundary so a bad value fails config load with a clear message, instead of a bare
// Number.parseInt(mode, 8) deep in the engine turning "abc" into NaN and chmod throwing.
const ModeSchema = v.pipe(
  v.string(),
  v.regex(/^[0-7]{3,4}$/, 'mode must be an octal string like "644" or "0700"'),
);

// strictObject (not object): unknown keys are a hard error, not silently dropped — so a
// mistyped `brewfle`/`osx_defalt` in a boomfile surfaces as a schema failure at load,
// which is the whole point of a "typed, validated TOML" config.
export const LinkSchema = v.strictObject({
  src: v.string(),
  dst: v.string(),
  mode: v.optional(ModeSchema),
});

export const GlobSchema = v.strictObject({
  pattern: v.string(),
  into: v.string(),
});

export const RunSchema = v.strictObject({
  on: v.picklist(["sync", "verify", "uninstall"]),
  cmd: v.string(),
  // Optional wall-clock cap (seconds). A hung `run` step would otherwise block the whole
  // reconcile indefinitely; with this set, boom kills the step and reports a timeout
  // failure. Omit for no limit (the historical behavior).
  timeout: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

export const HookSchema = v.strictObject({
  name: v.string(),
  with: v.optional(v.record(v.string(), v.string())),
});

// A macOS default: `defaults write <domain> <key> -<type> <value>` (OS-gated to darwin).
export const OsxDefaultSchema = v.strictObject({
  domain: v.string(),
  key: v.string(),
  type: v.picklist(["bool", "int", "float", "string"]),
  value: v.union([v.string(), v.number(), v.boolean()]),
});

// A standalone directory to ensure exists (with an optional mode) — the declarative form of
// a `run` + `mkdir -p`/`chmod`. `manage = true` opts into removing it on uninstall *only if
// empty* (dirs may hold user data, so the default is to leave it).
export const DirSchema = v.strictObject({
  path: v.string(),
  mode: v.optional(ModeSchema),
  manage: v.optional(v.boolean()),
});

// A verify-time content assertion on a file: every `present` regex must match and every
// `absent` regex must not, else the check fails (contributing to `boom verify`'s exit code
// and JSON report). `missing_file` picks how a nonexistent file is treated. The declarative
// form of the escaping-heavy `grep`-in-a-`run` guardrails.
export const CheckSchema = v.strictObject({
  file: v.string(),
  present: v.optional(v.array(v.string())),
  absent: v.optional(v.array(v.string())),
  message: v.optional(v.string()),
  missing_file: v.optional(v.picklist(["skip", "fail", "pass"])),
});

// A macOS LaunchAgent: link a plist into ~/Library/LaunchAgents and own its launchctl
// lifecycle (load -w on sync, unload on uninstall). OS-gated to darwin. `dst` defaults to
// ~/Library/LaunchAgents/<basename(src)>.
export const LaunchdSchema = v.strictObject({
  src: v.string(),
  dst: v.optional(v.string()),
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
  link: v.optional(v.array(LinkSchema)),
  copy: v.optional(v.array(LinkSchema)),
  glob: v.optional(v.array(GlobSchema)),
  dir: v.optional(v.array(DirSchema)),
  brewfile: v.optional(v.string()),
  mise: v.optional(v.boolean()),
  osx_default: v.optional(v.array(OsxDefaultSchema)),
  launchd: v.optional(v.array(LaunchdSchema)),
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

// The top-level `[boom]` table: machine-global, self-wiring behaviors folded into the
// reconcile boom already runs — so a consumer stops hand-rolling `run`/plist boilerplate for
// boom-invoking-boom. Every field is opt-in; an absent `[boom]` table changes nothing.
export const BoomSettingsSchema = v.strictObject({
  // Regenerate ~/.claude/skills/boom/SKILL.md from the running binary on every sync, so the
  // self-describing skill can never lag a `boom upgrade`.
  skill_on_sync: v.optional(v.boolean()),
  // After a sync, print a one-line notice when a newer boom release is available (cheap,
  // non-fatal, offline-safe).
  upgrade_check_on_sync: v.optional(v.boolean()),
  // After a sync, actually self-upgrade to the latest release (opt-in; hands-off machines).
  upgrade_auto_on_sync: v.optional(v.boolean()),
  // Install/refresh a launchd timer that runs `boom verify` on this interval (macOS-only).
  verify_schedule: v.optional(IntervalSchema),
  // Install/refresh a launchd timer that `git fetch`es every registered `boom code`
  // workspace on this interval, keeping origin warm for agent worktree cuts (macOS-only).
  code_fetch_schedule: v.optional(IntervalSchema),
});

export const BoomfileSchema = v.strictObject({
  boom: v.optional(BoomSettingsSchema),
  section: v.array(SectionSchema),
});

export type When = v.InferOutput<typeof WhenSchema>;
export type Link = v.InferOutput<typeof LinkSchema>;
export type Glob = v.InferOutput<typeof GlobSchema>;
export type Dir = v.InferOutput<typeof DirSchema>;
export type Check = v.InferOutput<typeof CheckSchema>;
export type Launchd = v.InferOutput<typeof LaunchdSchema>;
export type Run = v.InferOutput<typeof RunSchema>;
export type Hook = v.InferOutput<typeof HookSchema>;
export type OsxDefault = v.InferOutput<typeof OsxDefaultSchema>;
export type Section = v.InferOutput<typeof SectionSchema>;
export type BoomSettings = v.InferOutput<typeof BoomSettingsSchema>;
export type Boomfile = v.InferOutput<typeof BoomfileSchema>;
