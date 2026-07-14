// A cross-process lock for mutating reconcile runs. Two concurrent `boom source` (sync)
// runs would race on the same filesystem destinations and, worse, clobber each other's
// manifest (writeManifest is a full DELETE+reinsert) — the slower run silently drops the
// other's ownership records, so those links later look orphaned and get reaped. This is
// especially reachable when a scheduled/launchd sync overlaps a manual one. A plain
// lockfile is enough, but it must be created *already populated*: a naive
// `open(O_EXCL)`-then-`write(pid)` leaves a window where a second run reads an empty file,
// mistakes it for a crashed run, and steals the lock. So we write the pid to a private temp
// file and `link(2)` it into place — link is atomic and fails if the lock exists, and the
// lock springs into existence already carrying the pid.
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boomStateDir, type Env } from "../engine/state.ts";

// A live run holds the lock (as opposed to an unexpected fs error) — reconcile reports this
// as a clean failure rather than a crash.
export class LockHeldError extends Error {}

function lockPath(env: Env): string {
  return join(boomStateDir(env), "lock");
}

// Whether a process with `pid` is alive. `kill(pid, 0)` sends no signal — it only probes:
// it throws ESRCH when the process is gone, EPERM when it exists but we may not signal it
// (still alive → still holding the lock).
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(path: string): number {
  try {
    return Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  } catch {
    return Number.NaN;
  }
}

// Acquire the mutating-run lock, returning an idempotent release fn. Throws LockHeldError
// if another live run holds it; a stale lock left by a crashed run (dead pid, or an
// unreadable file) is reclaimed. The reclaim path has a narrow residual race if two runs
// start in the same instant *after* a third crashed — it degrades to the pre-lock behavior
// (both proceed), which is acceptable for that post-crash corner; the common
// launchd-overlaps-manual case (no stale lock) is fully serialized.
export function acquireLock(env: Env): () => void {
  const dir = boomStateDir(env);
  mkdirSync(dir, { recursive: true });
  const path = lockPath(env);
  const tmp = join(dir, `lock.${process.pid}.tmp`);

  // Create the lock atomically AND already-populated (see file header): pid → temp, then
  // link temp → lock. Returns true on acquire, false if the lock already exists.
  const tryCreate = (): boolean => {
    writeFileSync(tmp, String(process.pid));
    try {
      linkSync(tmp, path);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // temp already gone — nothing to clean up
      }
    }
  };

  if (!tryCreate()) {
    const owner = readPid(path);
    if (Number.isFinite(owner) && pidAlive(owner)) {
      throw new LockHeldError(
        `another boom run is in progress (pid ${owner}) — wait for it to finish, or remove ${path} if it crashed`,
      );
    }
    // Stale (dead or unreadable pid): drop it and retry once. If a live racer took it in
    // between, the link fails again → treat as held rather than fight over it.
    try {
      unlinkSync(path);
    } catch {
      // already gone — fall through to the retry
    }
    if (!tryCreate()) {
      throw new LockHeldError(`another boom run just took the lock — retry in a moment (${path})`);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(path);
    } catch {
      // Best-effort: a missing lock file is already the released state.
    }
  };
}
