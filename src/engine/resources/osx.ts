// The osx_default resource: `defaults write/read` a macOS default. OS-gated to
// darwin (a no-op elsewhere), like the bash engine. Marks ctx.dirty("osx") so its own
// finalizeOsx can restart the owning UI processes at the end of the run.
import { detectOs } from "../../config/profile.ts";
import type { OsxDefault } from "../../config/schema.ts";
import { expandHome } from "../../lib/fs.ts";
import { captureArgv, cleanEnv } from "../../lib/proc.ts";
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

export function reconcileOsxDefault(entry: OsxDefault, ctx: ReconcileCtx): void {
  if (detectOs(ctx.env) !== "darwin") return;
  const { report } = ctx;
  const { domain, key } = entry;
  const type = entry.type ?? inferType(entry.value);
  const disp = `${domain} ${key}`;
  const env = cleanEnv(ctx.env);
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
      const p = Bun.spawnSync(["defaults", "write", domain, key, `-${type}`, String(value)], {
        env,
        stdout: "ignore",
        stderr: "ignore",
      });
      if (p.exitCode === 0) {
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
    case "uninstall":
      return;
  }
}

// End-of-run finalize (registered on the osx resource, called once by finalizeResources).
// Applied macOS defaults don't take effect until their owning apps restart — a universal
// consequence of osx_default, so the engine does it, not the config. Self-gates on
// ctx.dirty: only fires when a `defaults write` actually changed something this run (which
// only happens on a mutating, non-dry darwin run), so it's a no-op for verify/uninstall/dry.
export function finalizeOsx(ctx: ReconcileCtx): void {
  if (!ctx.dirty.has("osx") || detectOs(ctx.env) !== "darwin") return;
  ctx.report.header("macOS finalize");
  // Best-effort: killall exits nonzero when a named process isn't running, which is normal
  // and not worth surfacing — the restart is a courtesy so changes show without a re-login.
  Bun.spawnSync(["killall", "Dock", "Finder", "SystemUIServer"], { stdout: "ignore", stderr: "ignore" });
  ctx.report.ok("restarted Dock/Finder/SystemUIServer (defaults changed)");
}
