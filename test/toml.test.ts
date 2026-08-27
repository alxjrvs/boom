// lib/toml.ts — Bun's TOML parser plus the line number it does not report.
//
// Worth stating why this file exists at all: `Bun.TOML.parse`'s thrown SyntaxError DOES carry
// `.line`/`.column`, and they are a trap. They describe the JS call-site of `Bun.TOML.parse`,
// not the TOML, so they are identical for every input — surfacing them would print a confident,
// constant, wrong line number. The locator re-derives the real one instead.
import { expect, test } from "bun:test";
import { parseToml } from "../src/lib/toml.ts";

test("parses what the boomfile schema actually uses", () => {
  const parsed = parseToml(
    `name = "boom"
count = 3
on = true

[pins]
foo = "1.2.3"

[[section]]
name = "s"
link = [{ src = "a", dst = "~/a" }]
`,
  ) as Record<string, unknown>;
  expect(parsed).toEqual({
    name: "boom",
    count: 3,
    on: true,
    pins: { foo: "1.2.3" },
    section: [{ name: "s", link: [{ src: "a", dst: "~/a" }] }],
  });
});

test("a syntax error names the line it is on", () => {
  const src = `x = 1
y = 2
z = =
w = 4
`;
  const err = (() => {
    try {
      parseToml(src);
      return undefined;
    } catch (e) {
      return e as Error;
    }
  })();
  expect(err).toBeDefined();
  // Bun's own wording is kept — it names the offending token, which is the useful half.
  expect(err?.message).toContain("Expected a value");
  expect(err?.message).toContain("(line 3)");
});

test("a duplicate key is located at the redefinition, not the first definition", () => {
  const src = `[t]
k = 1

k = 2
`;
  expect(() => parseToml(src)).toThrow(/Cannot redefine key 'k'.*\(line 4\)/);
});

// The case that makes prefix-scanning trustworthy rather than plausible. Every prefix that cuts
// this file inside the multi-line array fails with "Unterminated array" — a DIFFERENT message
// from the document's real failure — so a naive "first prefix that throws" would report line 1.
// Matching the message skips those and finds the actual error further down.
test("a valid multi-line array does not swallow a later error", () => {
  const src = `items = [
  1,
  2,
  3,
]
bad = =
`;
  expect(() => parseToml(src)).toThrow(/Expected a value.*\(line 6\)/);
});

// When the document's failure IS an unterminated array, the match lands on the line that opened
// it — the line worth pointing at, since that is where the missing `]` belongs.
test("an unterminated array is located at the line that opened it", () => {
  const src = `x = 1
y = 2
items = [
  1,
  2,
`;
  expect(() => parseToml(src)).toThrow(/Unterminated array.*\(line 3\)/);
});

// A parse failure must always be reportable, even when the line cannot be pinned down — the
// message is the contract, the line is an enhancement.
test("an unlocatable failure still throws Bun's message", () => {
  // A lone `]` fails on the first line, so there is nothing subtle to locate.
  expect(() => parseToml("]\n")).toThrow();
});
