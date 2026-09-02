// How a failing child's output reaches the report. Two shapes, deliberately different:
// `lastLine` for package managers (long, templated, worst-line-last) and `failureDetail` for a
// `run` step (somebody's own command, most specific complaint FIRST).
import { expect, test } from "bun:test";
import { failureDetail, lastLine, runShellAsync } from "../src/lib/proc.ts";

// The regression this file exists for. A nine-line vault-audit failure was rendered as its LAST
// line — an item that was present and correctly declared — while the actual finding sat in the
// eight dropped lines. Every line has to survive.
test("failureDetail keeps every line, not just the last", () => {
  const stderr = [
    "op-agent: vault has non-kebab-case titles:",
    "  Name",
    "op-agent: vault holds items not declared in agent-vault.txt:",
    "  + Name",
  ].join("\n");
  const out = failureDetail(stderr);
  for (const line of stderr.split("\n")) expect(out).toContain(line.trim());
  // and it is indented under the fail message rather than run together with it
  expect(out.startsWith("\n")).toBe(true);
  expect(out).toContain("    op-agent: vault has non-kebab-case titles:");
});

test("failureDetail includes stdout, because a script may explain itself there", () => {
  expect(failureDetail("", "printed on stdout")).toContain("printed on stdout");
  expect(failureDetail("on stderr", "on stdout")).toContain("on stderr");
  expect(failureDetail("on stderr", "on stdout")).toContain("on stdout");
});

test("failureDetail is empty when the child said nothing", () => {
  expect(failureDetail(undefined, undefined)).toBe("");
  expect(failureDetail("", "")).toBe("");
  expect(failureDetail("   \n  \n")).toBe("");
});

// lastLine is unchanged and still right for its callers — asserted so a future tidy-up doesn't
// "unify" the two and quietly re-truncate brew's output, or re-truncate a run step's.
test("lastLine still returns only the last non-blank line", () => {
  expect(lastLine("first\nsecond\nthird\n\n")).toBe("third");
  expect(lastLine("")).toBe("");
  expect(lastLine(undefined)).toBe("");
});

test("runShellAsync captures stdout only when asked", async () => {
  const cmd = "echo to-stdout; echo to-stderr 1>&2; exit 3";

  const captured = await runShellAsync(cmd, {}, { silent: true, captureStdout: true });
  expect(captured.code).toBe(3);
  expect(captured.stderr).toBe("to-stderr");
  expect(captured.stdout).toBe("to-stdout");

  // Without the opt-in, stdout is discarded — the behavior every package-manager caller relies
  // on, and the reason captureStdout is opt-in rather than the default for `silent`.
  const plain = await runShellAsync(cmd, {}, { silent: true });
  expect(plain.code).toBe(3);
  expect(plain.stderr).toBe("to-stderr");
  expect(plain.stdout).toBeUndefined();
});

// A command chatty on BOTH channels must not deadlock. Draining one stream to completion before
// starting the other blocks forever once the unread pipe fills and the child blocks on write.
//
// The payload is sized to make that real rather than decorative: a pipe buffer is 64 KB on macOS
// and Linux, so each channel writes comfortably past it. At a few thousand short lines this test
// passes either way and proves nothing.
test("runShellAsync drains both pipes without deadlocking on a chatty child", async () => {
  const line = "x".repeat(120);
  const n = 1500; // ~180 KB per channel, ~3x the 64 KB buffer
  const cmd = `for i in $(seq 1 ${n}); do echo "${line}"; echo "${line}" 1>&2; done; exit 1`;
  const r = await runShellAsync(cmd, {}, { silent: true, captureStdout: true });
  expect(r.code).toBe(1);
  expect(r.stdout?.split("\n").length).toBe(n);
  expect(r.stderr?.split("\n").length).toBe(n);
  expect((r.stdout?.length ?? 0) > 64 * 1024).toBe(true);
  expect((r.stderr?.length ?? 0) > 64 * 1024).toBe(true);
});

// The deadline is Bun.spawn's own `timeout`; a child it kills reports `timedOut` and never a
// zero code, and the caller is back well before the child would have finished on its own.
// `exec`, so the sleeper IS the child sh: the deadline kills the process boom spawned, and a
// grandchild that inherited the stderr pipe would keep the drain open until it exited on its own.
test("runShellAsync reports a child killed by the deadline as timedOut", async () => {
  const t0 = performance.now();
  const r = await runShellAsync("exec sleep 5", { PATH: process.env.PATH }, { silent: true, timeoutMs: 150 });
  expect(r.timedOut).toBe(true);
  expect(r.code).not.toBe(0);
  expect(performance.now() - t0).toBeLessThan(4000);
});
