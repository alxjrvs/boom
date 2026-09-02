// git for fixtures, sandboxed. No system or global config and a fixed identity from the
// environment — never `git config user.*` per repo — so a fixture depends neither on the
// developer's ~/.gitconfig (a commit hook, gpgsign, a signing key) nor on CI having an identity.
// `gitEnv` is the same sandbox for the git boom itself runs (sync.ts's pull and commit, the
// publish example): the suites that reach those merge it into the ctx env.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmp } from "./tmp.ts";

export const gitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.com",
} as const;

// Run git in `dir`; trimmed stdout. Throws on a nonzero exit so a broken fixture fails at the
// line that broke it, not three assertions later.
export function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: { ...process.env, ...gitEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${dir}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

export function commitAll(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

// A repo with `files` committed on `main`: the stand-in for a remote (git treats a local path
// exactly like any other remote, so nothing here needs the network) or for a managed clone.
export async function gitRepo(prefix: string, files: Record<string, string>): Promise<string> {
  const dir = await tmp(prefix);
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  git(dir, "init", "-q", "-b", "main");
  commitAll(dir, "init");
  return dir;
}
