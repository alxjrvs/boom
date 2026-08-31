// `boom where <config|engine>` — single source of truth for resolving boom's
// paths, so commands never re-derive breadcrumb logic. config resolves the managed
// config repo; engine reports the running binary's directory. A `code` target
// existed until the `code` verb was removed; it went with it.

import { dirname } from "node:path";
import { buildCommand } from "@stricli/core";
import { NO_CONFIG_REPO_MSG, resolveConfigDir } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import { str } from "./flags.ts";

export const whereCommand = buildCommand<Record<never, never>, [string], BoomContext>({
  docs: { brief: "Print a resolved boom path: config | engine" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ parse: str, placeholder: "target", brief: "config | engine" }],
    },
  },
  async func(_flags, target) {
    switch (target) {
      case "config": {
        const dir = await resolveConfigDir(this.env, this.cwd);
        if (!dir) return new Error(NO_CONFIG_REPO_MSG);
        this.process.stdout.write(`${dir}\n`);
        return;
      }
      case "engine":
        this.process.stdout.write(`${dirname(process.execPath)}\n`);
        return;
      default:
        return new Error(`unknown target: ${target} (expected config | engine)`);
    }
  },
});
