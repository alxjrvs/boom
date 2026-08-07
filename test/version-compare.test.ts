// The one release-string comparator, which replaced the hand-rolled component-wise ones in
// engine/settings.ts and engine/fleet.ts. The five cases the deleted settings.ts test asserted
// are restated here against `compareVersions`, so the coverage moved rather than evaporating —
// plus the two ways `Bun.semver.order` differs from what it replaced.
import { expect, test } from "bun:test";
import { compareVersions } from "../src/lib/version.ts";

test("compareVersions orders release strings", () => {
  expect(compareVersions("0.21.0", "0.20.0")).toBeGreaterThan(0);
  // Inherited from the deleted settings.ts test, whose predicate was `compareVersions(a, b) > 0`.
  expect(compareVersions("0.12.0", "0.11.0")).toBeGreaterThan(0);
  expect(compareVersions("0.11.1", "0.11.0")).toBeGreaterThan(0);
  expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  // …and the two cases that predicate answered `false`: equal, and strictly older.
  expect(compareVersions("0.11.0", "0.11.0")).toBe(0);
  expect(compareVersions("0.10.0", "0.11.0")).toBeLessThan(0);
});

// `Bun.semver.order` throws `Invalid SemVer` where the component-wise compare produced NaN. The
// input is reachable: `boom fleet` reads `m.boom` out of another machine's JSON summary, so a
// truncated or hand-edited file lands here. 0 keeps the sort stable and flags nothing.
test("an unparseable version compares as 0 rather than throwing", () => {
  expect(compareVersions("", "1.0.0")).toBe(0);
  expect(compareVersions("abc", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.0", "")).toBe(0);
  expect(() => ["1.0.0", "abc", "0.9.0"].sort(compareVersions)).not.toThrow();
});

// Intentional divergence from the comparator this replaced: semver does not zero-pad, so a
// two-component version is *greater* than its three-component spelling, where the component-wise
// compare called them equal. Nothing boom ships has a two-component version.
test("semver does not zero-pad a short version", () => {
  expect(compareVersions("0.20", "0.20.0")).toBe(1);
});
