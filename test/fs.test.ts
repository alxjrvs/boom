// expandHome resolves ~ and $HOME in osx_default string values, which `defaults
// write` would otherwise store verbatim (e.g. `screencapture location`).
import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandHome, expandTilde, restoreFrom } from "../src/lib/fs.ts";

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

test("restoreFrom replaces the current file with the backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boom-fs-"));
  const dst = join(dir, "dst");
  const from = join(dir, "backup");
  await writeFile(dst, "CURRENT");
  await writeFile(from, "BACKUP");
  await restoreFrom(from, dst);
  expect(await readFile(dst, "utf8")).toBe("BACKUP");
});

test("restoreFrom leaves the current file intact when the backup is missing (non-destructive)", async () => {
  // The old order rm'd dst before moving the backup in, so a failed move lost the current
  // file outright. A missing backup must instead leave dst exactly as it was.
  const dir = await mkdtemp(join(tmpdir(), "boom-fs-"));
  const dst = join(dir, "dst");
  await writeFile(dst, "CURRENT");
  let threw = false;
  try {
    await restoreFrom(join(dir, "does-not-exist"), dst);
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(await readFile(dst, "utf8")).toBe("CURRENT"); // NOT lost
});
