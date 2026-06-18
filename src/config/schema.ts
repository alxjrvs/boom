// The botufile.toml schema (nested-by-section). This typed contract is the source
// of truth shared by the loader, the reconcile engine (M2), and the dotFiles
// migration prompt. Within a section, resources run by phase:
//   link → copy → glob → packages (brewfile/mise) → run → hook.
import * as v from "valibot";

export const LinkSchema = v.object({
  src: v.string(),
  dst: v.string(),
  mode: v.optional(v.string()),
});

export const GlobSchema = v.object({
  pattern: v.string(),
  into: v.string(),
});

export const RunSchema = v.object({
  on: v.picklist(["apply", "verify", "uninstall"]),
  cmd: v.string(),
});

export const HookSchema = v.object({
  name: v.string(),
  with: v.optional(v.record(v.string(), v.string())),
});

// A macOS default: `defaults write <domain> <key> -<type> <value>` (OS-gated to darwin).
export const OsxDefaultSchema = v.object({
  domain: v.string(),
  key: v.string(),
  type: v.picklist(["bool", "int", "float", "string"]),
  value: v.union([v.string(), v.number(), v.boolean()]),
});

// A section/overlay gate: runs only when every specified constraint matches the
// host. `os`/`host` auto-match the machine; `profile` requires `--profile <name>`.
export const WhenSchema = v.object({
  os: v.optional(v.picklist(["darwin", "linux"])),
  host: v.optional(v.string()),
  profile: v.optional(v.string()),
});

export const SectionSchema = v.object({
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

export const BotufileSchema = v.object({
  section: v.array(SectionSchema),
});

export type When = v.InferOutput<typeof WhenSchema>;
export type Link = v.InferOutput<typeof LinkSchema>;
export type Glob = v.InferOutput<typeof GlobSchema>;
export type Run = v.InferOutput<typeof RunSchema>;
export type Hook = v.InferOutput<typeof HookSchema>;
export type OsxDefault = v.InferOutput<typeof OsxDefaultSchema>;
export type Section = v.InferOutput<typeof SectionSchema>;
export type Botufile = v.InferOutput<typeof BotufileSchema>;
