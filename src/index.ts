#!/usr/bin/env bun
// botu entrypoint. Compiled to a standalone binary via `bun build --compile`.
import { run } from "@stricli/core";
import { app } from "./cli.ts";
import { buildContext } from "./context.ts";

await run(app, process.argv.slice(2), buildContext(process));
