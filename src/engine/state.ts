// botu's on-disk state under ${XDG_STATE_HOME:-~/.local/state}/botu/:
//   manifest          newline list of destinations botu owns (orphan reaping)
//   journal/<id>.ndjson  per-run transaction log (apply/fix)
//   backups/<id>/...  files displaced by an overwrite (so rollback can restore)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

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

export async function readManifest(env: Env): Promise<string[]> {
  try {
    return (await readFile(manifestPath(env), "utf8")).split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

export async function writeManifest(env: Env, dsts: readonly string[]): Promise<void> {
  await mkdir(botuStateDir(env), { recursive: true });
  await writeFile(manifestPath(env), dsts.length > 0 ? `${dsts.join("\n")}\n` : "");
}
