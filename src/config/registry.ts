// The module registry: a curated index of vetted module packs, so `boom module search`/`add`
// can discover shared config instead of hand-copying a `use = [...]` ref. This is a *baked-in*
// index — no network, no fetch — the honest MVP of a registry: the packs ship in the binary and
// the whole surface is offline-deterministic. A remote/fetched index (a published JSON the CLI
// pulls and caches) is the follow-up; when it lands, this static array becomes the fallback.
//
// Each entry's `ref` is exactly what would go in `use = [...]` — a `github:owner/repo` ref the
// existing module resolver (config/modules.ts) already understands.

export interface RegistryPack {
  readonly name: string;
  readonly ref: string;
  readonly description: string;
  readonly tags?: readonly string[];
}

// The curated packs. Kept small and legible on purpose — each earns its place, and the refs
// are plausible `github:alxjrvs/boom-mod-<name>` addresses the resolver clones on `boom source`.
export const REGISTRY: readonly RegistryPack[] = [
  {
    name: "node-dev",
    ref: "github:alxjrvs/boom-mod-node-dev",
    description: "Node.js toolchain: mise-managed node, pnpm/bun, and a sane npm config",
    tags: ["node", "javascript", "typescript", "web"],
  },
  {
    name: "rust",
    ref: "github:alxjrvs/boom-mod-rust",
    description: "Rust toolchain via rustup, cargo essentials, and a tuned cargo config",
    tags: ["rust", "cargo", "systems"],
  },
  {
    name: "python-dev",
    ref: "github:alxjrvs/boom-mod-python-dev",
    description: "Python toolchain: mise-managed python, uv, ruff, and a starter virtualenv layout",
    tags: ["python", "uv", "ruff"],
  },
  {
    name: "sane-macos-defaults",
    ref: "github:alxjrvs/boom-mod-sane-macos-defaults",
    description: "Opinionated macOS system defaults: faster key repeat, Finder sanity, no press-and-hold",
    tags: ["macos", "osx", "defaults", "desktop"],
  },
  {
    name: "cli-essentials",
    ref: "github:alxjrvs/boom-mod-cli-essentials",
    description: "Everyday CLI kit: ripgrep, fd, fzf, bat, eza, jq, and their dotfiles",
    tags: ["cli", "shell", "terminal", "tools"],
  },
];

// Case-insensitive substring match over name, description, and tags. An empty term matches
// everything (a bare `boom module search` lists the whole registry).
export function searchRegistry(term: string): RegistryPack[] {
  const q = term.trim().toLowerCase();
  if (!q) return [...REGISTRY];
  return REGISTRY.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      (p.tags ?? []).some((t) => t.toLowerCase().includes(q)),
  );
}

// Exact (case-insensitive) name lookup — what `boom module add <name>` resolves against.
export function findPack(name: string): RegistryPack | undefined {
  const q = name.trim().toLowerCase();
  return REGISTRY.find((p) => p.name.toLowerCase() === q);
}

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
