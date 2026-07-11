#!/usr/bin/env bun
// boom entrypoint. Compiled to a standalone binary via `bun build --compile`.
// Dispatch has exactly one branch, and no hardcoded command names: a first arg that is
// neither a flag nor a known route is tried as a discovered user command
// (<config>/commands/<name>.ts); everything else — including unknown input — goes to
// Stricli, which routes it or reports it. `getRoutingTargetForInput` is the route map's
// own membership test, so this can never drift from the registry.
import { run } from "@stricli/core";
import { app, routes } from "./cli.ts";
import { buildContext } from "./context.ts";
import { runUserCommand } from "./engine/discovery.ts";

const ctx = buildContext(process);
const argv = process.argv.slice(2);
const first = argv[0];

if (first && !first.startsWith("-") && routes.getRoutingTargetForInput(first) === undefined) {
  const rc = await runUserCommand(first, argv.slice(1), ctx);
  if (rc === undefined)
    await run(app, argv, ctx); // not a user command → let Stricli report
  else process.exitCode = rc;
} else {
  await run(app, argv, ctx);
}
