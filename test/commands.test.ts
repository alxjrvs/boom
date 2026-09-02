// Discovered user commands, and the `boom source set` remote-clone core.
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BoomConfigError,
  configRepoCacheDir,
  readConfigBreadcrumb,
  resolveConfigDir,
} from "../src/config/load.ts";
import { linkRemoteConfigRepo } from "../src/config/remote.ts";
import { runUserCommand } from "../src/engine/discovery.ts";
import { fakeCtx } from "./support/ctx.ts";
import { commitAll, git, gitEnv, gitRepo } from "./support/git.ts";
import { tmp } from "./support/tmp.ts";

// A one-commit repo standing in as the "remote" for linkRemoteConfigRepo (git treats a local
// path exactly like any other remote, so no network or bare repo is needed).
const origin = (withBoomfile = true): Promise<string> =>
  gitRepo("cmd", withBoomfile ? { "boomfile.toml": `[[section]]\nname = "x"\n` } : { "README.md": "hi\n" });

// The env the engine clones and inspects with: a private state dir, and git sandboxed.
const stateEnv = async (): Promise<Record<string, string>> => ({
  ...gitEnv,
  XDG_STATE_HOME: await tmp("cmd"),
});

test("runUserCommand dispatches a config-supplied command", async () => {
  const repo = await tmp("cmd");
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  await mkdir(join(repo, "commands"), { recursive: true });
  await writeFile(
    join(repo, "commands", "hello.ts"),
    `export default function (args, ctx) { ctx.process.stdout.write("hi " + args.join(",")); return 0; }\n`,
  );
  const { ctx, out } = fakeCtx({ BOOM_CONFIG: repo }, repo);
  const rc = await runUserCommand("hello", ["a", "b"], ctx);
  expect(rc).toBe(0);
  expect(out()).toBe("hi a,b");
});

test("linkRemoteConfigRepo clones into the managed cache dir and records the breadcrumb (the `boom source set` core)", async () => {
  const remote = await origin();
  const env = await stateEnv();
  const target = await linkRemoteConfigRepo(env, remote);
  expect(target).toBe(configRepoCacheDir(env));
  // The breadcrumb is the only resolution signal here (no BOOM_CONFIG, cwd elsewhere).
  expect(await resolveConfigDir(env, await tmp("cmd"))).toBe(target);
  expect((await readConfigBreadcrumb(env))?.remote.url).toBe(remote);
});

test("linkRemoteConfigRepo rejects a remote with no boomfile.toml", async () => {
  const remote = await origin(false);
  await expect(linkRemoteConfigRepo(await stateEnv(), remote)).rejects.toBeInstanceOf(BoomConfigError);
});

test("linkRemoteConfigRepo refuses to clobber an unclean managed clone on re-link", async () => {
  const remote = await origin();
  const env = await stateEnv();
  const dest = await linkRemoteConfigRepo(env, remote);
  await writeFile(join(dest, "dirty.txt"), "uncommitted\n");
  await expect(linkRemoteConfigRepo(env, remote)).rejects.toBeInstanceOf(BoomConfigError);
});

test("linkRemoteConfigRepo refuses to clobber a managed clone with committed-but-unpushed work", async () => {
  const remote = await origin();
  const env = await stateEnv();
  const dest = await linkRemoteConfigRepo(env, remote);
  await writeFile(join(dest, "new.txt"), "hi\n");
  commitAll(dest, "local work");
  // Working tree is clean once committed — `git status --porcelain` alone would miss
  // this. Re-linking must still refuse, or the commit is silently discarded on re-clone.
  await expect(linkRemoteConfigRepo(env, remote)).rejects.toBeInstanceOf(BoomConfigError);
});

test("linkRemoteConfigRepo refuses to clobber unpushed commits on a pinned (detached-HEAD) clone", async () => {
  const remote = await origin();
  const sha = git(remote, "rev-parse", "HEAD");
  const env = await stateEnv();
  const dest = await linkRemoteConfigRepo(env, `${remote}@${sha}`);
  // Commit on the detached HEAD: the tree is clean and there is no upstream to be
  // "ahead of" — only the not-on-any-remote check can see this commit, so an
  // @{u}-based guard would let the re-link wipe it.
  await writeFile(join(dest, "new.txt"), "hi\n");
  commitAll(dest, "pinned work");
  expect(await linkRemoteConfigRepo(env, remote).catch((e) => e)).toBeInstanceOf(BoomConfigError);
});

test("a failed re-link leaves the existing clone and breadcrumb untouched", async () => {
  const good = await origin();
  const env = await stateEnv();
  const dest = await linkRemoteConfigRepo(env, good);
  const other = await origin();
  // Clone of `other` succeeds but the bogus pin fails its checkout: the last-known-good
  // clone must survive (offline sync depends on it), and the breadcrumb must still
  // name `good` — not dangle over a half-linked dir holding `other`'s content.
  expect(await linkRemoteConfigRepo(env, `${other}@nosuchref`).catch((e) => e)).toBeInstanceOf(
    BoomConfigError,
  );
  expect((await readConfigBreadcrumb(env))?.remote.url).toBe(good);
  expect(await resolveConfigDir(env, await tmp("cmd"))).toBe(dest);
  expect(git(dest, "remote", "get-url", "origin")).toBe(good);
});

test("linkRemoteConfigRepo refuses a relative state dir (HOME and XDG_STATE_HOME both unset)", async () => {
  const remote = await origin();
  await expect(linkRemoteConfigRepo({}, remote)).rejects.toBeInstanceOf(BoomConfigError);
});

test("runUserCommand returns undefined for an unknown command", async () => {
  const repo = await tmp("cmd");
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  const { ctx } = fakeCtx({ BOOM_CONFIG: repo }, repo);
  expect(await runUserCommand("nope", [], ctx)).toBeUndefined();
});
