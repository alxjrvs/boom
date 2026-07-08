// `botu push` — push the managed config-repo clone's local commits upstream. No
// auto-commit: you commit your edits yourself, this just saves cd-ing into a cache
// dir you don't normally think about. Exit 0 on success, 1 otherwise (no config
// linked, or git push failed).
import { readConfigBreadcrumb } from "../config/load.ts";
import type { BotuContext } from "../context.ts";
import { push } from "../lib/git.ts";

export async function pushConfigRepo(ctx: BotuContext): Promise<number> {
  const breadcrumb = await readConfigBreadcrumb(ctx.env);
  if (!breadcrumb) {
    ctx.process.stderr.write("botu: no remote config linked — run `botu link <owner/repo>`\n");
    return 1;
  }
  const result = push(breadcrumb.path, ctx.env);
  if (result.stdout) ctx.process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) ctx.process.stderr.write(`${result.stderr}\n`);
  if (result.code !== 0) return 1;
  ctx.process.stdout.write("botu: pushed\n");
  return 0;
}
