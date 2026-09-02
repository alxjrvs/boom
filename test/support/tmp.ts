// Every throwaway directory the suites create, and the one sweep that removes them. Loaded as a
// `bun test` preload (bunfig.toml): a lifecycle hook registered from a preload spans the whole
// run, whereas one registered from a plainly imported module binds only to the first file that
// imports it — modules are evaluated once per process — and every later file leaks.
import { afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

// A fresh directory under the OS tmpdir, removed when the run ends. `prefix` labels it so a
// leftover from a crashed run still says which suite made it.
export async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `boom-${prefix}-`));
  made.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
