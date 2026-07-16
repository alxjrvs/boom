// The `tmpl` resource: render one repo-relative template to a destination, substituting the
// boomfile's top-level `[vars]` table into `${NAME}` placeholders. It is the first-class,
// strict-superset form of `copy` + `expand` — a template also understands the exact
// `${env:VAR}`/`${host}`/`${os}` vocabulary `expand` renders (via the shared `renderTemplate`
// helper), so switching an `expand`ed copy to a `tmpl` only adds the `[vars]`-backed
// placeholders on top. One template + per-profile vars replaces N near-identical
// machine-specific overlay files.
//
// It shares `copy`'s journal discipline (declared as a managed `copy`, displace-before-write,
// change-gated skip) with two deliberate departures:
//   • an unknown `${NAME}` is a hard failure, not a silent passthrough — a config that ships
//     with an unresolved placeholder is worse than one that loudly refuses to render;
//   • a literal shell `${FOO:-bar}` (anything that isn't a bare identifier) is left verbatim,
//     exactly as `expand` leaves an unmatched `${…}`, so real shell config survives.
import { dirname, join } from "node:path";
import type { Tmpl } from "../../config/schema.ts";
import { chmod, displayPath, expandTilde, mkdir, pathExists, rm } from "../../lib/fs.ts";
import { displace, type UndoToken } from "../journal.ts";
import type { ReconcileCtx } from "../types.ts";
import { renderTemplate } from "./filesystem.ts";

// A bare `${identifier}` placeholder — the `[vars]` reference form. Deliberately narrow: an
// expression with any other character (`${env:X}`, `${FOO:-bar}`) is not matched here, so
// `${env:…}`/`${host}`/`${os}` are left for renderTemplate and shell literals pass through
// untouched, matching `expand`'s "leave the unmatched verbatim" behavior.
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Render `text`: first the `expand` vocabulary (`${env:VAR}`/`${host}`/`${os}`), then the
// `[vars]` placeholders. Any `${NAME}` with no matching var is collected into `missing` and
// left in place — the caller turns a non-empty `missing` into a reported failure.
function renderTmpl(text: string, ctx: ReconcileCtx, missing: Set<string>): string {
  return renderTemplate(text, ctx).replace(VAR, (whole, name: string) => {
    if (name in ctx.vars) return ctx.vars[name] as string;
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
      // backup of an unchanged file), mirroring copy/secret.
      if ((await pathExists(dst)) && (await Bun.file(dst).text()) === content) {
        report.skip(`${disp} already up to date`);
        return;
      }
      if (ctx.dryRun) {
        report.plan(`${disp} would be rendered`);
        return;
      }
      await ctx.journal?.intent("copy", dst);
      // Record the undo before the write (same rationale as copy): a displaced original is in
      // the backup tree with a `done` row that restores it; a fresh write's undo is a remove.
      const undo: UndoToken = (await pathExists(dst))
        ? await displace(dst, ctx.backupRoot, true)
        : { kind: "remove" };
      await ctx.journal?.done("copy", dst, undo);
      await mkdir(dirname(dst), { recursive: true });
      await Bun.write(dst, content);
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
      if ((await Bun.file(dst).text()) === content) report.skip(`${disp} (template current)`);
      else report.warn(`${disp} template stale`);
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
        await rm(dst, { force: true });
        report.ok(`${disp} removed`);
      }
      return;
    }
  }
}
