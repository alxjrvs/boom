// `boom status` — the one-screen machine dashboard: config, config-repo drift, last sync +
// checkpoints, fleet, lock, and secret health, composed from what each command already owns.
// Thin wrapper over engine/overview.ts; warning-tier exit (0/2). Distinct from `boom source
// status` (config-repo git drift only) and `boom verify` (a full machine walk).
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { boomStatus } from "../engine/overview.ts";

export const statusCommand = buildCommand<{ json?: boolean }, [], BoomContext>({
  docs: { brief: "One-screen dashboard: config, drift, last sync, fleet, lock, and secret health" },
  parameters: {
    flags: { json: { kind: "boolean", optional: true, brief: "Emit a structured JSON report" } },
  },
  async func(flags) {
    this.process.exitCode = await boomStatus(this, flags.json);
  },
});
