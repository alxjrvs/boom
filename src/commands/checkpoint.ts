// `boom checkpoint <name>` — label the most recent sync as a named, prune-exempt known-good
// state that `boom rollback --to <name>` returns to. Thin wrapper over engine/rollback.ts.
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { checkpoint } from "../engine/rollback.ts";
import { str } from "./flags.ts";

export const checkpointCommand = buildCommand<Record<never, never>, [string], BoomContext>({
  docs: { brief: "Name the most recent sync as a checkpoint (survives pruning; rollback --to it)" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ parse: str, placeholder: "name", brief: "checkpoint name (e.g. before-defaults)" }],
    },
  },
  async func(_flags, name) {
    this.process.exitCode = await checkpoint(this, name);
  },
});
