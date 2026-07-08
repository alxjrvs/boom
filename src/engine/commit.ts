// `botu commit` — commit local changes in the managed config-repo clone directly,
// without a full apply. `commitLocalChanges` is the shared half: apply's --commit
// mode (engine/sync.ts) calls it too, so the default message/behavior can't drift
// between the two entry points. No auto-push — pair with `botu push` (push.ts's
// "no auto-commit" is the mirror image of this file's "no auto-push").
import { readConfigBreadcrumb } from "../config/load.ts";
import type { BotuContext } from "../context.ts";
import { addAll, commitStaged, isClean } from "../lib/git.ts";
import type { Env } from "../lib/proc.ts";

export const DEFAULT_COMMIT_MESSAGE = "botu: local changes";

export type CommitOutcome =
  | { readonly kind: "clean" }
  | { readonly kind: "committed"; readonly message: string }
  | { readonly kind: "failed"; readonly stderr: string };

export function commitLocalChanges(dir: string, env: Env, message?: string): CommitOutcome {
  if (isClean(dir, env)) return { kind: "clean" };
  addAll(dir, env);
  const msg = message ?? DEFAULT_COMMIT_MESSAGE;
  const result = commitStaged(dir, msg, env);
  if (result.code !== 0) return { kind: "failed", stderr: result.stderr || "git commit failed" };
  return { kind: "committed", message: msg };
}

export async function commitConfigRepo(ctx: BotuContext, message?: string): Promise<number> {
  const breadcrumb = await readConfigBreadcrumb(ctx.env);
  if (!breadcrumb) {
    ctx.process.stderr.write("botu: no remote config linked — run `botu link <owner/repo>`\n");
    return 1;
  }
  const outcome = commitLocalChanges(breadcrumb.path, ctx.env, message);
  switch (outcome.kind) {
    case "clean":
      ctx.process.stdout.write("botu: nothing to commit\n");
      return 0;
    case "committed":
      ctx.process.stdout.write(`botu: committed (${outcome.message})\n`);
      return 0;
    case "failed":
      ctx.process.stderr.write(`botu: git commit failed: ${outcome.stderr}\n`);
      return 1;
  }
}
