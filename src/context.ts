import type { CommandContext, StricliProcess } from "@stricli/core";

// Context threaded to every command. Extends Stricli's CommandContext with the
// environment + working directory (so commands resolve config/state without reaching
// for globals — and stay unit-testable), and narrows `process` to StricliProcess so
// commands set `this.process.exitCode` rather than the global (keeps `bun test` clean).
export interface BotuContext extends CommandContext {
  readonly process: StricliProcess;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
}

export function buildContext(proc: typeof process): BotuContext {
  return { process: proc, env: proc.env, cwd: proc.cwd() };
}
