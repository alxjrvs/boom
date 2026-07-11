// Discovered subcommands: a name that isn't a built-in is looked up at
// <config>/commands/<name>.ts and run via runtime import() — the "no hardcoded
// dispatch table" principle, now for user commands (built-ins are the Stricli route
// map). A user command default-exports (args, ctx) => number | void.
import { join } from "node:path";
import { resolveConfigDir } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import { pathExists } from "../lib/fs.ts";

type UserCommand = (args: string[], ctx: BoomContext) => number | undefined | Promise<number | undefined>;

// Returns the exit code, or undefined if there is no such command (caller falls back).
export async function runUserCommand(
  name: string,
  args: string[],
  ctx: BoomContext,
): Promise<number | undefined> {
  const repo = await resolveConfigDir(ctx.env, ctx.cwd);
  if (!repo) return undefined;
  const file = join(repo, "commands", `${name}.ts`);
  if (!(await pathExists(file))) return undefined;

  let fn: UserCommand | undefined;
  try {
    const mod = (await import(file)) as { default?: UserCommand };
    fn = mod.default;
  } catch (e) {
    // Exit 1 (a hard failure), not 2 — 2 is the verify/status warning tier in this CLI,
    // and a broken user command is an error, not a warning.
    ctx.process.stderr.write(`boom ${name}: failed to load — ${(e as Error).message}\n`);
    return 1;
  }
  if (!fn) {
    ctx.process.stderr.write(`boom ${name}: command has no default export\n`);
    return 1;
  }
  const rc = await fn(args, ctx);
  return typeof rc === "number" ? rc : 0;
}
