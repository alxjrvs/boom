// `botu doctor` — thin wrapper over engine/doctor.ts. Reports botu's own preconditions
// (config, tools, keychain, state) and sets the exit code (0 ok / 2 warn / 1 fail).
import { buildCommand } from "@stricli/core";
import type { BotuContext } from "../context.ts";
import { doctor } from "../engine/doctor.ts";

export const doctorCommand = buildCommand<Record<never, never>, [], BotuContext>({
  docs: { brief: "Check botu's own preconditions (config, tools, keychain, state)" },
  parameters: {},
  async func() {
    this.process.exitCode = await doctor(this);
  },
});
