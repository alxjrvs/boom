// The active-work spinner (Reporter.spin): animates an in-place krackle line while an awaited
// operation runs on an interactive TTY, and is a transparent pass-through everywhere else (JSON,
// --verbose, or a non-TTY stream) so it never pollutes captured output. Constructor arg order:
// (out, err, color, json, verbose, bands, interactive, categoryMode).
import { expect, test } from "bun:test";
import { Reporter } from "../src/lib/reporter.ts";

function sink() {
  const buf = { out: "" };
  const stream = {
    write(s: string) {
      buf.out += s;
    },
  };
  return { stream, read: () => buf.out };
}

test("spin: draws a labelled line and returns the work's value on an interactive TTY", async () => {
  const s = sink();
  const r = new Reporter(s.stream, s.stream, true, false, false, true, true, false);
  const value = await r.spin("brew bundle", async () => {
    await Promise.resolve();
    return 42;
  });
  expect(value).toBe(42);
  expect(s.read()).toContain("brew bundle"); // the active-work label was drawn
  expect(s.read()).toContain("\x1b[K"); // clear-to-EOL used (draw in place + erase on finish)
  expect(s.read().endsWith("\r\x1b[K")).toBe(true); // the spinner line is erased last — nothing persists
});

test("spin: is a pure pass-through on a non-interactive stream (no animation in captured output)", async () => {
  const s = sink();
  const r = new Reporter(s.stream, s.stream, true, false, false, true, false, false);
  const value = await r.spin("brew bundle", async () => 7);
  expect(value).toBe(7);
  expect(s.read()).toBe(""); // nothing drawn — piped/CI runs stay clean
});

test("spin: still clears the spinner and rethrows if the work throws", async () => {
  const s = sink();
  const r = new Reporter(s.stream, s.stream, true, false, false, true, true, false);
  let threw = false;
  try {
    await r.spin("mise install", async () => {
      throw new Error("boom");
    });
  } catch (e) {
    threw = (e as Error).message === "boom";
  }
  expect(threw).toBe(true); // the work's error propagates
  expect(s.read().endsWith("\r\x1b[K")).toBe(true); // erased even on failure
});

test("spin: prints a persistent label line under --verbose (streaming commands' in-flight signal)", async () => {
  const s = sink();
  const r = new Reporter(s.stream, s.stream, true, false, true, true, true, false);
  const value = await r.spin("git fetch", async () => 1);
  expect(value).toBe(1);
  expect(s.read()).toContain("git fetch…"); // a persistent line, not an erased animation
  expect(s.read()).not.toContain("\x1b[K"); // no cursor rewind — verbose doesn't animate in place
});
