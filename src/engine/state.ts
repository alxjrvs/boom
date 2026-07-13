// boom's on-disk state under ${XDG_STATE_HOME:-~/.local/state}/boom/:
//   state.db          bun:sqlite store — the owned-destinations manifest + the per-run
//                     transaction journal (see db.ts / journal.ts)
//   backups/<id>/...  files displaced by an overwrite (so rollback can restore)
// The manifest was a hand-parsed TSV file before; it now lives in state.db, with a one-time
// import of any legacy TSV so orphan reaping doesn't reset across the upgrade.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { withDb } from "./db.ts";

export type Env = Record<string, string | undefined>;

// One owned destination. `kind` + `src` let reaping recognize copies (regular files,
// which carry no symlink target to point back at the repo) — not just links — so a
// copy dropped from the config can be reaped when it still byte-matches its source.
export interface ManifestEntry {
  readonly kind: "link" | "copy";
  readonly dst: string;
  readonly src: string;
}

export function stateHome(env: Env): string {
  return env.XDG_STATE_HOME ?? join(env.HOME ?? "", ".local", "state");
}
export function boomStateDir(env: Env): string {
  return join(stateHome(env), "boom");
}
// The pre-sqlite manifest path — retained only to import a legacy TSV once (see below).
export function manifestPath(env: Env): string {
  return join(boomStateDir(env), "manifest");
}
export function backupsDir(env: Env): string {
  return join(boomStateDir(env), "backups");
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
  withDb(env, (db) => {
    const replace = db.transaction((es: readonly ManifestEntry[]) => {
      db.run("DELETE FROM manifest");
      const ins = db.query("INSERT INTO manifest (dst, kind, src) VALUES (?, ?, ?)");
      for (const e of es) ins.run(e.dst, e.kind, e.src);
    });
    replace(entries);
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
    if (parts.length >= 3)
      out.push({
        kind: parts[0] === "copy" ? "copy" : "link",
        dst: parts[1] as string,
        src: parts[2] as string,
      });
    else out.push({ kind: "link", dst: parts[0] as string, src: "" });
  }
  return out;
}
