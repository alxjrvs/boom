// Version is the single source of truth from package.json, embedded at build
// time by `bun build --compile` (the JSON import is statically bundled).
import pkg from "../../package.json" with { type: "json" };

export const VERSION = pkg.version as string;

// The one release-string comparator: <0 / 0 / >0, sort-callback shaped. Bun ships the real
// thing, so there is no hand-rolled component-wise compare.
//
// Two behaviors worth knowing, both verified rather than assumed:
//   • `Bun.semver.order` THROWS `Invalid SemVer` on "" or "abc". The caller compares a GitHub
//     release `tag_name` against VERSION, so a malformed value is genuinely reachable — the
//     catch is what keeps a corrupt version string from crashing a sync. 0 ("no opinion") is the
//     right answer there: an unorderable version sorts stably and flags nothing.
//   • `order("0.20", "0.20.0")` is **1**, not 0 — semver does not zero-pad. Nothing ships a
//     two-component version, so this only shows up on hand-edited input, and semver's answer is
//     the defensible one.
export function compareVersions(a: string, b: string): number {
  try {
    return Bun.semver.order(a, b);
  } catch {
    return 0;
  }
}
