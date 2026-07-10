#!/usr/bin/env bun
// botu entrypoint. Compiled to a standalone binary via `bun build --compile`.
// Dispatch: `mcp` (raw passthrough) and discovered user commands are handled before
// Stricli; everything else is a built-in route.
import { run } from "@stricli/core";
import { app } from "./cli.ts";
import { COMMAND_NAMES } from "./commands/catalog.ts";
import { runMcp } from "./commands/mcp.ts";
import { buildContext } from "./context.ts";
import { runUserCommand } from "./engine/discovery.ts";

// Names that route to a built-in. A first arg that is none of these and doesn't start
// with `-` is tried as a discovered user command first.
const BUILTINS = new Set(COMMAND_NAMES);

const ctx = buildContext(process);
const argv = process.argv.slice(2);
const first = argv[0];

if (first === "mcp") {
  process.exitCode = runMcp(argv.slice(1), ctx);
} else if (first && !first.startsWith("-") && !BUILTINS.has(first)) {
  const rc = await runUserCommand(first, argv.slice(1), ctx);
  if (rc === undefined)
    await run(app, argv, ctx); // not a user command → let Stricli report
  else process.exitCode = rc;
} else {
  await run(app, argv, ctx);
}
