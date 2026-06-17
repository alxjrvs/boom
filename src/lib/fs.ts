// Filesystem helpers for the reconcile engine. node:fs/promises (not Bun.write) for
// all metadata/link ops — Bun.write cannot create symlinks or set modes.
import { chmod, copyFile, lstat, mkdir, readlink, rm, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

type Env = Record<string, string | undefined>;

export function expandTilde(p: string, env: Env): string {
  const home = env.HOME ?? "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

export function displayPath(p: string, env: Env): string {
  const home = env.HOME;
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

// Symlink target if `path` is a symlink, else undefined (no throw).
export async function linkTarget(path: string): Promise<string | undefined> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return undefined;
    return await readlink(path);
  } catch {
    return undefined;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureSymlink(src: string, dst: string): Promise<void> {
  await mkdir(dirname(dst), { recursive: true });
  await symlink(src, dst);
}

// Byte-equal compare of two files (for `copy` verify); false if either is unreadable.
export async function filesEqual(a: string, b: string): Promise<boolean> {
  try {
    const [fa, fb] = [Bun.file(a), Bun.file(b)];
    if ((await fa.exists()) === false || (await fb.exists()) === false) return false;
    return Buffer.from(await fa.arrayBuffer()).equals(Buffer.from(await fb.arrayBuffer()));
  } catch {
    return false;
  }
}

export { chmod, copyFile, lstat, mkdir, rm, stat };
