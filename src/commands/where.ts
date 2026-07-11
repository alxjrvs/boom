// `boom where <config|code|engine>` — single source of truth for resolving boom's
// paths, so commands never re-derive breadcrumb logic. config resolves now (M1);
// code lands in M5; engine reports the running binary's directory.

import { dirname } from "node:path";
import { buildCommand } from "@stricli/core";
import { resolveConfigDir } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import { resolveCodeDir } from "../engine/code.ts";

export const whereCommand = buildCommand<Record<never, never>, [string], BoomContext>({
  docs: { brief: "Print a resolved boom path: config | code | engine" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ parse: (s: string) => s, placeholder: "target", brief: "config | code | engine" }],
    },
  },
  async func(_flags, target) {
    switch (target) {
      case "config": {
        const dir = await resolveConfigDir(this.env, this.cwd);
        if (!dir) return new Error("no dotfiles repo found — run `boom source set <owner/repo>`");
        this.process.stdout.write(`${dir}\n`);
        return;
      }
      case "engine":
        this.process.stdout.write(`${dirname(process.execPath)}\n`);
        return;
      case "code": {
        const dir = await resolveCodeDir(this.env);
        if (!dir) return new Error("no code dir — run `boom code init`");
        this.process.stdout.write(`${dir}\n`);
        return;
      }
      default:
        return new Error(`unknown target: ${target} (expected config | code | engine)`);
    }
  },
});
