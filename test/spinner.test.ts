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
  const r = new Reporter(
    { out: s.stream, err: s.stream },
    { color: true, surface: "bands", interactive: true },
  );
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
  const r = new Reporter({ out: s.stream, err: s.stream }, { color: true, surface: "bands" });
  const value = await r.spin("brew bundle", async () => 7);
  expect(value).toBe(7);
  expect(s.read()).toBe(""); // nothing drawn — piped/CI runs stay clean
});

test("spin: still clears the spinner and rethrows if the work throws", async () => {
  const s = sink();
  const r = new Reporter(
    { out: s.stream, err: s.stream },
    { color: true, surface: "bands", interactive: true },
  );
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
  const r = new Reporter(
    { out: s.stream, err: s.stream },
    { color: true, verbose: true, surface: "bands", interactive: true },
  );
  const value = await r.spin("git fetch", async () => 1);
  expect(value).toBe(1);
  expect(s.read()).toContain("git fetch…"); // a persistent line, not an erased animation
  expect(s.read()).not.toContain("\x1b[K"); // no cursor rewind — verbose doesn't animate in place
});

// A step that can escalate must not be animated over: the frame is redrawn with `\r\x1b[K`
// 11×/second, and sudo writes its password prompt straight to /dev/tty — so the animation
// *erases* the prompt and an ordinary wait-for-password reads as a hang. Verified out of band:
// "Password:" reaches the terminal even with the child's stdout ignored and stderr piped, so the
// quiet stdio was never what hid it. These pin the fix in place.

test("spin: mayPrompt yields the terminal — a persistent line, no in-place animation to erase a prompt", async () => {
  const s = sink();
  const r = new Reporter(
    { out: s.stream, err: s.stream },
    { color: true, surface: "bands", interactive: true },
  );
  const value = await r.spin("brew bundle", async () => 5, { mayPrompt: true });
  expect(value).toBe(5);
  expect(s.read()).toContain("brew bundle…");
  // The whole point: no clear-to-EOL anywhere, so nothing the child prints can be wiped.
  expect(s.read()).not.toContain("\x1b[K");
  expect(s.read().endsWith("\n")).toBe(true); // the line is committed, not rewound
});

test("spin: mayPrompt says a password may be wanted (the tool's own context is silenced)", async () => {
  const s = sink();
  const r = new Reporter(
    { out: s.stream, err: s.stream },
    { color: true, surface: "bands", interactive: true },
  );
  await r.spin("brew bundle", async () => 0, { mayPrompt: true });
  expect(s.read()).toContain("may ask for your password");
});

test("spin: mayPrompt false keeps the animation (an askpass shim means nothing will prompt)", async () => {
  const s = sink();
  const r = new Reporter(
    { out: s.stream, err: s.stream },
    { color: true, surface: "bands", interactive: true },
  );
  await r.spin("brew bundle", async () => 0, { mayPrompt: false });
  expect(s.read()).toContain("\x1b[K"); // animated in place, as before
  expect(s.read()).not.toContain("may ask for your password");
});

test("spin: mayPrompt stays a silent pass-through when non-interactive (no tty to prompt on)", async () => {
  const s = sink();
  const r = new Reporter({ out: s.stream, err: s.stream }, { color: true, surface: "bands" });
  expect(await r.spin("apt install", async () => 3, { mayPrompt: true })).toBe(3);
  expect(s.read()).toBe("");
});
