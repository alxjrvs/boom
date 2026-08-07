// Committing local changes in the managed config-repo clone. `commitLocalChanges` is the
// shared half used by both callers of the commit step, so the default message/behavior
// can't drift between them: `boom source push` (push.ts) commits-then-pushes, and sync's
// --commit mode (engine/sync.ts) commits before pulling instead of autostashing.
import { addAll, commitStaged, isClean } from "../lib/git.ts";
import type { Env } from "../lib/paths.ts";

export const DEFAULT_COMMIT_MESSAGE = "boom: local changes";

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
