// The owned-destinations manifest: which files boom put where, so a destination dropped
// from the config can be reaped. Backed by the `manifest` table in state.db.
// The *layout* of the state dir (and the `Env` alias) lives in `lib/paths.ts` — this file is
// the reader, not the map.
import type { Env } from "../lib/paths.ts";
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
  return rows.map(toEntry);
}

// Collapse duplicate destinations last-wins: the entry that appears later in `entries` wins.
// Shared by reconcile's partial-run merge and the manifest write below.
export function byDst(entries: readonly ManifestEntry[]): ManifestEntry[] {
  const m = new Map<string, ManifestEntry>();
  for (const e of entries) m.set(e.dst, e);
  return [...m.values()];
}

export async function writeManifest(env: Env, entries: readonly ManifestEntry[]): Promise<void> {
  // Collapse duplicate destinations BEFORE the insert. `manifest.dst` is a PRIMARY KEY (db.ts),
  // so a repeated dst would throw a raw SQLiteError out of the reconcile: the replace transaction
  // rolls back to the STALE prior set, the run never commits, and the next run reaps against
  // ownership that no longer describes the machine. Compose-time last-wins (config/compose.ts)
  // is the real fix; this is the floor for the duplicate compose cannot see — two glob entries
  // expanding onto one concrete dst at run time.
  withDb(env, (db) => {
    const replace = db.transaction((es: readonly ManifestEntry[]) => {
      db.run("DELETE FROM manifest");
      const ins = db.query("INSERT INTO manifest (dst, kind, src) VALUES (?, ?, ?)");
      for (const e of es) ins.run(e.dst, e.kind, e.src);
    });
    replace(byDst(entries));
  });
}
