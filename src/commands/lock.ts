// `boom lock` — record resolved package versions into boom.lock (reproducibility beyond
// "latest at sync time"). `--check` compares the machine against the lock and exits 0/2/1
// instead of writing. A thin wrapper over engine/lock.ts.
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { boomLock } from "../engine/lock.ts";

export const lockCommand = buildCommand<{ check?: boolean; json?: boolean }, [], BoomContext>({
  docs: { brief: "Pin resolved package versions to boom.lock (--check reports drift, exit 0/2/1)" },
  parameters: {
    flags: {
      check: {
        kind: "boolean",
        optional: true,
        brief: "Compare installed versions against boom.lock instead of writing it",
      },
      json: { kind: "boolean", optional: true, brief: "Emit a structured JSON report" },
    },
  },
  async func(flags) {
    this.process.exitCode = await boomLock(this, flags.check, flags.json);
  },
});
