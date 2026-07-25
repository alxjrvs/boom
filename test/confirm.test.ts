// The confirm() contract: --yes always proceeds; an interactive terminal is prompted; a
// non-TTY (which is what `bun test` runs under) REFUSES without --yes, so a piped/CI/cron
// invocation can't silently run an irreversible teardown.
import { expect, test } from "bun:test";
import { type Choice, choose, confirm } from "../src/lib/confirm.ts";

test("confirm proceeds with --yes but refuses a non-TTY without it", () => {
  expect(confirm("really?", { yes: true })).toBe(true);
  // bun test has no TTY on stdin, so without --yes this refuses rather than prompting.
  expect(process.stdin.isTTY).toBeFalsy();
  expect(confirm("really?")).toBe(false);
});

// choose() carries confirm()'s doctrine into a multi-way question: a non-TTY is never
// asked. That is what keeps `code reap --interactive` safe to reach from a launchd timer —
// it takes the do-nothing answer instead of blocking forever on a prompt nobody can see.
const CHOICES: Choice<"push" | "delete" | "skip">[] = [
  { key: "p", label: "push & remove", value: "push" },
  { key: "d", label: "DELETE", value: "delete" },
  { key: "s", label: "skip", value: "skip" },
];

test("choose returns the fallback on a non-TTY rather than prompting", () => {
  expect(process.stdin.isTTY).toBeFalsy();
  expect(choose("what now?", CHOICES, "skip")).toBe("skip");
});

test("choose returns the fallback when there is nothing to choose between", () => {
  expect(choose("what now?", [], "skip")).toBe("skip");
});
