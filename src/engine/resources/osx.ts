// The osx_default resource: `defaults write/read` a macOS default. OS-gated to
// darwin (a no-op elsewhere), like the bash engine. Marks ctx.osx.changed so apply
// can restart the owning UI processes at the end of the run.
import { detectOs } from "../../config/profile.ts";
import type { OsxDefault } from "../../config/schema.ts";
import { expandHome } from "../../lib/fs.ts";
import { cleanEnv } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

type OsxType = OsxDefault["type"];
type OsxValue = OsxDefault["value"];

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
  const { domain, key, type } = entry;
  const disp = `${domain} ${key}`;
  const env = cleanEnv(ctx.env);
  // String values are written verbatim by `defaults write` (no shell to expand
  // them), so resolve ~/$HOME here; non-string values pass through unchanged.
  const value: OsxValue = type === "string" ? expandHome(String(entry.value), ctx.env) : entry.value;
  const want = osxWanted(type, value);

  const readCurrent = (): { ok: boolean; cur: string } => {
    const p = Bun.spawnSync(["defaults", "read", domain, key], { env, stdout: "pipe", stderr: "ignore" });
    return { ok: p.exitCode === 0, cur: p.exitCode === 0 ? new TextDecoder().decode(p.stdout).trim() : "" };
  };

  switch (ctx.verb) {
    case "apply":
    case "fix": {
      if (ctx.dryRun) {
        report.plan(`would set ${disp} -${type} ${want}`);
        return;
      }
      // Idempotent: skip the write when the stored value already matches. This is
      // what gates the UI restart — `defaults write` always exits 0, so writing
      // unconditionally would flag every apply as "changed" and needlessly restart
      // Dock/Finder/SystemUIServer even when nothing changed.
      const { ok, cur } = readCurrent();
      if (ok && osxMatches(type, cur, value)) {
        report.ok(`${disp} = ${want} (unchanged)`);
        return;
      }
      const p = Bun.spawnSync(["defaults", "write", domain, key, `-${type}`, String(value)], {
        env,
        stdout: "ignore",
        stderr: "ignore",
      });
      if (p.exitCode === 0) {
        report.ok(`${disp} = ${want}`);
        ctx.osx.changed = true;
      } else {
        report.fail(`${disp} (defaults write failed)`);
      }
      return;
    }
    case "verify": {
      const { ok, cur } = readCurrent();
      if (ok && osxMatches(type, cur, value)) report.ok(`${disp} = ${want}`);
      else report.warn(`${disp} = ${cur || "<unset>"}, expected ${want}`);
      return;
    }
    case "uninstall":
      return;
  }
}
