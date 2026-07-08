// confirmOverwrite mirrors the legacy bash `[[ -t 0 ]] && read -rp ... || choice="s"`:
// bun test's stdin is never a real TTY, so this only exercises the non-interactive path.
import { expect, test } from "bun:test";
import { confirmOverwrite } from "../src/lib/prompt.ts";

test("confirmOverwrite defaults to false (skip) off a non-tty stdin", async () => {
  expect(process.stdin.isTTY).toBeFalsy();
  expect(await confirmOverwrite("overwrite? [o/s]: ")).toBe(false);
});
