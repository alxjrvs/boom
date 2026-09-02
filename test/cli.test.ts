// CLI wiring: drive the app with a fake context that captures output, so we assert on
// version/help/dispatch without spawning a subprocess. (Tests that spawn the compiled binary
// MUST use Bun.spawnSync — bun test has a piped-stdout bug, oven-sh/bun#24690.) Plus the command
// catalog, which DERIVES from the route map and is what every generated surface reads.
import { expect, test } from "bun:test";
import { run } from "@stricli/core";
import pkg from "../package.json" with { type: "json" };
import { app, routes } from "../src/cli.ts";
import { commandNames } from "../src/commands/catalog.ts";
import { type FakeCtx, fakeCtx } from "./support/ctx.ts";

// cwd points nowhere so the reconcile verbs resolve no config and report the expected error.
const fakeContext = (): FakeCtx => fakeCtx({}, "/nonexistent-boom");

test("--version prints the package version", async () => {
  const { ctx, out } = fakeContext();
  await run(app, ["--version"], ctx);
  expect(out().trim()).toBe(pkg.version);
});

test("--help lists the core verbs", async () => {
  const { ctx, out } = fakeContext();
  await run(app, ["--help"], ctx);
  expect(out()).toContain("source");
  expect(out()).toContain("verify");
});

test("a known verb routes to the engine", async () => {
  const { ctx, out } = fakeContext();
  await run(app, ["source"], ctx);
  expect(out()).toContain("no config repo linked");
});

test("an unknown command reports an error naming it", async () => {
  const { ctx, out } = fakeContext();
  await run(app, ["definitely-not-a-command"], ctx);
  expect(out()).toContain("definitely-not-a-command");
});

// Through the parser, not the catalog: the catalog filters hidden routes, so a hidden `sync`
// alias would pass the exact-set test while `boom sync` quietly worked again. `boom source`
// is the one spelling.
test("`sync` is not a top-level command", async () => {
  const { ctx, out } = fakeContext();
  await run(app, ["sync"], ctx);
  expect(out()).toContain("sync");
  expect(out()).not.toContain("no config repo linked");
});

test("source accepts --commit/-m", async () => {
  const { ctx, out } = fakeContext();
  await run(app, ["source", "--commit", "-m", "wip"], ctx);
  // cwd resolves no config — proves the flags parsed, not that a git sync ran.
  expect(out()).toContain("no config repo linked");
});

// ---- catalog ----------------------------------------------------------------

// The exact set, not a contains-list: a route added or re-added by accident would otherwise
// reappear in every derived surface (the skill most of all) with nothing to catch it.
test("command list (derived from the route map) is exactly the five built-ins", () => {
  expect([...commandNames()].sort()).toEqual(["doctor", "skill", "source", "uninstall", "verify"]);
});

test("`source` is the one nested route map, and it routes exactly sync + set", () => {
  const nested = routes
    .getAllEntries()
    .filter((e) => !e.hidden && "getAllEntries" in e.target)
    .map((e) => ({
      parent: e.name.original,
      children: (e.target as typeof routes)
        .getAllEntries()
        .map((c) => c.name.original)
        .sort(),
    }));
  expect(nested).toEqual([{ parent: "source", children: ["set", "sync"] }]);
});
