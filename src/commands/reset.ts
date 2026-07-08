// `botu reset` — thin wrapper over engine/reset.ts.
import { buildCommand } from "@stricli/core";
import type { BotuContext } from "../context.ts";
import { resetConfigRepo } from "../engine/reset.ts";

export const resetCommand = buildCommand<Record<never, never>, [], BotuContext>({
  docs: { brief: "Discard local changes in the config repo and reset it to origin" },
  parameters: {},
  async func() {
    this.process.exitCode = await resetConfigRepo(this);
  },
});
