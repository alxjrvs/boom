// Version is the single source of truth from package.json, embedded at build
// time by `bun build --compile` (the JSON import is statically bundled).
import pkg from "../../package.json" with { type: "json" };

export const VERSION = pkg.version as string;

// The one release-string comparator: <0 / 0 / >0, sort-callback shaped. `engine/settings.ts` and
// `engine/fleet.ts` each carried their own hand-rolled component-wise version — the second one's
// comment openly admitting the duplication. Bun ships the real thing.
//
// Two behaviors worth knowing, both verified rather than assumed:
//   • `Bun.semver.order` THROWS `Invalid SemVer` on "" or "abc", where a component-wise compare
//     quietly produced NaN (and every comparison false). `engine/fleet.ts` reads `m.boom` out of
//     *another machine's* JSON summary, so a malformed value is genuinely reachable — the catch
//     is what keeps a corrupt fleet file from crashing `boom fleet`. 0 ("no opinion") is the
//     right answer there: an unorderable version sorts stably and flags nothing.
//   • `order("0.20", "0.20.0")` is **1**, not 0 — semver does not zero-pad. The component-wise
//     compare called those equal. Nothing ships a two-component version, so this only shows up
//     on hand-edited input, and semver's answer is the defensible one.
export function compareVersions(a: string, b: string): number {
  try {
    return Bun.semver.order(a, b);
  } catch {
    return 0;
  }
}
