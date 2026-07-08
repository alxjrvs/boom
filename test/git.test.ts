// lib/git.ts: the dotfiles repo's own git sync (pull/hard/commit modes). Builds real
// throwaway git repos (a bare "remote" + a working clone) under a temp dir — git itself
// is the oracle here, not a mock. HOME is sandboxed per test + GIT_CONFIG_NOSYSTEM=1, so
// none of this leaks into (or is polluted by) this machine's real ~/.gitconfig hooks.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitLocalChanges, syncRepo } from "../src/lib/git.ts";
import { Reporter } from "../src/lib/reporter.ts";

function envFor(home: string): Record<string, string> {
  return { NO_COLOR: "1", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
}

function sh(args: string[], cwd: string, home: string): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: envFor(home), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function reporter(): { report: Reporter; out(): string } {
  const buf = { out: "" };
  const write = (s: string) => {
    buf.out += s;
  };
  return { report: new Reporter({ write }, { write }, false), out: () => buf.out };
}

// A bare "remote" + a cloned working repo, one initial commit already pushed. `home`
// is this sandbox's isolated $HOME (also used as the `env` passed to lib/git.ts calls).
async function gitSandbox(): Promise<{ base: string; home: string; remote: string; local: string }> {
  const base = await mkdtemp(join(tmpdir(), "botu-git-"));
  const home = join(base, "home");
  const remote = join(base, "remote.git");
  const local = join(base, "local");
  await mkdir(home, { recursive: true });
  await mkdir(remote, { recursive: true });
  sh(["init", "--bare", "-b", "main", remote], base, home);
  sh(["clone", remote, local], base, home);
  sh(["config", "user.email", "test@example.com"], local, home);
  sh(["config", "user.name", "Test"], local, home);
  await writeFile(join(local, "file.txt"), "v1\n");
  sh(["add", "-A"], local, home);
  sh(["commit", "-m", "initial"], local, home);
  sh(["push", "-u", "origin", "main"], local, home);
  return { base, home, remote, local };
}

// A second clone of the same remote, used to push a change "someone else" made.
async function pushRemoteChange(base: string, home: string, remote: string, content: string): Promise<void> {
  const other = join(base, "other");
  sh(["clone", remote, other], base, home);
  sh(["config", "user.email", "other@example.com"], other, home);
  sh(["config", "user.name", "Other"], other, home);
  await writeFile(join(other, "file.txt"), content);
  sh(["add", "-A"], other, home);
  sh(["commit", "-m", "remote change"], other, home);
  sh(["push"], other, home);
}

test("syncRepo pull: stashes dirty edits, rebases in the remote commit, pops the stash back", async () => {
  const { base, home, remote, local } = await gitSandbox();
  await pushRemoteChange(base, home, remote, "v2-from-remote\n");
  await writeFile(join(local, "scratch.txt"), "uncommitted local edit\n");
  const { report, out } = reporter();

  const result = syncRepo(local, envFor(home), "pull", report, {});
  expect(result.ok).toBe(true);
  expect(await readFile(join(local, "file.txt"), "utf8")).toBe("v2-from-remote\n");
  expect(await readFile(join(local, "scratch.txt"), "utf8")).toBe("uncommitted local edit\n");
  expect(out()).toContain("up to date with");
});

test("syncRepo pull: no upstream changes, clean tree — no-op", async () => {
  const { home, local } = await gitSandbox();
  const { report } = reporter();
  const result = syncRepo(local, envFor(home), "pull", report, {});
  expect(result.ok).toBe(true);
  expect(await readFile(join(local, "file.txt"), "utf8")).toBe("v1\n");
});

test("syncRepo pull: a genuine rebase conflict aborts cleanly and fails", async () => {
  const { base, home, remote, local } = await gitSandbox();
  await pushRemoteChange(base, home, remote, "v2-from-remote\n");
  // A local commit (not just uncommitted) that touches the same line differently.
  await writeFile(join(local, "file.txt"), "v2-from-local\n");
  sh(["commit", "-am", "local change"], local, home);
  const { report, out } = reporter();

  const result = syncRepo(local, envFor(home), "pull", report, {});
  expect(result.ok).toBe(false);
  expect(out()).toContain("rebase onto");
  // rebase --abort must have restored a clean, non-conflicted working tree.
  expect(sh(["status", "--porcelain"], local, home).trim()).toBe("");
});

test("syncRepo hard: discards local commits and uncommitted edits, matching remote", async () => {
  const { base, home, remote, local } = await gitSandbox();
  await pushRemoteChange(base, home, remote, "v2-from-remote\n");
  await writeFile(join(local, "file.txt"), "v2-from-local\n");
  sh(["commit", "-am", "local change"], local, home);
  await writeFile(join(local, "scratch.txt"), "dirty, should be discarded\n");
  const { report, out } = reporter();

  const result = syncRepo(local, envFor(home), "hard", report, {});
  expect(result.ok).toBe(true);
  expect(await readFile(join(local, "file.txt"), "utf8")).toBe("v2-from-remote\n");
  expect(out()).toContain("reset --hard");
});

test("syncRepo commit: commits local edits, then rebases them onto the pulled remote", async () => {
  const { base, home, remote, local } = await gitSandbox();
  await pushRemoteChange(base, home, remote, "v2-from-remote\n");
  await writeFile(join(local, "scratch.txt"), "local addition\n");
  const { report, out } = reporter();

  const result = syncRepo(local, envFor(home), "commit", report, { commitMessage: "test commit" });
  expect(result.ok).toBe(true);
  expect(await readFile(join(local, "file.txt"), "utf8")).toBe("v2-from-remote\n");
  expect(await readFile(join(local, "scratch.txt"), "utf8")).toBe("local addition\n");
  expect(sh(["log", "-1", "--format=%s"], local, home).trim()).toBe("test commit");
  expect(out()).toContain("committed local changes (test commit)");
});

test("syncRepo: --dry-run reports without mutating anything", async () => {
  const { base, home, remote, local } = await gitSandbox();
  await pushRemoteChange(base, home, remote, "v2-from-remote\n");
  const { report, out } = reporter();

  const result = syncRepo(local, envFor(home), "pull", report, { dryRun: true });
  expect(result.ok).toBe(true);
  expect(out()).toContain("dry run");
  expect(await readFile(join(local, "file.txt"), "utf8")).toBe("v1\n");
});

test("syncRepo: a non-git directory is a silent no-op", async () => {
  const base = await mkdtemp(join(tmpdir(), "botu-git-plain-"));
  const { report, out } = reporter();
  const result = syncRepo(base, envFor(base), "pull", report, {});
  expect(result.ok).toBe(true);
  expect(out()).toBe("");
});

test("syncRepo hard: fails clearly when there's no upstream to reset to", async () => {
  const base = await mkdtemp(join(tmpdir(), "botu-git-noup-"));
  const home = join(base, "home");
  await mkdir(home, { recursive: true });
  sh(["init", "-b", "main", base], base, home);
  sh(["config", "user.email", "test@example.com"], base, home);
  sh(["config", "user.name", "Test"], base, home);
  await writeFile(join(base, "file.txt"), "v1\n");
  sh(["add", "-A"], base, home);
  sh(["commit", "-m", "initial"], base, home);
  const { report } = reporter();

  const result = syncRepo(base, envFor(home), "hard", report, {});
  expect(result.ok).toBe(false);
});

test("commitLocalChanges: commits tracked + untracked changes as one commit", async () => {
  const { home, local } = await gitSandbox();
  await writeFile(join(local, "file.txt"), "modified\n");
  await writeFile(join(local, "new.txt"), "new file\n");
  const { report, out } = reporter();

  const result = commitLocalChanges(local, envFor(home), report, "my message");
  expect(result.ok).toBe(true);
  expect(sh(["status", "--porcelain"], local, home).trim()).toBe("");
  expect(sh(["log", "-1", "--format=%s"], local, home).trim()).toBe("my message");
  expect(out()).toContain("committed local changes (my message)");
});

test("commitLocalChanges: reports nothing to commit on a clean tree", async () => {
  const { home, local } = await gitSandbox();
  const { report, out } = reporter();
  const result = commitLocalChanges(local, envFor(home), report);
  expect(result.ok).toBe(true);
  expect(out()).toContain("nothing to commit");
});

test("commitLocalChanges: fails on a non-git directory", async () => {
  const base = await mkdtemp(join(tmpdir(), "botu-git-plain-"));
  const { report } = reporter();
  const result = commitLocalChanges(base, envFor(base), report);
  expect(result.ok).toBe(false);
});
