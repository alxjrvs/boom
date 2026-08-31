// The mutating-run lock (lib/lock.ts): one holder at a time, a stale lock from a crashed
// run is reclaimed, and a live holder is a clean LockHeldError.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LockHeldError, withLock } from "../src/lib/lock.ts";
import { boomStateDir } from "../src/lib/paths.ts";

async function stateEnv(): Promise<Record<string, string>> {
  const env = { XDG_STATE_HOME: await mkdtemp(join(tmpdir(), "boom-lock-")) };
  await mkdir(boomStateDir(env), { recursive: true });
  return env;
}

test("a second acquire fails while the first holder is live, and succeeds after release", async () => {
  const env = await stateEnv();
  const release = acquireLock(env);
  expect(() => acquireLock(env)).toThrow(LockHeldError);
  release();
  acquireLock(env)(); // free now → acquires and releases
});

test("release is idempotent (double-release is a no-op, and re-acquire still works)", async () => {
  const env = await stateEnv();
  const release = acquireLock(env);
  release();
  release(); // no throw
  acquireLock(env)();
});

test("a stale lock from a dead pid is reclaimed", async () => {
  const env = await stateEnv();
  // A lock file naming a pid that can't be alive (a huge pid never is on a fresh test box)
  // — acquire must treat it as crashed and reclaim it rather than block forever.
  await writeFile(join(boomStateDir(env), "lock"), "2147483646");
  acquireLock(env)(); // reclaimed, not blocked
});

test("a truncated/empty lock file (crash mid-write) is reclaimed", async () => {
  const env = await stateEnv();
  await writeFile(join(boomStateDir(env), "lock"), ""); // no pid → unreadable owner
  acquireLock(env)();
});

test("withLock releases the lock on success and on throw", async () => {
  // The shared spelling every mutating entry point now routes through. A body that throws must
  // still release, or one failed `source set` wedges every later run behind a stale lock.
  const env = await stateEnv();
  await withLock(env, () => Promise.resolve(1));
  acquireLock(env)(); // free after a clean body

  await expect(withLock(env, () => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
  acquireLock(env)(); // free after a throwing one
});
