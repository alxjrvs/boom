// `botu push` — thin wrapper over engine/push.ts.
import { buildCommand } from "@stricli/core";
import type { BotuContext } from "../context.ts";
import { pushConfigRepo } from "../engine/push.ts";

export const pushCommand = buildCommand<Record<never, never>, [], BotuContext>({
  docs: { brief: "Push the config repo's local commits upstream" },
  parameters: {},
  async func() {
    this.process.exitCode = await pushConfigRepo(this);
  },
});
