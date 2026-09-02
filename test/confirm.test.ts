// The confirm() contract: --yes always proceeds without asking; an interactive terminal is asked
// and only y/yes proceeds; a non-TTY (which is what `bun test` runs under) REFUSES without --yes,
// so a piped/CI/cron invocation can't silently run an irreversible teardown.
import { expect, test } from "bun:test";
import { confirm, type Terminal } from "../src/lib/confirm.ts";

// A terminal whose user types `answer` (null: stdin closed), recording what it was asked.
function typing(answer: string | null, isTTY = true): Terminal & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    isTTY,
    asked,
    ask(question) {
      asked.push(question);
      return answer;
    },
  };
}

test("--yes proceeds without asking, even on a terminal whose user would say no", () => {
  const term = typing("n");
  expect(confirm("really?", { yes: true }, term)).toBe(true);
  expect(term.asked).toEqual([]);
});

test("a non-TTY refuses without asking — a pipe, CI or cron has no one to answer", () => {
  const term = typing("y", false);
  expect(confirm("really?", {}, term)).toBe(false);
  expect(term.asked).toEqual([]);
  // The default terminal is the real stdin, and bun test has no TTY there.
  expect(process.stdin.isTTY).toBeFalsy();
  expect(confirm("really?")).toBe(false);
});

test("an interactive terminal is asked once, and only y/yes proceeds", () => {
  for (const yes of ["y", "Y", "yes", "  YES \n"]) expect(confirm("really?", {}, typing(yes))).toBe(true);
  for (const no of ["n", "", "yep", "no", null]) expect(confirm("really?", {}, typing(no))).toBe(false);
  const term = typing("y");
  confirm("Delete it all?", {}, term);
  expect(term.asked).toEqual(["Delete it all? [y/N]"]);
});
