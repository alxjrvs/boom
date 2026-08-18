// The `use` splicer: add a module ref to a boomfile's top-level `use` array with a textual
// edit, so comments and formatting survive.
//
// This file used to also carry a "curated registry" of five packs that `boom module search`
// listed and `boom module add <name>` resolved. Every one of their refs
// (`github:alxjrvs/boom-mod-*`) pointed at a repository that does not exist — the file's own
// comment called them "plausible" addresses — while README and SPEC called the list "curated"
// and "vetted". So the one discovery feature boom shipped resolved nothing, and `module add`
// spliced a permanently-dead ref into the user's boomfile, which they then committed and
// pushed to every machine they own. The registry is gone; `module add` now takes a real ref.

// Insert a `use` ref into raw boomfile text with the *least-destructive* textual edit, so
// comments and formatting survive (re-serializing the parsed TOML would drop both):
//   - ref already present anywhere in `use` → no change (idempotent), added = false.
//   - a `use = [...]` array exists → splice the quoted ref in before the closing `]`.
//   - no `use` array → prepend a fresh `use = ["<ref>"]` line at the top of the file.
// `parsed` is the already-parsed boomfile object, used only to decide present/append/create —
// the edit itself is textual. Returns the new text and whether anything changed.
export function insertUseRef(
  text: string,
  parsed: { use?: readonly string[] },
  ref: string,
): { text: string; added: boolean } {
  const existing = parsed.use ?? [];
  if (existing.includes(ref)) return { text, added: false };

  const quoted = JSON.stringify(ref); // a TOML basic string is JSON-string-compatible for our refs

  if (existing.length === 0 && !/^\s*use\s*=/m.test(text)) {
    // No `use` array at all — prepend one. Keep it at the very top so module composition reads
    // first, mirroring how modules compose before the repo's own sections.
    const prefix = `use = [${quoted}]\n`;
    return { text: prefix + text, added: true };
  }

  // A `use = [ ... ]` array exists (possibly multi-line). Splice the new ref in just before the
  // array's closing `]`, carrying the surrounding element's indentation so the file stays tidy.
  const open = text.indexOf("[", text.search(/\buse\s*=/));
  const close = text.indexOf("]", open);
  if (open === -1 || close === -1) {
    // Shouldn't happen for a well-formed array, but never corrupt the file — fall back to a
    // prepended line rather than a bad splice.
    return { text: `use = [${quoted}]\n${text}`, added: true };
  }
  const inner = text.slice(open + 1, close);
  const hasEntries = inner.trim().length > 0;
  const multiline = inner.includes("\n");
  if (multiline) {
    // Match the indentation of the last non-empty line inside the array, then splice the ref in
    // just before `]`, dropping any trailing whitespace the closing bracket sat on.
    const indentSource = [...inner.split("\n")].reverse().find((l) => l.trim().length > 0) ?? "";
    const indent = indentSource.match(/^\s*/)?.[0] ?? "  ";
    const before = text.slice(0, close).replace(/\s*$/, "");
    const sep = hasEntries ? `,\n${indent}` : `\n${indent}`;
    return { text: `${before}${sep}${quoted},\n${text.slice(close)}`, added: true };
  }
  const insertion = hasEntries ? `, ${quoted}` : quoted;
  return { text: `${text.slice(0, close)}${insertion}${text.slice(close)}`, added: true };
}
