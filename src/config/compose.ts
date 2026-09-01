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
import { basename, join } from "node:path";
import { displayPath, expandTilde, isGlobPattern } from "../lib/fs.ts";
import { launchAgentsDir } from "../lib/launchd.ts";
import type { Env } from "../lib/paths.ts";
import { CONFIG_FILE, loadOverlayFile } from "./load.ts";
import { overlayFiles, type ProfileContext, sectionApplies } from "./profile.ts";
import type { Boomfile, BoomSettings, Section } from "./schema.ts";

// A section plus which FILE declared it — the human label used by the duplicate-destination
// note below.
//
// There used to be an `origin` directory here too, so a MODULE could ship the files its own
// sections declared: `reconcileSection` swapped `ctx.repo` for it before running any resource.
// The module system was deleted in 0.30.0 and nothing has set `origin` to anything but the base
// repo since, so that branch could never be taken — along with the GOTCHA comment beside it
// warning that the swap narrowed the repo-self-link guard for a case that can no longer occur.
// Both are gone.
//
// Deliberately NOT part of `SectionSchema`: that is a `v.strictObject`, so a `source` key there
// would let a boomfile forge its own provenance. This is a compose-time derived fact, not input.
export interface ComposedSection extends Section {
  readonly source?: string;
}

export interface Composition {
  readonly sections: ComposedSection[];
  readonly vars: Record<string, string>;
  readonly boom?: BoomSettings;
}

// The reporting port composition needs. `Reporter` satisfies it structurally, so reconcile
// passes its reporter straight through and tests pass a small object literal.
export interface ComposeNotifier {
  warn(msg: string): void;
  note(msg: string): void;
}

// Compose in precedence order: modules (weakest) → the base boomfile → each overlay file that
// matches this machine (strongest). `notify` is structurally satisfied by `Reporter`, so
// reconcile passes its reporter straight through and tests pass a two-line stub.
export async function composeConfig(
  env: Env,
  repo: string,
  config: Boomfile,
  pc: ProfileContext,
  notify: ComposeNotifier,
): Promise<Composition> {
  const sections: ComposedSection[] = config.section.map((s) => ({
    ...s,
    source: CONFIG_FILE,
  }));
  let vars: Record<string, string> = { ...(config.vars ?? {}) };
  let boom = config.boom;

  for (const name of overlayFiles(pc)) {
    // loadOverlayFile, not loadConfigFile: an overlay is the one file allowed to omit
    // `[[section]]` (OverlaySchema). The base above went through the strict loader.
    const overlay = await loadOverlayFile(join(repo, name));
    if (!overlay) continue;
    sections.push(...overlay.section.map((s) => ({ ...s, source: name })));
    vars = { ...vars, ...(overlay.vars ?? {}) };
    // `[boom]` is a flat table, so it merges shallowly, last-wins PER KEY. The gotcha:
    // `schedule` is an array, and a shallow merge REPLACES an array rather than appending — an
    // overlay that declares any schedule owns the whole timer list for that machine.
    if (overlay.boom) boom = { ...boom, ...overlay.boom };
  }

  return { sections: resolveDuplicates(sections, pc, env, notify), vars, boom };
}

// The kinds whose `dst` is a real file destination, and so can fight over one path at run time.
// `dir` is deliberately absent: it keys on `path`, never declares ownership, and a duplicate
// `mkdir -p` is idempotent.
const KEYED_FIELDS = ["link", "copy", "tmpl", "launchd"] as const;
type KeyedField = (typeof KEYED_FIELDS)[number];

// Whether this kind takes OWNERSHIP of its destination — i.e. pushes it to `ctx.declared`, which
// is what the owned-destinations manifest is rebuilt from. `launchd` is now the only kind that
// can fail to: it returns before its push when the machine isn't darwin. `pc.os` is the same
// `detectOs(env)` the resource itself calls (BOOM_OS override included), so the two cannot
// disagree about which run that is.
//
// STILL A PREDICATE, not an inlined `field !== "launchd"`, and one kind is enough to need it: a
// darwin `launchd` DOES own its destination, so the answer depends on the run and not only on
// the kind. `secret` was the second case until 0.37 — it never declared, so that reaping could
// not auto-delete a rendered secret — and its removal narrows this without simplifying it away.
//
// This partitions the dedupe keyspace below, and it is load-bearing rather than tidy: a winner
// that declares nothing would evict a loser that declares, leaving the destination owned by
// nobody on a run whose prior manifest still lists it — and `reapOrphans` DELETES exactly that.
function declaresOwnership(field: KeyedField, pc: ProfileContext): boolean {
  return field !== "launchd" || pc.os === "darwin";
}

// The two fields precedence reads off an entry. Every keyed kind is structurally one of these:
// `launchd`'s `dst` is optional, the rest carry both.
interface Keyable {
  readonly src?: string;
  readonly dst?: string;
}

interface Occurrence {
  readonly key: string; // the dedupe identity — `dst`, partitioned by kind for non-owning kinds
  readonly dst: string; // the destination itself, for the override note
  readonly section: ComposedSection;
  readonly field: KeyedField;
  readonly index: number;
}

// Where this entry will actually land, or undefined when it cannot be keyed. It is the
// **expanded** dst because that is what the manifest stores (`db.ts`'s PRIMARY KEY is the
// expanded path) and what every file resource computes at run time — keying on the raw spelling
// would miss `~/.zshrc` against its absolute twin.
function destinationOf(field: KeyedField, entry: Keyable, env: Env): string | undefined {
  // A glob `src` makes `dst` a directory the matches land *under*, so two globs sharing it are
  // not a conflict. Compose cannot expand a glob (that needs the repo on disk under the section's
  // own origin), so these stay unkeyed and `writeManifest`'s collapse is the second line.
  if (entry.src !== undefined && isGlobPattern(entry.src)) return undefined;
  if (entry.dst !== undefined) return expandTilde(entry.dst, env);
  // launchd is the one kind whose `dst` is optional; it defaults to the LaunchAgents dir. This
  // replicates `resources/launchd.ts`'s derivation rather than sharing a helper, which would drag
  // `lib/launchd.ts`'s launchctl surface into `config/` — keep the two spellings in sync. HOME
  // unset leaves it unkeyed, exactly as the resource itself skips the entry.
  if (field !== "launchd" || entry.src === undefined) return undefined;
  const agents = launchAgentsDir(env);
  return agents ? join(agents, basename(entry.src)) : undefined;
}

// Last-wins across `[modules…, base, overlays…]`: when two declarations target one destination,
// only the last one runs. Before this, `link` was first-wins (the second placement found a
// foreign file at `dst` and skipped it — a verify failure no `boom source` could ever converge)
// while `copy`/`tmpl` were last-wins by accident of both running, and the duplicate `dst` threw a
// raw SQLiteError out of the manifest write.
//
// GOTCHA, and the reason `pc` is a parameter twice over: a winner that does not actually own the
// destination this run must never evict a loser that does, or the file ends up declared by nobody
// while the prior manifest still lists it — and `reapOrphans` DELETES exactly that. Two ways an
// entry fails to own what it wins, and each needs `pc`:
//   • it is gated out. `when`/profile gating runs LATER, in reconcile's section loop, so only
//     sections that apply to this run take part here; gated-out sections pass through untouched.
//   • its KIND never declares ownership — see `declaresOwnership`, which partitions the keyspace.
function resolveDuplicates(
  sections: ComposedSection[],
  pc: ProfileContext,
  env: Env,
  notify: ComposeNotifier,
): ComposedSection[] {
  const occurrences: Occurrence[] = [];
  for (const section of sections) {
    if (!sectionApplies(section, pc)) continue;
    // Fields are walked in KEYED_FIELDS order, so a section that collides with *itself* across
    // two kinds resolves by that order rather than TOML order — deterministic, and vanishingly
    // rare next to the cross-layer case this exists for.
    for (const field of KEYED_FIELDS) {
      const entries = (section[field] ?? []) as readonly Keyable[];
      for (const [index, entry] of entries.entries()) {
        const dst = destinationOf(field, entry, env);
        if (dst === undefined) continue;
        // Kinds that take ownership share ONE keyspace (a module `link` and a base `copy` at one
        // path are a single conflict). A kind that does not gets its own, so it can still beat a
        // duplicate of itself — launchd-vs-launchd off darwin, the real duplicate case —
        // without ever evicting the declaration that keeps the file out of the orphan sweep.
        // NUL is the separator because it is the one byte a path cannot contain, so a partitioned
        // key can never alias a shared one however a `dst` is spelled.
        const key = declaresOwnership(field, pc) ? dst : `${field}\u0000${dst}`;
        occurrences.push({ key, dst, section, field, index });
      }
    }
  }

  const winners = new Map<string, Occurrence>();
  for (const o of occurrences) winners.set(o.key, o); // forward walk → the last write wins

  const losers = new Map<ComposedSection, Map<KeyedField, Set<number>>>();
  for (const o of occurrences) {
    const win = winners.get(o.key);
    if (!win || win === o) continue;
    const byField = losers.get(o.section) ?? new Map<KeyedField, Set<number>>();
    losers.set(o.section, byField);
    const idxs = byField.get(o.field) ?? new Set<number>();
    byField.set(o.field, idxs);
    idxs.add(o.index);
    notify.note(
      `${displayPath(o.dst, env)} — ${o.field} from ${o.section.source ?? CONFIG_FILE} overridden by ${win.field} in ${win.section.source ?? CONFIG_FILE}`,
    );
  }
  if (losers.size === 0) return sections;

  // A section whose arrays all empty out is KEPT: its `name` still anchors `--only` and its
  // `when` gate, and dropping it would make a scoped run silently match nothing.
  return sections.map((section) => {
    const byField = losers.get(section);
    if (!byField) return section;
    const next: ComposedSection = { ...section };
    for (const [field, idxs] of byField) {
      const kept = (section[field] ?? []).filter((_, i) => !idxs.has(i));
      // One narrow write per field rather than five identical typed branches; the element type
      // differs per field but the filter only ever removes members of the original array.
      (next as Record<KeyedField, unknown>)[field] = kept;
    }
    return next;
  });
}
