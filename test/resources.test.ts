// osx_default value normalization: the `defaults read` output space the verify path
// compares against. The win over the old bool-only coercion is numeric int/float
// matching (so a stored `0.50000` matches a declared `0.5`) and not warning spuriously.
import { expect, test } from "bun:test";
import { osxMatches, osxWanted } from "../src/engine/resources/osx.ts";

test("osxWanted normalizes booleans to 1/0", () => {
  expect(osxWanted("bool", true)).toBe("1");
  expect(osxWanted("bool", false)).toBe("0");
  expect(osxWanted("bool", "true")).toBe("1");
  expect(osxWanted("bool", "YES")).toBe("1");
});

test("osxWanted truncates ints and stringifies floats/strings", () => {
  expect(osxWanted("int", 3)).toBe("3");
  expect(osxWanted("float", 0.5)).toBe("0.5");
  expect(osxWanted("string", "hello")).toBe("hello");
});

test("osxMatches compares int/float numerically (tolerates defaults formatting)", () => {
  expect(osxMatches("float", "0.50000", 0.5)).toBe(true);
  expect(osxMatches("int", "2", 2)).toBe(true);
  expect(osxMatches("float", "0.5", 0.6)).toBe(false);
});

test("osxMatches compares bool/string as text", () => {
  expect(osxMatches("bool", "1", true)).toBe(true);
  expect(osxMatches("bool", "0", true)).toBe(false);
  expect(osxMatches("string", "  hi  ", "hi")).toBe(true);
});
