// `botu watchtower` — local 1Password security audit. Placeholder: the op-based audit
// (emitting only hashes/metadata) is a follow-up; it was a stub in the bash engine too.
import { buildCommand } from "@stricli/core";
import type { BotuContext } from "../context.ts";

export const watchtowerCommand = buildCommand<Record<never, never>, [], BotuContext>({
  docs: { brief: "1Password security audit (placeholder)" },
  parameters: {},
  func() {
    this.process.stdout.write(
      "botu watchtower: not yet implemented — the op-based audit lands in a follow-up\n",
    );
  },
});
