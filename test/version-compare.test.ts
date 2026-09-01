// The one release-string comparator (`Bun.semver.order` behind a never-throw guard): the
// ordering cases `[boom] upgrade_on_sync` depends on, plus the two ways semver differs from a
// naive component-wise compare.
import { expect, test } from "bun:test";
import { compareVersions } from "../src/lib/version.ts";

test("compareVersions orders release strings", () => {
  expect(compareVersions("0.21.0", "0.20.0")).toBeGreaterThan(0);
  expect(compareVersions("0.12.0", "0.11.0")).toBeGreaterThan(0);
  expect(compareVersions("0.11.1", "0.11.0")).toBeGreaterThan(0);
  expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  expect(compareVersions("0.11.0", "0.11.0")).toBe(0);
  expect(compareVersions("0.10.0", "0.11.0")).toBeLessThan(0);
});

// `Bun.semver.order` throws `Invalid SemVer` on garbage. The input is reachable: the release
// check compares a GitHub `tag_name` against VERSION, and a malformed tag must not crash a sync.
// 0 keeps the sort stable and flags nothing.
test("an unparseable version compares as 0 rather than throwing", () => {
  expect(compareVersions("", "1.0.0")).toBe(0);
  expect(compareVersions("abc", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.0", "")).toBe(0);
  expect(() => ["1.0.0", "abc", "0.9.0"].sort(compareVersions)).not.toThrow();
});

// semver does not zero-pad, so a two-component version is *greater* than its three-component
// spelling. Nothing boom ships has a two-component version.
test("semver does not zero-pad a short version", () => {
  expect(compareVersions("0.20", "0.20.0")).toBe(1);
});
