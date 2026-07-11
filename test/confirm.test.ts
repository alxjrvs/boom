// The confirm() contract is scriptable-first: --yes proceeds, and a non-TTY (which is what
// `bun test` runs under) proceeds silently — only an interactive terminal is ever prompted.
import { expect, test } from "bun:test";
import { confirm } from "../src/lib/confirm.ts";

test("confirm proceeds without prompting when --yes or non-interactive", () => {
  expect(confirm("really?", { yes: true })).toBe(true);
  // bun test has no TTY on stdin, so this takes the silent-proceed path (never prompts).
  expect(process.stdin.isTTY).toBeFalsy();
  expect(confirm("really?")).toBe(true);
});
