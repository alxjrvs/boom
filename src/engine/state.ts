// The owned-destinations manifest: which files boom put where, so a destination dropped
// from the config can be reaped. Backed by the `manifest` table in state.db, with a one-time
// import of the pre-sqlite TSV so orphan reaping doesn't reset across that upgrade.
// The *layout* of the state dir (and the `Env` alias) lives in `lib/paths.ts` — this file is
// the reader, not the map.
import { readFile, rm } from "node:fs/promises";
import type { Env } from "../lib/paths.ts";
import { manifestPath } from "../lib/paths.ts";
import { withDb } from "./db.ts";

// One owned destination. `kind` + `src` let reaping recognize copies (regular files,
// which carry no symlink target to point back at the repo) — not just links — so a
// copy dropped from the config can be reaped when it still byte-matches its source.
export interface ManifestEntry {
  readonly kind: "link" | "copy";
  readonly dst: string;
  readonly src: string;
}

interface ManifestRow {
  kind: string;
  dst: string;
  src: string;
}
const toEntry = (r: ManifestRow): ManifestEntry => ({
  kind: r.kind === "copy" ? "copy" : "link",
  dst: r.dst,
  src: r.src,
});

export async function readManifest(env: Env): Promise<ManifestEntry[]> {
  const rows = withDb(env, (db) => db.query("SELECT kind, dst, src FROM manifest").all() as ManifestRow[]);
  if (rows.length > 0) return rows.map(toEntry);
  // Empty DB manifest → import a legacy TSV once (pre-sqlite state), so an upgrade doesn't
  // forget what boom owns and then fail to reap a since-dropped link. Consumed, then removed.
  const legacy = await readLegacyManifest(env);
  if (legacy.length > 0) {
    await writeManifest(env, legacy);
    await rm(manifestPath(env), { force: true });
  }
  return legacy;
}

// Drop specific destinations from the manifest, leaving the rest intact. Used by
// `boom rollback`: reversing a run un-owns exactly the destinations it created (or restored
// to a foreign file), so the manifest must forget them — otherwise the next verify reports
// phantom drift and the next sync's reap logic acts on ownership that no longer holds.
// dsts that aren't in the manifest (a reaped orphan, a `mkdir` dir) delete as no-ops.
export async function removeManifestEntries(env: Env, dsts: readonly string[]): Promise<void> {
  if (dsts.length === 0) return;
  withDb(env, (db) => {
    const del = db.transaction((ds: readonly string[]) => {
      const stmt = db.query("DELETE FROM manifest WHERE dst = ?");
      for (const d of ds) stmt.run(d);
    });
    del(dsts);
  });
}

export async function writeManifest(env: Env, entries: readonly ManifestEntry[]): Promise<void> {
  // Collapse duplicate destinations last-wins BEFORE the insert. `manifest.dst` is a PRIMARY KEY
  // (db.ts), so a repeated dst threw a raw SQLiteError out of the reconcile: the replace
  // transaction rolled back to the STALE prior set and the run never committed, and the next run
  // then reaped against ownership that no longer described the machine. Compose-time last-wins
  // (config/compose.ts) is the real fix; this is the floor for the duplicate compose cannot see —
  // two glob entries expanding onto one concrete dst at run time. Same Map-keyed-on-dst idiom as
  // reconcile's mergeManifest, kept local because state.ts must not import from reconcile.ts.
  const byDst = new Map<string, ManifestEntry>();
  for (const e of entries) byDst.set(e.dst, e);
  withDb(env, (db) => {
    const replace = db.transaction((es: readonly ManifestEntry[]) => {
      db.run("DELETE FROM manifest");
      const ins = db.query("INSERT INTO manifest (dst, kind, src) VALUES (?, ?, ?)");
      for (const e of es) ins.run(e.dst, e.kind, e.src);
    });
    replace([...byDst.values()]);
  });
}

// Parse the pre-sqlite TSV manifest (`kind\tdst\tsrc`, with a tab-less pre-TSV bare-dst
// fallback), or [] if none exists. Only reached during the one-time import above.
async function readLegacyManifest(env: Env): Promise<ManifestEntry[]> {
  let text: string;
  try {
    text = await readFile(manifestPath(env), "utf8");
  } catch {
    return [];
  }
  const out: ManifestEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split("\t");
    // A short row is skipped, not turned into an entry with an empty `src`. The bare-dst format
    // that fallback existed for was only ever written under the OLD name, at
    // ~/.local/state/botu/manifest: three-column TSV landed in cc29b05, before 7677c8e (v0.4.0)
    // moved the state dir botu → boom. `manifestPath` reads the boom path, so every row it can
    // ever see is TSV, and the only way to reach the old branch now is a truncated line — where
    // fabricating `src: ""` was actively harmful, because reconcile's reap then fell back to
    // matching any link under the repo and could reap a destination this row never named.
    if (parts.length < 3) continue;
    out.push({
      kind: parts[0] === "copy" ? "copy" : "link",
      dst: parts[1] as string,
      src: parts[2] as string,
    });
  }
  return out;
}
