// Color detection follows the NO_COLOR / FORCE_COLOR conventions, and NO_COLOR wins.
import { expect, test } from "bun:test";
import { colorEnabled } from "../src/lib/color.ts";

test("colorEnabled: NO_COLOR forces off, FORCE_COLOR forces on", () => {
  expect(colorEnabled({ NO_COLOR: "1" })).toBe(false);
  expect(colorEnabled({ FORCE_COLOR: "1" })).toBe(true);
  // NO_COLOR wins over FORCE_COLOR (spec: any NO_COLOR value disables).
  expect(colorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
});
