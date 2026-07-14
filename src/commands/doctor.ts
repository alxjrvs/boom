// `boom doctor` — thin wrapper over engine/doctor.ts. Reports boom's own preconditions
// (config, tools, keychain, state) and sets the exit code (0 ok / 2 warn / 1 fail).
// `--config` narrows it to just the boomfile parse (the former `boom validate`): a
// read-only CI gate, pass/fail 0/1.
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { doctor } from "../engine/doctor.ts";

export const doctorCommand = buildCommand<{ json?: boolean; config?: boolean }, [], BoomContext>({
  docs: { brief: "Check boom's own preconditions (config, tools, keychain, state)" },
  parameters: {
    flags: {
      config: {
        kind: "boolean",
        optional: true,
        brief: "Only parse + schema-check the boomfile and overlays (CI gate); exit 0/1",
      },
      json: { kind: "boolean", optional: true, brief: "Emit a structured JSON report" },
    },
  },
  async func(flags) {
    this.process.exitCode = await doctor(this, flags.json, flags.config);
  },
});
