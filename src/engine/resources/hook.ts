// The `hook` resource — the TS-native resource-type extension contract that replaces
// the bash `_NAME_<verb>` hooks. A hook is hooks/<name>.ts exporting verb functions
// that receive a small typed API. Loaded by runtime import() (works in the compiled
// binary). This is the public extension point (§3 of the design).
import { join } from "node:path";
import type { OsKind } from "../../config/profile.ts";
import type { Hook } from "../../config/schema.ts";
import { pathExists } from "../../lib/fs.ts";
import { journalWrite } from "../journal.ts";
import type { ManifestEntry } from "../state.ts";
import type { LinkMode, ReconcileCtx, Verb } from "../types.ts";

export interface HookApi {
  // `with` inputs arrive already TOML-typed (string | number | boolean | array | table), not
  // stringified — so a hook reads `api.with.count as number` instead of parsing "5".
  readonly with: Record<string, unknown>;
  readonly verb: Verb;
  readonly dryRun: boolean;
  readonly env: Record<string, string | undefined>;
  // The run's context, so a hook never has to reconstruct it. `repo` is the DECLARING section's
  // origin (registry.ts swaps it per section), which is what lets a module ship its own hook;
  // `os`/`host`/`profiles` come from the run's ProfileContext rather than `process.platform`,
  // which cannot see `--profile` or the BOOM_OS/BOOM_HOST overrides.
  readonly repo: string;
  readonly vars: Record<string, string>;
  readonly os: OsKind;
  readonly host: string;
  readonly profiles: ReadonlySet<string>;
  readonly linkMode: LinkMode;
  readonly verbose: boolean;
  ok(s: string): void;
  warn(s: string): void;
  fail(s: string): void;
  note(s: string): void;
  // The two quiet tiers a core resource uses, so a converged hook is as silent as a converged
  // link: `skip` collapses out of the default bands, `plan` is the "would …" line of a dry run.
  plan(s: string): void;
  skip(s: string): void;
  // Claim a destination: it enters the manifest, so orphan reaping treats it exactly like a link
  // or copy boom placed itself. Say it plainly — declare() means "boom owns this and may delete
  // it". It is NOT an uninstall path: `boom uninstall` dispatches the uninstall verb per section
  // and then clears the manifest without reading it (reconcile.ts), so tearing a hook-placed file
  // down is the hook's own `uninstall` export.
  //
  // `ManifestEntry` is reused VERBATIM, never widened: `kind` is fixed to "link" | "copy" because
  // reapOrphans (reconcile.ts) branches on exactly those two and `toEntry` (state.ts) coerces
  // anything else to "link" on read-back — a third kind would be silently reaped as a link. A hook
  // that GENERATES content declares `kind: "copy"` with `src` pointing at the repo file it came
  // from; that is what arms reaping's byte-match guard, which refuses to delete a file the user
  // has since edited.
  declare(e: ManifestEntry): void;
  // Record the undo for a file the hook is about to write — intent, displace-to-backup, done —
  // all BEFORE the write, so what it overwrites is displaced, not destroyed.
  //
  // GOTCHA, and the reason this is a one-line wrapper rather than open-coded here: the helper
  // calls `displace()`, and `displace` with no `backupRoot` REMOVES the path. `journal` and
  // `backupRoot` are set together and only for a mutating sync, so an unguarded call on a verify
  // or a dry run would delete the hook's target while the run claims to change nothing. The
  // `if (!ctx.journal) return` guard lives inside `journalWrite` (engine/journal.ts), in one
  // place, precisely so no caller — including this one — can forget it.
  journalWrite(op: string, file: string): Promise<void>;
}

type HookFn = (api: HookApi) => void | Promise<void>;
export interface HookModule {
  sync?: HookFn;
  verify?: HookFn;
  uninstall?: HookFn;
  // Optional, and invoked on EVERY verb — including verify and dry runs — before the verb fn.
  // It has to be: reapOrphans compares the prior manifest against `ctx.declared` on `verify` too,
  // and an unmatched entry is a warn, which is verify's exit-2 tier. Declaring only inside `sync`
  // would turn every hook-declared file into false drift on every verify (and a desktop
  // notification on every scheduled one under `[boom] notify`). This is why `declare` sits on the
  // module shape rather than being folded into the verb functions.
  declare?: HookFn;
}

export async function reconcileHook(entry: Hook, ctx: ReconcileCtx): Promise<void> {
  const { report } = ctx;
  const dir = join(ctx.repo, "hooks");
  const file = join(dir, `${entry.name}.ts`);
  // GOTCHA: every bail-out below has to raise `ownershipIncomplete` before returning. A hook that
  // never reaches `declare` contributes nothing to `ctx.declared`, and reapOrphans deletes exactly
  // what the prior manifest holds and `declared` doesn't — so without this, a renamed hook file or
  // a half-fetched module turns an error path into a deletion path on a run that still exits 0.
  // The core resources hold the opposite invariant by pushing to `declared` as their first
  // statement (filesystem.ts), which a hook cannot do: the declarations live in its module.
  if (!(await pathExists(file))) {
    // Name the directory searched: for a module-shipped hook that is the module's own dir (the
    // per-section repo swap in registry.ts), not the config repo, and "missing X" is only
    // actionable if it says which X.
    report.warn(`hook ${entry.name}: missing ${entry.name}.ts in ${dir}`);
    ctx.ownershipIncomplete = true;
    return;
  }
  let mod: HookModule;
  try {
    const loaded = (await import(file)) as { default?: HookModule } & HookModule;
    mod = loaded.default ?? loaded;
  } catch (e) {
    report.fail(`hook ${entry.name}: failed to load — ${(e as Error).message}`);
    ctx.ownershipIncomplete = true;
    return;
  }

  // A hook can do anything; journal a non-reversible side marker (mutating runs only). This is no
  // longer the ONLY record of a hook's work — `journalWrite` rows are real, replayable undo on top
  // of it — but the marker stays unconditional: a hook is arbitrary code, so journaling part of it
  // never makes all of it reversible, and suppressing the marker once a hook journals anything
  // would silently promise reversibility for the un-journaled remainder.
  if (!ctx.dryRun && ctx.verb === "sync") await ctx.journal?.side("hook", entry.name);

  const api: HookApi = {
    with: entry.with ?? {},
    verb: ctx.verb,
    dryRun: ctx.dryRun,
    env: ctx.env,
    repo: ctx.repo,
    vars: ctx.vars,
    os: ctx.profile.os,
    host: ctx.profile.host,
    profiles: ctx.profile.profiles,
    linkMode: ctx.linkMode,
    verbose: ctx.verbose,
    ok: (s) => report.ok(s),
    warn: (s) => report.warn(s),
    fail: (s) => report.fail(s),
    note: (s) => report.note(s),
    plan: (s) => report.plan(s),
    skip: (s) => report.skip(s),
    declare: (e) => {
      ctx.declared.push(e);
    },
    journalWrite: (op, file) => journalWrite(op, file, ctx),
  };

  // A `declare` that threw is the same hole as a module that never loaded — it may have claimed
  // some of its destinations and not the rest — so the catch below distinguishes the two phases.
  let declared = false;
  try {
    // `declare` first and on every verb (see HookModule), and inside the same try/catch as the
    // verb fn so a throwing declare is a reported failure rather than an unwound run.
    if (mod.declare) await mod.declare(api);
    declared = true;
    // One function per verb — drift repair is `boom source --fix`, still the sync verb (just with
    // overwrite), so a hook's `sync` covers both a fresh install and a repair. The missing-verb
    // branch runs AFTER declare, or a sync-only hook would lose its declaration on verify.
    const fn = mod[ctx.verb];
    if (!fn) {
      // `note`, deliberately not `warn`: verify's warn tier is exit 2, so warning here would make
      // every sync-only hook permanent false drift (and a desktop alert on every scheduled
      // verify). A note still prints in the default bands and lands in --json.
      if (ctx.verb === "verify") report.note(`hook ${entry.name}: no verify export — unchecked`);
      else report.skip(`hook ${entry.name}: no ${ctx.verb} export`);
      return;
    }
    await fn(api);
  } catch (e) {
    if (!declared) ctx.ownershipIncomplete = true;
    report.fail(`hook ${entry.name}: ${(e as Error).message}`);
  }
}
