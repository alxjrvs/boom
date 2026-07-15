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

// The "cosmic" palette — the site's design tokens (site/index.html) ported to the terminal
// as 24-bit truecolor, so the CLI and the landing page share one identity. Brand hues use the
// lightened tints the site uses for small text on the dark cosmic ground (#0A0712), where the
// pure #7A3CFF violet / #FF2E86 magenta go too dark. Used only by the Reporter's bands mode;
// the six-code ANSI palette above still drives every non-bands surface.
export const COSMIC = {
  cyan: "#43ECFF",
  magenta: "#FF6FB0",
  violet: "#AD90FF",
  solar: "#FFD066",
  ok: "#3AE6A0",
  warn: "#FFC93C",
  crit: "#FF6B7A",
  dim: "#7C7498",
} as const;

// Section bands cycle the brand quartet in this order, matching the site's color-banded
// splash panels (cyan → magenta → violet → solar → repeat).
export const BAND_CYCLE = [COSMIC.cyan, COSMIC.magenta, COSMIC.violet, COSMIC.solar] as const;

// `#rrggbb` → an SGR truecolor foreground escape. No validation: the inputs are the frozen
// COSMIC constants, not user data. Returns the string unpainted when color is disabled, so
// NO_COLOR / a pipe get plain text exactly like paint().
export function paintHex(enabled: boolean, hex: string, s: string): string {
  if (!enabled) return s;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${s}${RESET}`;
}

export function colorEnabled(env: Record<string, string | undefined>): boolean {
  // Explicit env overrides win (and keep tests deterministic regardless of the test
  // runner's TTY): NO_COLOR forces off, FORCE_COLOR forces on. Absent both, defer to
  // Bun's own TTY/terminal-capability resolution.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return true;
  return Bun.enableANSIColors;
}
