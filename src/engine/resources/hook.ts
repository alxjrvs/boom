// The `hook` resource — the TS-native resource-type extension contract that replaces
// the bash `_NAME_<verb>` hooks. A hook is hooks/<name>.ts exporting verb functions
// that receive a small typed API. Loaded by runtime import() (works in the compiled
// binary). This is the public extension point (§3 of the design).
import { join } from "node:path";
import type { Hook } from "../../config/schema.ts";
import { pathExists } from "../../lib/fs.ts";
import type { ReconcileCtx, Verb } from "../types.ts";

export interface HookApi {
  readonly with: Record<string, string>;
  readonly verb: Verb;
  readonly dryRun: boolean;
  readonly env: Record<string, string | undefined>;
  ok(s: string): void;
  warn(s: string): void;
  fail(s: string): void;
  note(s: string): void;
}

type HookFn = (api: HookApi) => void | Promise<void>;
export interface HookModule {
  sync?: HookFn;
  verify?: HookFn;
  fix?: HookFn;
  uninstall?: HookFn;
}

export async function reconcileHook(entry: Hook, ctx: ReconcileCtx): Promise<void> {
  const { report } = ctx;
  const file = join(ctx.repo, "hooks", `${entry.name}.ts`);
  if (!(await pathExists(file))) {
    report.warn(`hook ${entry.name}: missing ${file}`);
    return;
  }
  let mod: HookModule;
  try {
    const loaded = (await import(file)) as { default?: HookModule } & HookModule;
    mod = loaded.default ?? loaded;
  } catch (e) {
    report.fail(`hook ${entry.name}: failed to load — ${(e as Error).message}`);
    return;
  }
  // fix falls back to sync (fix = re-sync), matching the bash contract: a hook
  // only needs a distinct `fix` when its drift-fix differs from a fresh install.
  const fn = ctx.verb === "fix" ? (mod.fix ?? mod.sync) : mod[ctx.verb];
  if (!fn) return;

  // A hook can do anything; journal it as a non-reversible side effect (mutating runs
  // only) so rollback can warn that replaying it can't be undone.
  if (!ctx.dryRun && (ctx.verb === "sync" || ctx.verb === "fix")) await ctx.journal?.side("hook", entry.name);

  const api: HookApi = {
    with: entry.with ?? {},
    verb: ctx.verb,
    dryRun: ctx.dryRun,
    env: ctx.env,
    ok: (s) => report.ok(s),
    warn: (s) => report.warn(s),
    fail: (s) => report.fail(s),
    note: (s) => report.note(s),
  };
  try {
    await fn(api);
  } catch (e) {
    report.fail(`hook ${entry.name}: ${(e as Error).message}`);
  }
}
