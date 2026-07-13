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
  brewfile: v.optional(v.string()),
  mise: v.optional(v.boolean()),
  osx_default: v.optional(v.array(OsxDefaultSchema)),
  run: v.optional(v.array(RunSchema)),
  hook: v.optional(v.array(HookSchema)),
});

export const BoomfileSchema = v.strictObject({
  section: v.array(SectionSchema),
});

export type When = v.InferOutput<typeof WhenSchema>;
export type Link = v.InferOutput<typeof LinkSchema>;
export type Glob = v.InferOutput<typeof GlobSchema>;
export type Run = v.InferOutput<typeof RunSchema>;
export type Hook = v.InferOutput<typeof HookSchema>;
export type OsxDefault = v.InferOutput<typeof OsxDefaultSchema>;
export type Section = v.InferOutput<typeof SectionSchema>;
export type Boomfile = v.InferOutput<typeof BoomfileSchema>;
