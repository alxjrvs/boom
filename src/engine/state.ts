// botu's on-disk state under ${XDG_STATE_HOME:-~/.local/state}/botu/:
//   manifest          TSV of destinations botu owns (orphan reaping)
//   journal/<id>.ndjson  per-run transaction log (apply/fix)
//   backups/<id>/...  files displaced by an overwrite (so rollback can restore)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
export function botuStateDir(env: Env): string {
  return join(stateHome(env), "botu");
}
export function manifestPath(env: Env): string {
  return join(botuStateDir(env), "manifest");
}
export function journalDir(env: Env): string {
  return join(botuStateDir(env), "journal");
}
export function backupsDir(env: Env): string {
  return join(botuStateDir(env), "backups");
}

export async function readManifest(env: Env): Promise<ManifestEntry[]> {
  let text: string;
  try {
    text = await readFile(manifestPath(env), "utf8");
  } catch {
    return [];
  }
  const out: ManifestEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    // TSV `kind\tdst\tsrc`. A tab-less line is the pre-TSV format (bare dst) — read it
    // as a link so older manifests keep reaping correctly across an upgrade.
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

export async function writeManifest(env: Env, entries: readonly ManifestEntry[]): Promise<void> {
  await mkdir(botuStateDir(env), { recursive: true });
  const body = entries.map((e) => `${e.kind}\t${e.dst}\t${e.src}`).join("\n");
  await writeFile(manifestPath(env), body.length > 0 ? `${body}\n` : "");
}
