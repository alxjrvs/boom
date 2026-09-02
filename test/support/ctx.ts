// A BoomContext whose output is captured instead of written — the shape every in-process suite
// drives a command or the engine with. stdout and stderr land in one buffer, in order: the
// suites assert on what a user would see, and a user sees both.
import type { BoomContext } from "../../src/context.ts";

export interface FakeCtx {
  readonly ctx: BoomContext;
  out(): string;
  clear(): void;
  code(): number;
}

// `env` is shared by reference with the context (ctx.env and ctx.process.env are this object),
// so a suite can still adjust it after construction — prepend a fake tool to PATH, say.
export function fakeCtx(env: Record<string, string | undefined>, cwd: string): FakeCtx {
  const buf = { out: "" };
  const write = (s: string): void => {
    buf.out += s;
  };
  const proc = { stdout: { write }, stderr: { write }, env, exitCode: 0 };
  return {
    ctx: { process: proc, env, cwd } as unknown as BoomContext,
    out: () => buf.out,
    clear: () => {
      buf.out = "";
    },
    code: () => proc.exitCode,
  };
}
