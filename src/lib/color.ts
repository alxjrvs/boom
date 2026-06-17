// Minimal ANSI palette, gated by a color flag (NO_COLOR / non-TTY → plain text).
// Kept tiny and explicit (mirrors the bash engine's lib.sh palette) rather than
// pulling a dependency — legibility over abstraction.
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
  return env.NO_COLOR === undefined || env.NO_COLOR === "";
}
