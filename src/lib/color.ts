// The terminal palette, gated by a color flag (NO_COLOR / non-TTY → plain text).
//
// The enable decision defers to Bun.enableANSIColors, the runtime's own resolution
// of the whole matrix a well-behaved CLI must honor — stdout is-a-TTY, NO_COLOR,
// FORCE_COLOR, and TERM=dumb — so piping (`boom verify > run.log` / `| grep`) no
// longer leaks escape codes, which the old NO_COLOR-only check silently did.
//
// There used to be a second, named-ANSI palette here (bold/dim/red/green/yellow/cyan) with a
// `paint()` beside this one. It existed only for the reporter's `classic` surface; both went
// when that surface did. Everything boom prints now tints from a COSMIC hex.
const RESET = "\x1b[0m";

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

// `#rrggbb` → an SGR truecolor foreground escape, via the runtime's own converter rather than
// three hand-rolled parseInt slices. Returns the string unpainted when color is disabled, so
// NO_COLOR / a pipe get plain text.
//
// "ansi-16m", not "ansi", and the distinction is deliberate rather than observed: both emit the
// same truecolor escape on a capable terminal (they agree under `bun test`), but "ansi" is
// documented to downgrade to the detected color depth, which would make boom's output depend on
// the environment's capability probe. Whether to color at all is already decided once, by
// colorEnabled/Bun.enableANSIColors; the escape itself should not be re-negotiated per call.
// "ansi-16m" is byte-identical to the parseInt version this replaced, for every COSMIC color.
//
// Bun.color returns null on unparseable input, which a template literal would render as the text
// "null" rather than throwing. Safe here because the inputs are the frozen COSMIC constants, not
// user data — the same assumption the parseInt version made when it would have produced NaN.
export function paintHex(enabled: boolean, hex: string, s: string): string {
  if (!enabled) return s;
  return `${Bun.color(hex, "ansi-16m")}${s}${RESET}`;
}

export function colorEnabled(env: Record<string, string | undefined>): boolean {
  // Explicit env overrides win (and keep tests deterministic regardless of the test
  // runner's TTY): NO_COLOR forces off, FORCE_COLOR forces on. Absent both, defer to
  // Bun's own TTY/terminal-capability resolution.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return true;
  return Bun.enableANSIColors;
}
