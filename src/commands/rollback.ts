// `botu rollback [--run-id <id>]` — undo a previous apply (the most recent by default).
import { buildCommand } from "@stricli/core";
import type { BotuContext } from "../context.ts";
import { rollback } from "../engine/rollback.ts";

export const rollbackCommand = buildCommand<{ runId?: string }, [], BotuContext>({
  docs: { brief: "Undo a previous apply (most recent run, or --run-id)" },
  parameters: {
    flags: {
      runId: { kind: "parsed", parse: (s: string) => s, optional: true, brief: "Run id to roll back" },
    },
  },
  async func(flags) {
    this.process.exitCode = await rollback(this, flags.runId);
  },
});
