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
  on: v.picklist(["apply", "verify"]),
  cmd: v.string(),
});

export const HookSchema = v.object({
  name: v.string(),
  with: v.optional(v.record(v.string(), v.string())),
});

export const SectionSchema = v.object({
  name: v.string(),
  link: v.optional(v.array(LinkSchema)),
  copy: v.optional(v.array(LinkSchema)),
  glob: v.optional(v.array(GlobSchema)),
  brewfile: v.optional(v.string()),
  mise: v.optional(v.boolean()),
  run: v.optional(v.array(RunSchema)),
  hook: v.optional(v.array(HookSchema)),
});

export const BotufileSchema = v.object({
  section: v.array(SectionSchema),
});

export type Link = v.InferOutput<typeof LinkSchema>;
export type Glob = v.InferOutput<typeof GlobSchema>;
export type Run = v.InferOutput<typeof RunSchema>;
export type Hook = v.InferOutput<typeof HookSchema>;
export type Section = v.InferOutput<typeof SectionSchema>;
export type Botufile = v.InferOutput<typeof BotufileSchema>;
