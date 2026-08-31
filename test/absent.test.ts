// The `absent` resource: a path that must NOT exist.
//
// Drives reconcile() against a sandboxed $HOME, like engine.test.ts, because every assertion
// here is about real filesystem state and an exit code — the two things a unit test of the
// reconcile function would have to fake.
//
// The load-bearing cases are the ones that assert absent DOES something: `removes a file on
// sync`, `verify fails`, and `rollback restores`. A stub that did nothing at all would pass
// the four "leaves it alone" cases, so those are not evidence on their own.
import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reconcile } from "../src/engine/reconcile.ts";
import { pathExists } from "../src/lib/fs.ts";
import { makeSandbox, type Sandbox } from "./support/sandbox.ts";

const sandbox = (boomfile: string): Promise<Sandbox> => makeSandbox(boomfile, { prefix: "boom-absent-" });

const ONE = `[[section]]
name = "Hygiene"
absent = [{ path = "~/.claude/settings.local.json" }]
`;

async function seed(sb: Sandbox, body = '{"permissions":{"allow":["Bash(gh api *)"]}}\n'): Promise<string> {
  const f = join(sb.home, ".claude", "settings.local.json");
  await mkdir(join(sb.home, ".claude"), { recursive: true });
  await writeFile(f, body);
  return f;
}

test("absent: sync removes the file", async () => {
  const sb = await sandbox(ONE);
  const f = await seed(sb);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(f)).toBe(false);
});

test("absent: sync is a no-op when the path is already gone", async () => {
  const sb = await sandbox(ONE);
  expect(await reconcile("sync", sb.ctx, { verbose: true })).toBe(0);
  expect(sb.out()).toContain("absent");
});

test("absent: verify FAILS while the file exists, and passes once it is gone", async () => {
  const sb = await sandbox(ONE);
  await seed(sb);
  // Non-zero: this is the half a `run` step bound to `on = "sync"` cannot provide, since a
  // file written between syncs would otherwise wait for the next one.
  expect(await reconcile("verify", sb.ctx, {})).not.toBe(0);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
});

test("absent: verify reports the message when one is given", async () => {
  const sb = await sandbox(`[[section]]
name = "Hygiene"
absent = [{ path = "~/.claude/settings.local.json", message = "machine-local override is not a pattern here" }]
`);
  await seed(sb);
  expect(await reconcile("verify", sb.ctx, {})).not.toBe(0);
  expect(sb.out()).toContain("machine-local override is not a pattern here");
});

test("absent: --dry-run reports and removes nothing", async () => {
  const sb = await sandbox(ONE);
  const f = await seed(sb);
  expect(await reconcile("sync", sb.ctx, { dryRun: true })).toBe(0);
  expect(sb.out()).toContain("would be removed");
  expect(await pathExists(f)).toBe(true);
});

test("absent: uninstall leaves the file alone", async () => {
  const sb = await sandbox(ONE);
  const f = await seed(sb);
  // boom did not create this file and does not own it — teardown must not take a parting shot.
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(f)).toBe(true);
});

test("absent: a directory is REFUSED without recursive", async () => {
  const sb = await sandbox(`[[section]]
name = "Hygiene"
absent = [{ path = "~/junk" }]
`);
  await mkdir(join(sb.home, "junk", "nested"), { recursive: true });
  await writeFile(join(sb.home, "junk", "nested", "keep.txt"), "important\n");
  // One typo in a path must not be a silent recursive delete on the next sync.
  expect(await reconcile("sync", sb.ctx, {})).not.toBe(0);
  expect(sb.out()).toContain("recursive = true");
  expect(await pathExists(join(sb.home, "junk", "nested", "keep.txt"))).toBe(true);
});

test("absent: a directory IS removed with recursive = true", async () => {
  const sb = await sandbox(`[[section]]
name = "Hygiene"
absent = [{ path = "~/junk", recursive = true }]
`);
  await mkdir(join(sb.home, "junk", "nested"), { recursive: true });
  await writeFile(join(sb.home, "junk", "nested", "x.txt"), "x\n");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, "junk"))).toBe(false);
});

test("absent: removes the SYMLINK, never what it points at", async () => {
  const sb = await sandbox(`[[section]]
name = "Hygiene"
absent = [{ path = "~/.claude/settings.local.json" }]
`);
  const target = join(sb.home, "real-settings.json");
  await writeFile(target, "the real file\n");
  await mkdir(join(sb.home, ".claude"), { recursive: true });
  const link = join(sb.home, ".claude", "settings.local.json");
  await symlink(target, link);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(link)).toBe(false);
  // lstat, not stat: following the link would have deleted the target instead.
  expect(await readFile(target, "utf8")).toBe("the real file\n");
});
