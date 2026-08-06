// Shared flag/positional building blocks, so command modules stop re-declaring the same
// tiny parsers. Stricli's `parse` for a string flag is the identity function; spelling it
// out (`parse: (s: string) => s`) at ~10 call sites is noise — import `str` instead.
export const str = (s: string): string => s;

// The flags more than one command declares, spelled once. `as const` is load-bearing: stricli
// narrows `kind` to a literal, so a widened `string` fails to match its parameter types.
export const onlyFlag = {
  kind: "parsed",
  parse: str,
  variadic: true,
  optional: true,
  brief: "Limit to these section names",
} as const;
export const profileFlag = {
  kind: "parsed",
  parse: str,
  variadic: true,
  optional: true,
  brief: "Activate a profile (repeatable)",
} as const;
export const jsonFlag = { kind: "boolean", optional: true, brief: "Emit a structured JSON report" } as const;
// Off by default: quiet output shows only what changed + what needs attention + the summary.
// --verbose restores the per-item firehose (every ✓, every already-in-place skip).
export const verboseFlag = {
  kind: "boolean",
  optional: true,
  brief: "Show every step, including already-in-place items (default: only changes + attention)",
} as const;
