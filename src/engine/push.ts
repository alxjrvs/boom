// `boom source push` — push the managed config-repo clone's local commits upstream. No
// auto-commit: you commit your edits yourself, this just saves cd-ing into a cache
// dir you don't normally think about. Exit 0 on success, 1 otherwise (no config
// linked, or git push failed).
import { requireConfigBreadcrumb } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import { push } from "../lib/git.ts";

export async function pushConfigRepo(ctx: BoomContext): Promise<number> {
  const breadcrumb = await requireConfigBreadcrumb(ctx);
  if (!breadcrumb) return 1;
  const result = push(breadcrumb.path, ctx.env);
  if (result.stdout) ctx.process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) ctx.process.stderr.write(`${result.stderr}\n`);
  if (result.code !== 0) return 1;
  ctx.process.stdout.write("boom: pushed\n");
  return 0;
}
