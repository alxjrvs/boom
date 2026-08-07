// Composition: turn `[modules…, base, overlays…]` into ONE ordered section list plus the
// merged `[vars]` / `[boom]` tables. Before this seam existed, reconcile concatenated the three
// sources inline and kept only their `[[section]]` arrays — so a module could not ship the files
// its own sections referenced (repo-relative `src` resolved against the *base* repo) and an
// overlay's `[vars]`/`[boom]` were silently dropped on the floor.
//
// LAYERING INVARIANT: this module may import from `src/lib/**` and `src/config/**` only —
// never from `src/engine/**`. The single `Env` import below is the one exception, and it is
// the same one every sibling in this directory takes today (load.ts, modules.ts, profile.ts,
// remote.ts); it moves to `src/lib/paths.ts` when that module exists.
import { join } from "node:path";
import type { Env } from "../engine/state.ts";
import { BoomConfigError, CONFIG_FILE, loadOverlayFile } from "./load.ts";
import { resolveModules } from "./modules.ts";
import { overlayFiles, type ProfileContext } from "./profile.ts";
import type { Boomfile, BoomSettings, Section } from "./schema.ts";

// A section plus where it came from. `origin` is the ABSOLUTE directory this section's
// repo-relative paths (`src`, `file`, `hooks/<name>.ts`, …) resolve against — the base repo for
// the repo's own and overlay sections, the module's own directory for a module's. `source` is the
// human label used when reporting who declared what.
//
// Deliberately NOT part of `SectionSchema`: that is a `v.strictObject`, so an `origin` key there
// would let a boomfile forge its own provenance. These are compose-time derived facts, not input.
export interface ComposedSection extends Section {
  readonly origin?: string;
  readonly source?: string;
}

export interface Composition {
  readonly sections: ComposedSection[];
  readonly vars: Record<string, string>;
  readonly boom?: BoomSettings;
}

// Compose in precedence order: modules (weakest) → the base boomfile → each overlay file that
// matches this machine (strongest). `notify.warn` is structurally satisfied by `Reporter`, so
// reconcile passes its reporter straight through and tests pass a two-line stub.
export async function composeConfig(
  env: Env,
  repo: string,
  config: Boomfile,
  pc: ProfileContext,
  notify: { warn(msg: string): void },
): Promise<Composition> {
  // A module that won't resolve (offline, typo, invalid) is warned and skipped — one bad module
  // never sinks the reconcile. The wording is load-bearing: it is what `boom module` users see.
  const modules = config.use
    ? await resolveModules(env, repo, config.use, (ref, why) =>
        notify.warn(`module ${ref}: ${why} — skipped`),
      )
    : { sections: [], vars: {} };

  const sections: ComposedSection[] = [
    ...modules.sections,
    ...config.section.map((s) => ({ ...s, origin: repo, source: CONFIG_FILE })),
  ];
  let vars: Record<string, string> = { ...modules.vars, ...(config.vars ?? {}) };
  let boom = config.boom;

  for (const name of overlayFiles(pc)) {
    // loadOverlayFile, not loadConfigFile: an overlay is the one file allowed to omit
    // `[[section]]` (OverlaySchema). The base above went through the strict loader.
    const overlay = await loadOverlayFile(join(repo, name));
    if (!overlay) continue;
    // `use` is the one top-level key whose meaning is POSITIONAL: modules compose *before* the
    // base repo's own sections. An overlay loads LAST, so honoring a `use` here would silently
    // hand a per-host module higher precedence than the repo's own sections — the exact inversion
    // the ordering exists to prevent. Reject it loudly rather than merge it or drop it silently
    // (dropping is what happened before this seam, and it looked like it worked).
    if (overlay.use && overlay.use.length > 0) {
      throw new BoomConfigError(
        `${name}: \`use\` is not allowed in an overlay — modules compose before the base repo's own sections, so an overlay cannot declare one without inverting that order; move it to ${CONFIG_FILE}`,
      );
    }
    sections.push(...overlay.section.map((s) => ({ ...s, origin: repo, source: name })));
    vars = { ...vars, ...(overlay.vars ?? {}) };
    // `[boom]` is a flat table, so it merges shallowly, last-wins PER KEY. The gotcha:
    // `schedule` is an array, and a shallow merge REPLACES an array rather than appending — an
    // overlay that declares any schedule owns the whole timer list for that machine.
    if (overlay.boom) boom = { ...boom, ...overlay.boom };
  }

  return { sections, vars, boom };
}
