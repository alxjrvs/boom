#!/usr/bin/env bun
// botu entrypoint. Compiled to a standalone binary via `bun build --compile`.
// Dispatch: `mcp` (raw passthrough) and discovered user commands are handled before
// Stricli; everything else is a built-in route.
import { run } from "@stricli/core";
import { app } from "./cli.ts";
import { runMcp } from "./commands/mcp.ts";
import { buildContext } from "./context.ts";
import { runUserCommand } from "./engine/discovery.ts";

const BUILTINS = new Set([
  "apply",
  "verify",
  "fix",
  "update",
  "uninstall",
  "where",
  "migrate",
  "rollback",
  "code",
  "watchtower",
  "sync",
  "doctor",
]);

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
