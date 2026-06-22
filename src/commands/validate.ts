// `botu validate` — thin wrapper over engine/validate.ts. Parse + schema-check the
// botufile and overlays; change nothing. Exit 0 valid / 1 invalid.
import { buildCommand } from "@stricli/core";
import type { BotuContext } from "../context.ts";
import { validateConfig } from "../engine/validate.ts";

export const validateCommand = buildCommand<Record<never, never>, [], BotuContext>({
  docs: { brief: "Parse + schema-check the botufile (and overlays); change nothing" },
  parameters: {},
  async func() {
    this.process.exitCode = await validateConfig(this);
  },
});
