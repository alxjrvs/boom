// Minimal ANSI palette, gated by a color flag (NO_COLOR / non-TTY → plain text).
// Kept tiny and explicit (mirrors the bash engine's lib.sh palette) rather than
// pulling a dependency — legibility over abstraction.
//
// The enable decision defers to Bun.enableANSIColors, the runtime's own resolution
// of the whole matrix a well-behaved CLI must honor — stdout is-a-TTY, NO_COLOR,
// FORCE_COLOR, and TERM=dumb — so piping (`boom verify > run.log` / `| grep`) no
// longer leaks escape codes, which the old NO_COLOR-only check silently did.
const CODES = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;

const RESET = "\x1b[0m";

export type ColorName = keyof typeof CODES;

export function paint(enabled: boolean, name: ColorName, s: string): string {
  return enabled ? `${CODES[name]}${s}${RESET}` : s;
}

export function colorEnabled(env: Record<string, string | undefined>): boolean {
  // Explicit env overrides win (and keep tests deterministic regardless of the test
  // runner's TTY): NO_COLOR forces off, FORCE_COLOR forces on. Absent both, defer to
  // Bun's own TTY/terminal-capability resolution.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return true;
  return Bun.enableANSIColors;
}
