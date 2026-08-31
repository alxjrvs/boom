// expandHome resolves ~ and $HOME in osx_default string values, which `defaults
// write` would otherwise store verbatim (e.g. `screencapture location`).
import { expect, test } from "bun:test";
import { expandHome, expandTilde } from "../src/lib/fs.ts";

const env = { HOME: "/Users/alxjrvs" };

test("expandHome resolves a leading ~", () => {
  expect(expandHome("~", env)).toBe("/Users/alxjrvs");
  expect(expandHome("~/Screenshots", env)).toBe("/Users/alxjrvs/Screenshots");
});

test("expandHome resolves $HOME and curly-brace HOME anywhere", () => {
  expect(expandHome("$HOME/Screenshots", env)).toBe("/Users/alxjrvs/Screenshots");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${HOME} is the value under test
  expect(expandHome("${HOME}/Screenshots", env)).toBe("/Users/alxjrvs/Screenshots");
});

test("expandHome leaves non-home strings untouched", () => {
  expect(expandHome("/tmp/shots", env)).toBe("/tmp/shots");
  expect(expandHome("plain", env)).toBe("plain");
});

test("expandHome passes through unchanged when HOME is unset", () => {
  expect(expandHome("$HOME/x", {})).toBe("$HOME/x");
});

test("expandTilde still only handles ~, not $HOME (unchanged behavior)", () => {
  expect(expandTilde("$HOME/x", env)).toBe("$HOME/x");
});
