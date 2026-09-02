// The osx_default resource: `defaults write/read` a macOS default. OS-gated to darwin (a
// no-op elsewhere). Marks ctx.dirty("osx") so its own finalizeOsx can restart the owning UI
// processes at the end of the run.
import type { OsxDefault } from "../../config/schema.ts";
import { expandHome } from "../../lib/fs.ts";
import { captureArgv } from "../../lib/proc.ts";
import { firstOsxUndo, stashOsxPrior, type UndoToken } from "../journal.ts";
import type { ReconcileCtx } from "../types.ts";

// `type` is optional in the schema; NonNullable is the resolved type after inference.
type OsxType = NonNullable<OsxDefault["type"]>;
type OsxValue = OsxDefault["value"];

// Infer the `defaults` type from the TOML value's own type when `type` is omitted: TOML
// already distinguishes bool/int/float/string, so restating it is redundant. An explicit
// `type` still wins — the escape hatch for the one ambiguity inference can't resolve (an
// integer-valued float, or a numeric string that must stay a string).
function inferType(value: OsxValue): OsxType {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  return "string";
}

// The canonical string a declared default *should* read back as. `defaults read`
// prints booleans as 1/0, ints/floats as their numeric text, strings verbatim — so
// normalize the config value into that space before comparing.
export function osxWanted(type: OsxType, value: OsxValue): string {
  switch (type) {
    case "bool":
      return value === true || value === 1 || value === "1" || value === "true" || value === "YES"
        ? "1"
        : "0";
    case "int":
      return String(Math.trunc(Number(value)));
    case "float":
      return String(Number(value));
    case "string":
      return String(value);
  }
}

// Does the current `defaults read` output match the declared value? int/float compare
// numerically (so `0.5` matches a stored `0.50000` and `2` matches `2.0`); bool/string
// compare as text against the normalized wanted value.
export function osxMatches(type: OsxType, current: string, value: OsxValue): boolean {
  const want = osxWanted(type, value);
  if (type === "int" || type === "float") return Number(current) === Number(want);
  return current.trim() === want;
}

// The uninstall arm below restores the machine's pre-boom value from the durable `meta` stash
// (firstOsxUndo), which outlives journal pruning where an `ops` row would not; its own write is
// then journaled like every other removal, under a distinct op so the sync arm's earliest-row
// fallback can never mistake it for the pre-boom prior. Every `defaults` call goes through
// captureArgv with the run's env, which is what lets a sandboxed test intercept it on PATH.
export async function reconcileOsxDefault(entry: OsxDefault, ctx: ReconcileCtx): Promise<void> {
  if (ctx.profile.os !== "darwin") return;
  const { report } = ctx;
  const { domain, key } = entry;
  const type = entry.type ?? inferType(entry.value);
  const disp = `${domain} ${key}`;
  // String values are written verbatim by `defaults write` (no shell to expand
  // them), so resolve ~/$HOME here; non-string values pass through unchanged.
  const value: OsxValue = type === "string" ? expandHome(String(entry.value), ctx.env) : entry.value;
  const want = osxWanted(type, value);

  // captureArgv (not a raw Bun.spawnSync) so a missing/erroring `defaults` degrades to
  // {ok:false} instead of throwing — and the stdout trim lives in one place, not here.
  const readCurrent = (): { ok: boolean; cur: string } => {
    const r = captureArgv(["defaults", "read", domain, key], ctx.env);
    return { ok: r.code === 0, cur: r.code === 0 ? r.stdout : "" };
  };

  switch (ctx.verb) {
    case "sync": {
      if (ctx.dryRun) {
        report.plan(`would set ${disp} -${type} ${want}`);
        return;
      }
      // Idempotent: skip the write when the stored value already matches. This is
      // what gates the UI restart — `defaults write` always exits 0, so writing
      // unconditionally would flag every sync as "changed" and needlessly restart
      // Dock/Finder/SystemUIServer even when nothing changed.
      const { ok, cur } = readCurrent();
      if (ok && osxMatches(type, cur, value)) {
        report.skip(`${disp} = ${want} (unchanged)`);
        return;
      }
      // Journal the prior value (or `null` if the key was unset) before writing, so `boom
      // uninstall` can `defaults write` it back — or `defaults delete` a key boom introduced.
      // Recorded before the write, like the file resources: a crash mid-write is still
      // reversible (restoring the unchanged prior is a harmless no-op).
      const undo: Extract<UndoToken, { kind: "osx" }> = {
        kind: "osx",
        domain,
        key,
        type,
        prior: ok ? cur : null,
      };
      // Same token on both rows: the `defaults write` below is the mutation, so nothing is
      // displaced in the intent→done window and this site was never at risk. Recording it
      // anyway keeps "every intent row names its own undo" true of the whole journal.
      ctx.journal?.intent("osx", disp, undo);
      ctx.journal?.done("osx", disp, undo);
      // The journal row ages out (pruneRuns keeps 10 runs); the machine's *pre-boom* value has
      // to outlive it or `boom uninstall` would later "restore" boom's own earlier value as if
      // the user had set it. The stash is insert-if-absent, which is what makes it the FIRST
      // prior rather than the latest. Gated on ctx.journal so only a real mutating run records
      // one — a prior is a fact about a write that happened.
      if (ctx.journal) await stashOsxPrior(ctx.env, undo);
      const p = captureArgv(["defaults", "write", domain, key, `-${type}`, String(value)], ctx.env);
      if (p.code === 0) {
        report.ok(`${disp} = ${want}`);
        ctx.dirty.add("osx");
      } else {
        report.fail(`${disp} (defaults write failed)`);
      }
      return;
    }
    case "verify": {
      const { ok, cur } = readCurrent();
      if (ok && osxMatches(type, cur, value)) report.skip(`${disp} = ${want}`);
      else report.warn(`${disp} = ${cur || "<unset>"}, expected ${want}`);
      return;
    }
    case "uninstall": {
      // Everything needed to reverse the write is already recorded, so returning early here was
      // boom leaving the machine changed by a teardown that claims to remove it.
      const undo = await firstOsxUndo(ctx.env, domain, key);
      if (!undo) {
        // Without a record boom cannot tell a key it introduced from one that was always there,
        // and deleting someone else's default is unrecoverable — so leave it and say so.
        report.skip(`${disp} — no journaled prior, left as is`);
        return;
      }
      const verb = undo.prior === null ? "delete" : "restore";
      if (ctx.dryRun) {
        report.plan(`would ${verb} ${disp}`);
        return;
      }
      // The teardown's own undo: what the key holds right now (boom's value, or null if it is
      // already gone), recorded before the write like every other mutation.
      const now = readCurrent();
      const teardown: Extract<UndoToken, { kind: "osx" }> = {
        kind: "osx",
        domain,
        key,
        type: undo.type,
        prior: now.ok ? now.cur : null,
      };
      ctx.journal?.intent("osx-restore", disp, teardown);
      ctx.journal?.done("osx-restore", disp, teardown);
      const argv =
        undo.prior === null
          ? ["defaults", "delete", domain, key]
          : ["defaults", "write", domain, key, `-${undo.type}`, undo.prior];
      const p = captureArgv(argv, ctx.env);
      if (p.code !== 0) {
        // `defaults delete` exits 1 on a key that is already gone, and the meta stash is never
        // invalidated by an uninstall — so without this the delete is re-attempted forever and
        // every uninstall after the first one fails. Absent means the teardown's goal already
        // holds: idempotent, like dir.ts's `if (!(await pathExists(path))) return`, and nothing
        // moved, so no ctx.dirty and no UI restart.
        if (undo.prior === null && !readCurrent().ok) {
          report.skip(`${disp} already unset`);
          return;
        }
        report.fail(`${disp} (defaults ${verb} failed)`);
        return;
      }
      report.ok(undo.prior === null ? `${disp} deleted` : `${disp} restored to ${undo.prior}`);
      // Same reason as sync: the owning UI processes only pick up a changed default on restart,
      // and a teardown that leaves the Dock showing boom's value has not finished.
      ctx.dirty.add("osx");
      return;
    }
  }
}

// End-of-run finalize (registered on the osx resource, called once by finalizeResources).
// Applied macOS defaults don't take effect until their owning apps restart — a universal
// consequence of osx_default, so the engine does it, not the config. Self-gates on
// ctx.dirty: only fires when a `defaults write` actually changed something this run (which
// only happens on a mutating, non-dry darwin run), so it's a no-op for verify/uninstall/dry.
export function finalizeOsx(ctx: ReconcileCtx): void {
  if (!ctx.dirty.has("osx") || ctx.profile.os !== "darwin") return;
  ctx.report.header("macOS finalize");
  // Best-effort: killall exits nonzero when a named process isn't running, which is normal
  // and not worth surfacing — the restart is a courtesy so changes show without a re-login.
  // The run's env (so it honors the run's PATH) matches the `defaults` calls above, and lets a
  // sandboxed test intercept the restart instead of nuking the runner's real Dock/Finder.
  captureArgv(["killall", "Dock", "Finder", "SystemUIServer"], ctx.env);
  ctx.report.ok("restarted Dock/Finder/SystemUIServer (defaults changed)");
}
