// The shipped `boom publish` example (examples/dotfiles/commands/publish.ts) — a discovered user
// command, so nothing in src imports it and nothing else would notice it rotting. These pin the
// two properties the whole workflow rests on: publishing never disturbs the working tree the
// symlinks point at, and the post-merge realign drops only commits whose content is already
// upstream. Imported directly (not through the compiled binary) so a failure points at a line.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import publish from "../examples/dotfiles/commands/publish.ts";
import type { BoomContext } from "../src/context.ts";

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(r.stdout).trim();
}

// A bare origin plus a clone standing in for the boom-managed config repo. Bare so the clone can
// push to it, and identity is set per-repo so the test doesn't depend on an ambient git identity
// (CI runners have none).
async function fixture(): Promise<{ origin: string; clone: string }> {
  const origin = await mkdtemp(join(tmpdir(), "boom-pub-origin-"));
  const clone = await mkdtemp(join(tmpdir(), "boom-pub-clone-"));
  git(origin, "init", "-q", "--bare", "-b", "main");
  Bun.spawnSync(["git", "clone", "-q", origin, clone], { stdout: "ignore", stderr: "ignore" });
  git(clone, "config", "user.email", "t@t.com");
  git(clone, "config", "user.name", "t");
  await writeFile(join(clone, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  await writeFile(join(clone, "zshrc"), "export A=1\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "init");
  git(clone, "push", "-q", "-u", "origin", "main");
  return { origin, clone };
}

function ctxFor(clone: string): { ctx: BoomContext; out(): string } {
  const buf = { out: "" };
  const write = (s: string) => {
    buf.out += s;
  };
  const env = { BOOM_CONFIG: clone, BOOM_HOST: "testbox" };
  const proc = { stdout: { write }, stderr: { write }, env, exitCode: 0 };
  return { ctx: { process: proc, env, cwd: clone } as unknown as BoomContext, out: () => buf.out };
}

test("publish pushes a branch without checking it out — the working tree is untouched", async () => {
  const { clone } = await fixture();
  await writeFile(join(clone, "zshrc"), "export A=1\nexport B=2\n");
  const { ctx, out } = ctxFor(clone);

  expect(await publish(["-m", "zsh: add B", "--no-pr"], ctx)).toBe(0);

  // The invariant that makes this safe on a live machine: still on `main`, and the file every
  // symlink resolves through is byte-identical to what was just edited.
  expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(await readFile(join(clone, "zshrc"), "utf8")).toBe("export A=1\nexport B=2\n");
  expect(git(clone, "status", "--porcelain")).toBe("");
  const branch = git(clone, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/boom");
  expect(branch).toStartWith("origin/boom/testbox-");
  expect(out()).toContain("pushed 1 commit(s)");

  // Idempotent: a second run has nothing to say and leaves the branch alone.
  const again = ctxFor(clone);
  expect(await publish(["--no-pr"], again.ctx)).toBe(0);
  expect(again.out()).toContain("nothing to publish");
});

test("publish realigns after a squash merge, and refuses to while the work is unmerged", async () => {
  const { origin, clone } = await fixture();
  await writeFile(join(clone, "zshrc"), "export A=1\nexport B=2\n");
  await publish(["-m", "zsh: add B", "--no-pr"], ctxFor(clone).ctx);
  const published = git(clone, "rev-parse", "HEAD");

  // Not merged yet: the local commit is the only copy of these bytes on this machine, so the
  // realign must leave HEAD exactly where it is.
  const pending = ctxFor(clone);
  await publish(["--no-pr"], pending.ctx);
  expect(git(clone, "rev-parse", "HEAD")).toBe(published);
  expect(pending.out()).not.toContain("realigned");

  // Land it the way GitHub's "Squash and merge" does — a NEW commit carrying the same content —
  // via a scratch clone, alongside an unrelated commit so the realign can't just be a fast-forward.
  const lander = await mkdtemp(join(tmpdir(), "boom-pub-land-"));
  Bun.spawnSync(["git", "clone", "-q", origin, lander], { stdout: "ignore", stderr: "ignore" });
  git(lander, "config", "user.email", "t@t.com");
  git(lander, "config", "user.name", "t");
  await writeFile(join(lander, "README.md"), "hi\n");
  await writeFile(join(lander, "zshrc"), "export A=1\nexport B=2\n");
  git(lander, "add", "-A");
  git(lander, "commit", "-qm", "Squash merge: zsh + docs");
  git(lander, "push", "-q", "origin", "main");

  const landed = ctxFor(clone);
  expect(await publish(["--no-pr"], landed.ctx)).toBe(0);
  expect(landed.out()).toContain("realigned onto origin/main");
  // Realigned, not reverted: HEAD is origin/main and the published bytes are still on disk.
  expect(git(clone, "rev-parse", "HEAD")).toBe(git(clone, "rev-parse", "origin/main"));
  expect(await readFile(join(clone, "zshrc"), "utf8")).toBe("export A=1\nexport B=2\n");
  // …which is the point: `git pull --rebase` (what `boom source` runs) is now a no-op, not a
  // conflict against your own already-landed commit.
  expect(git(clone, "rev-list", "--count", "HEAD", "--not", "--remotes")).toBe("0");
});
