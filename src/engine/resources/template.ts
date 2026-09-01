// The `tmpl` resource: render one repo-relative template to a destination, substituting the
// `${env:VAR}`/`${host}`/`${os}` vocabulary and the boomfile's top-level `[vars]` table into
// `${NAME}` placeholders. One template + per-profile vars replaces N near-identical
// machine-specific overlay files.
//
// It shares `copy`'s journal discipline (declared as a managed `copy`, displace-before-write,
// change-gated skip) with two deliberate departures:
//   • an unknown `${NAME}` is a hard failure, not a silent passthrough — a config that ships
//     with an unresolved placeholder is worse than one that loudly refuses to render;
//   • a literal shell `${FOO:-bar}` (anything that isn't a bare identifier) is left verbatim,
//     so real shell config survives.
import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Tmpl } from "../../config/schema.ts";
import { displayPath, expandTilde, pathExists } from "../../lib/fs.ts";
import { journalRemove, journalWrite } from "../journal.ts";
import type { ReconcileCtx } from "../types.ts";

// The machine vocabulary: `${env:VAR}` / `${host}` / `${os}`. Unknown `${env:…}` resolves to
// empty; unmatched `${…}` is left verbatim (so a literal shell `${...}` in a config survives).
// `host`/`os` come from the run's profile, never `os.hostname()`/`process.platform`, so a
// template honours the same BOOM_HOST/BOOM_OS overrides that gate its section.
function renderTemplate(text: string, ctx: ReconcileCtx): string {
  return text
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => ctx.env[name] ?? "")
    .replace(/\$\{host\}/g, () => ctx.profile.host)
    .replace(/\$\{os\}/g, () => ctx.profile.os);
}

// A bare `${identifier}` placeholder — the `[vars]` reference form. Deliberately narrow: an
// expression with any other character (`${env:X}`, `${FOO:-bar}`) is not matched here, so
// `${env:…}`/`${host}`/`${os}` are left for renderTemplate and shell literals pass through
// untouched — "leave the unmatched verbatim".
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Render `text`: first the machine vocabulary (`${env:VAR}`/`${host}`/`${os}`), then the
// `[vars]` placeholders. Any `${NAME}` with no matching var is collected into `missing` and
// left in place — the caller turns a non-empty `missing` into a reported failure.
function renderTmpl(text: string, ctx: ReconcileCtx, missing: Set<string>): string {
  return renderTemplate(text, ctx).replace(VAR, (whole, name: string) => {
    // `Object.hasOwn`, never `in`: `in` walks the prototype chain, so `${toString}` /
    // `${constructor}` / `${valueOf}` would resolve to Object.prototype's members and render
    // native function source into the destination — reported as a *success*, silently
    // defeating this resource's "an unknown ${NAME} is a hard failure" guarantee.
    if (Object.hasOwn(ctx.vars, name)) return ctx.vars[name] as string;
    missing.add(name);
    return whole;
  });
}

export async function reconcileTmpl(entry: Tmpl, ctx: ReconcileCtx): Promise<void> {
  const src = join(ctx.repo, entry.src);
  const dst = expandTilde(entry.dst, ctx.env);
  ctx.declared.push({ kind: "copy", dst, src });
  const disp = displayPath(dst, ctx.env);
  const { report } = ctx;
  const wantMode = entry.mode ? Number.parseInt(entry.mode, 8) : undefined;

  // The rendered content, or undefined on any render failure (missing template, unknown var) —
  // `report` is only called when `announce` is set, so the quiet uninstall change-gate can
  // reuse this without emitting a spurious failure line.
  const render = async (announce: boolean): Promise<string | undefined> => {
    if (!(await pathExists(src))) {
      if (announce) report.fail(`${disp} ← ${entry.src} (template missing — not rendered)`);
      return undefined;
    }
    const missing = new Set<string>();
    const out = renderTmpl(await Bun.file(src).text(), ctx, missing);
    if (missing.size > 0) {
      if (announce) {
        const names = [...missing].map((n) => `\${${n}}`).join(", ");
        report.fail(`${disp} ← ${entry.src} (undefined var${missing.size > 1 ? "s" : ""}: ${names})`);
      }
      return undefined;
    }
    return out;
  };

  switch (ctx.verb) {
    case "sync": {
      const content = await render(true);
      if (content === undefined) return;
      // Change-gate: an already-rendered dst is skipped (no rewrite, no journal churn, no fresh
      // backup of an unchanged file), mirroring copy.
      if ((await pathExists(dst)) && (await Bun.file(dst).text()) === content) {
        // Content is current — but still enforce the declared mode. A rendered file whose
        // permissions drifted looser (a prior umask, a manual chmod) would otherwise never be
        // repaired: the change-gate returns before the chmod below, so `--fix` is a no-op and
        // `verify` is blind. Re-chmod without rewriting.
        if (wantMode !== undefined && ((await stat(dst)).mode & 0o777) !== wantMode) {
          if (ctx.dryRun) {
            report.plan(`${disp} mode would be set to 0${wantMode.toString(8)}`);
            return;
          }
          await chmod(dst, wantMode);
          report.ok(`${disp} mode set to 0${wantMode.toString(8)}`);
          return;
        }
        report.skip(`${disp} already up to date`);
        return;
      }
      if (ctx.dryRun) {
        report.plan(`${disp} would be rendered`);
        return;
      }
      // Undo before the write (same rationale as copy): a displaced original is in the backup
      // tree with a `done` row that restores it; a fresh write's undo is a remove. Identical to
      // the `copy` resource's arm, so it routes through the identical helper.
      await journalWrite("copy", dst, ctx, true);
      await Bun.write(dst, content); // creates the parent dir itself (createPath defaults on)
      // chmod after, never `Bun.write(..., { mode })`: open(2)'s mode is umask-masked, chmod is not,
      // and the resource promises an exact mode.
      if (wantMode !== undefined) await chmod(dst, wantMode);
      report.ok(`${disp} rendered`);
      return;
    }
    case "verify": {
      const content = await render(true);
      if (content === undefined) return; // render already reported the failure
      if (!(await pathExists(dst))) {
        report.warn(`${disp} template not rendered`);
        return;
      }
      if ((await Bun.file(dst).text()) !== content) {
        report.warn(`${disp} template stale`);
        return;
      }
      // Content current — check the declared mode too, so verify can see the drift sync repairs.
      if (wantMode !== undefined) {
        const perms = (await stat(dst)).mode & 0o777;
        if (perms !== wantMode) {
          report.warn(`${disp} mode ${perms.toString(8)}, expected ${wantMode.toString(8)}`);
          return;
        }
      }
      report.skip(`${disp} (template current)`);
      return;
    }
    case "uninstall": {
      if (!(await pathExists(dst))) return;
      // Only remove a file we still own — one that still matches what boom would render.
      // A render failure (or a hand-edited dst) leaves it in place rather than deleting foreign
      // content, the same care `copy`'s uninstall takes.
      const content = await render(false);
      if (content === undefined || (await Bun.file(dst).text()) !== content) return;
      if (ctx.dryRun) report.note(`would remove ${disp}`);
      else {
        await journalRemove("tmpl-rm", dst, ctx);
        report.ok(`${disp} removed`);
      }
      return;
    }
  }
}
