// The confirm() contract: --yes always proceeds; an interactive terminal is prompted; a
// non-TTY (which is what `bun test` runs under) REFUSES without --yes, so a piped/CI/cron
// invocation can't silently run an irreversible teardown.
import { expect, test } from "bun:test";
import { confirm } from "../src/lib/confirm.ts";

test("confirm proceeds with --yes but refuses a non-TTY without it", () => {
  expect(confirm("really?", { yes: true })).toBe(true);
  // bun test has no TTY on stdin, so without --yes this refuses rather than prompting.
  expect(process.stdin.isTTY).toBeFalsy();
  expect(confirm("really?")).toBe(false);
});
