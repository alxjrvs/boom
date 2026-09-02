// The `dir` resource end to end: create with mode, verify, and the uninstall ladder (kept when
// not owned, kept when non-empty, removed and journaled when empty). Sandboxed $HOME + repo,
// driving reconcile() directly (the same oracle style as engine.test.ts).
import { expect, test } from "bun:test";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readRun } from "../src/engine/journal.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { pathExists } from "../src/lib/fs.ts";
import { makeSandbox, octalMode, type Sandbox } from "./support/sandbox.ts";

const sandbox = (boomfile: string): Promise<Sandbox> => makeSandbox(boomfile, { prefix: "dir" });

test("dir: sync creates the directory with mode, verify ok, uninstall removes it (remove_on_uninstall)", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "d"\ndir = [{ path = "~/.ssh/cm", mode = "700", remove_on_uninstall = true }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const cm = join(sb.home, ".ssh", "cm");
  expect((await stat(cm)).isDirectory()).toBe(true);
  expect(await octalMode(cm)).toBe("700");
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(cm)).toBe(false);
});

test("dir: an un-owned dir is left on uninstall; a non-empty remove_on_uninstall dir is kept", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "d"\ndir = [{ path = "~/Screenshots", remove_on_uninstall = true }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const dir = join(sb.home, "Screenshots");
  await writeFile(join(dir, "shot.png"), "x"); // user data lands in it
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(dir)).toBe(true); // not empty → kept
  expect(sb.out()).toContain("not removed — not empty"); // shows under its band in the dense default
});

// The mkdir undo is `rmdir`, not `rm -rf` — reversing a directory boom created must never take
// data boom never touched with it. These three pin the arm's whole ladder: kept, removed, gone.

test("dir: uninstall previews with `plan`, then journals the rmdir with a mkdir undo", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "d"\ndir = [{ path = "~/empty", remove_on_uninstall = true }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const dir = join(sb.home, "empty");
  expect(await reconcile("uninstall", sb.ctx, { dryRun: true })).toBe(0);
  expect(sb.out()).toContain("would remove ~/empty"); // the plan tier, shown in the default output
  expect(await pathExists(dir)).toBe(true);
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(dir)).toBe(false);
  expect((await readRun(sb.env))?.done).toContainEqual({ op: "rmdir", dst: dir, undo: { kind: "mkdir" } });
});

test("dir: verify fails when the directory is missing", async () => {
  const sb = await sandbox(`[[section]]\nname = "d"\ndir = [{ path = "~/nope" }]\n`);
  expect(await reconcile("verify", sb.ctx, {})).toBe(1);
  expect(sb.out()).toContain("missing");
});

test("dir: a non-directory at the path is skipped, never clobbered", async () => {
  const sb = await sandbox(`[[section]]\nname = "d"\ndir = [{ path = "~/thing" }]\n`);
  await writeFile(join(sb.home, "thing"), "i am a file\n");
  expect(await reconcile("sync", sb.ctx, { verbose: true })).toBe(0);
  expect((await stat(join(sb.home, "thing"))).isFile()).toBe(true);
  expect(sb.out()).toContain("not a directory"); // verbose: the "skipped" line is quiet by default
});

test("dir: a corrected mode shows the change under --verbose; an already-correct dir is a no-op", async () => {
  const sb = await sandbox(`[[section]]\nname = "d"\ndir = [{ path = "~/box", mode = "700" }]\n`);
  await mkdir(join(sb.home, "box"), { recursive: true });
  await chmod(join(sb.home, "box"), 0o755); // pre-existing dir with the wrong mode

  // The chmod that corrects the mode is a real change (an ok line), shown under its band by default.
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await octalMode(join(sb.home, "box"))).toBe("700");
  expect(sb.out()).toContain("~/box (mode 700)");

  // Re-sync quiet: the mode is already correct → a no-op; nothing about ~/box reappears (the
  // skip is quiet-suppressed, folded under the section band).
  sb.clear();
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(sb.out()).not.toContain("~/box (mode 700)");
});
