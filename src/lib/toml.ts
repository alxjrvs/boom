// TOML parsing — `Bun.TOML.parse`, plus the one thing it does not give us back.
//
// Bun's parser is the runtime's own (no dependency, nothing to keep in lockstep, and it is
// already linked into the compiled binary). Its failures name the offending token well —
// "Expected a value but found '='", "Cannot redefine key 'k'" — but they carry NO position.
// The `line`/`column` properties on the thrown SyntaxError look promising and are not: they are
// the JS call-site of `Bun.TOML.parse`, identical for every input, so they must not be surfaced.
//
// A boomfile error the user cannot locate is a bad trade for a tool whose pitch is typed,
// validated config, so we recover the line ourselves. `locate` re-parses growing line-prefixes
// and returns the first one that fails WITH THE SAME MESSAGE as the whole document. Matching the
// message is what makes it trustworthy: a prefix that merely cuts a valid multi-line array in
// half fails with a different error ("Unterminated array") and is skipped, so a real error later
// in the file is still found. When the document genuinely has an unterminated array, the match
// lands on the line that OPENED it, which is the line worth pointing at anyway.
//
// Cost is O(lines) parses, on the error path only — a run that is already about to fail and
// print. Bounded by MAX_LOCATE_LINES so a pathological file cannot turn a syntax error into a
// hang; past that the message simply arrives without a line, exactly as Bun gives it.
const MAX_LOCATE_LINES = 2000;

function locate(text: string, message: string): number | undefined {
  const lines = text.split("\n");
  if (lines.length > MAX_LOCATE_LINES) return undefined;
  for (let i = 0; i < lines.length; i++) {
    try {
      Bun.TOML.parse(lines.slice(0, i + 1).join("\n"));
    } catch (e) {
      if ((e as Error).message === message) return i + 1;
    }
  }
  return undefined;
}

// Parse a TOML document, or throw an Error whose message names the failure and — whenever it can
// be pinned down — the line it is on. The thrown type is a plain Error: every caller already
// wraps this in its own domain error (BoomConfigError, a lock-read failure) and only reads
// `.message`.
export function parseToml(text: string): unknown {
  try {
    return Bun.TOML.parse(text);
  } catch (e) {
    const message = (e as Error).message;
    const line = locate(text, message);
    throw new Error(line === undefined ? message : `${message} (line ${line})`);
  }
}
