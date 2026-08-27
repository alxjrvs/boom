// Filesystem helpers for the reconcile engine. node:fs/promises (not Bun.write) for
// all metadata/link ops — Bun.write cannot create symlinks or set modes.
import { chmod, copyFile, cp, lstat, mkdir, readlink, rename, rm, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Env } from "./paths.ts";

// Move `src` → `dst`, surviving a cross-filesystem boundary. `rename(2)` is atomic but
// throws EXDEV when the two paths live on different mounts — which the backup tree does
// whenever `$XDG_STATE_HOME` sits on a different device than `$HOME` (tmpfs state, a
// bind-mounted home). Without this, every overwrite-with-backup *and* every rollback
// restore would fail on those layouts. Fall back to a recursive copy + remove (dst can be
// a directory, so this is cp -r, not a file-only Bun.write). Assumes dst's parent exists.
async function moveAcross(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await cp(src, dst, { recursive: true, force: true });
    await rm(src, { recursive: true, force: true });
  }
}

// The glob metacharacters Bun.Glob honors. A plain path contains none, so a single-file entry
// never pays the scan cost or the directory-dst semantics.
export const GLOB_MAGIC = /[*?[\]{}]/;

// Lives here rather than in the filesystem resource because the *composer* needs the same test:
// a glob `src` makes `dst` a DIRECTORY that every match lands under, not a destination — so two
// glob entries sharing a `dst` are not a duplicate and must never be keyed against each other.
export function isGlobPattern(s: string): boolean {
  return GLOB_MAGIC.test(s);
}

export function expandTilde(p: string, env: Env): string {
  const home = env.HOME ?? "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

// Like expandTilde, but also expands $HOME / ${HOME} anywhere in the string.
// osx_default string values (e.g. `screencapture location`) are written verbatim
// by `defaults write` — there is no shell to expand them — so a config value of
// "$HOME/Screenshots" or "~/Screenshots" must be expanded here, or it lands on
// disk literally.
export function expandHome(p: string, env: Env): string {
  const home = env.HOME ?? "";
  if (!home) return p;
  return expandTilde(p, env).replace(/\$\{HOME\}|\$HOME/g, () => home);
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

// Move `dst` into the per-run backup tree (preserving its path) and return the backup
// location, so a later rollback can restore a file that an overwrite displaced.
// `mode: 0o700` is load-bearing, not hygiene: the tree can hold a displaced *secret*, and
// `rename` preserves that file's 0600 while the directories above it would otherwise land at
// 0755 and expose its name and path. The gotcha that makes this one argument sufficient:
// `mode` applies to every directory a `recursive` mkdir creates, and this call is what
// lazily creates `backupsDir(env)` and the run's `<run-id>` root as intermediates — so the
// run root needs no second chmod, and there is deliberately no eager mkdir upstream to own it.
export async function backupTo(dst: string, backupRoot: string): Promise<string> {
  const target = join(backupRoot, dst);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await moveAcross(dst, target);
  return target;
}

// Restore a backed-up file to `dst`, replacing whatever boom currently has there — without
// destroying the current file until the backup is safely in place. The old order (rm dst,
// then move the backup in) lost the current file outright if the move failed (backup
// pruned, EXDEV copy error, EACCES). Instead: move the current file aside, move the backup
// in, and only then drop the aside copy — restoring the aside file if the move fails, so a
// failed rollback leaves `dst` exactly as it was rather than empty.
export async function restoreFrom(from: string, dst: string): Promise<void> {
  await mkdir(dirname(dst), { recursive: true });
  const aside = `${dst}.boom-restore.${process.pid}`;
  const hadCurrent = await pathExists(dst);
  if (hadCurrent) await moveAcross(dst, aside);
  try {
    await moveAcross(from, dst);
  } catch (e) {
    if (hadCurrent) await moveAcross(aside, dst); // put the current file back
    throw e;
  }
  if (hadCurrent) await rm(aside, { recursive: true, force: true });
}

// Byte-equal compare of two files (for `copy` verify); false if either is unreadable.
export async function filesEqual(a: string, b: string): Promise<boolean> {
  try {
    const [fa, fb] = [Bun.file(a), Bun.file(b)];
    if ((await fa.exists()) === false || (await fb.exists()) === false) return false;
    // Size is a cheap stat via Bun.file; a mismatch (the common "it changed" case)
    // settles the answer without reading either file's bytes. Only equal sizes fall
    // through to the full byte compare — the compare is unchanged, just deferred.
    if (fa.size !== fb.size) return false;
    return Buffer.from(await fa.arrayBuffer()).equals(Buffer.from(await fb.arrayBuffer()));
  } catch {
    return false;
  }
}

export { chmod, copyFile, mkdir, rename, rm, stat };
