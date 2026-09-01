// M0 CLI wiring: drive the app with a fake context that captures output, so we
// assert on version/help/dispatch without spawning a subprocess. (Integration
// tests that spawn the compiled binary land in M2 and MUST use Bun.spawnSync —
// bun test has a piped-stdout bug, oven-sh/bun#24690.)
import { expect, test } from "bun:test";
import { run } from "@stricli/core";
import pkg from "../package.json" with { type: "json" };
import { app } from "../src/cli.ts";

function fakeContext() {
  const buf = { out: "", err: "" };
  const proc = {
    stdout: {
      write: (s: string) => {
        buf.out += s;
      },
    },
    stderr: {
      write: (s: string) => {
        buf.err += s;
      },
    },
    env: {} as Record<string, string>,
    exitCode: 0 as number,
  };
  // The fake satisfies BoomContext (process/env/cwd); cwd points nowhere so the
  // reconcile verbs resolve no config and report the expected error.
  return { buf, proc, ctx: { process: proc, env: proc.env, cwd: "/nonexistent-boom" } as never };
}

test("--version prints the package version", async () => {
  const { buf, ctx } = fakeContext();
  await run(app, ["--version"], ctx);
  expect(buf.out.trim()).toBe(pkg.version);
});

test("--help lists the core verbs", async () => {
  const { buf, ctx } = fakeContext();
  await run(app, ["--help"], ctx);
  const text = buf.out + buf.err;
  expect(text).toContain("source");
  expect(text).toContain("verify");
});

test("a known verb routes to the engine", async () => {
  const { buf, ctx } = fakeContext();
  await run(app, ["source"], ctx);
  expect(buf.err).toContain("no config repo linked");
});

test("an unknown command reports an error naming it", async () => {
  const { buf, ctx } = fakeContext();
  await run(app, ["definitely-not-a-command"], ctx);
  expect(buf.err).toContain("definitely-not-a-command");
});

test("source accepts --commit/-m", async () => {
  const { buf, ctx } = fakeContext();
  await run(app, ["source", "--commit", "-m", "wip"], ctx);
  // cwd resolves no config — proves the flags parsed, not that a git sync ran.
  expect(buf.err).toContain("no config repo linked");
});
