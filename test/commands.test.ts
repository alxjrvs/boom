// Discovered user commands, and the `boom source set` remote-clone core.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoomConfigError,
  configRepoCacheDir,
  readConfigBreadcrumb,
  resolveConfigDir,
} from "../src/config/load.ts";
import { linkRemoteConfigRepo } from "../src/config/remote.ts";
import type { BoomContext } from "../src/context.ts";
import { runUserCommand } from "../src/engine/discovery.ts";
import { captureArgv } from "../src/lib/proc.ts";

async function base(): Promise<string> {
  return mkdtemp(join(tmpdir(), "boom-cmd-"));
}

// A local git repo with one commit — plays the role of "remote" for linkRemoteConfigRepo
// tests. `git clone` treats a local path exactly like any other remote, so no network
// (or a bare repo) is needed.
async function gitFixture(withBoomfile = true): Promise<string> {
  const dir = await base();
  if (withBoomfile) await writeFile(join(dir, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  else await writeFile(join(dir, "README.md"), "hi\n");
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "ignore", stderr: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t.com", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
  return dir;
}

function ctxFor(
  env: Record<string, string | undefined>,
  cwd: string,
): { ctx: BoomContext; out(): string; code(): number } {
  const buf = { out: "" };
  const proc = {
    stdout: {
      write: (s: string) => {
        buf.out += s;
      },
    },
    stderr: {
      write: (s: string) => {
        buf.out += s;
      },
    },
    env,
    exitCode: 0,
  };
  return {
    ctx: { process: proc, env, cwd } as unknown as BoomContext,
    out: () => buf.out,
    code: () => proc.exitCode,
  };
}

// The guard four now-removed `boom code` subcommands used to hand-copy. It is the *only* place that error
// string lives now, so this pins its wording, its stream and the bail-out contract at once.
test("runUserCommand dispatches a config-supplied command", async () => {
  const repo = await base();
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  await mkdir(join(repo, "commands"), { recursive: true });
  await writeFile(
    join(repo, "commands", "hello.ts"),
    `export default function (args, ctx) { ctx.process.stdout.write("hi " + args.join(",")); return 0; }\n`,
  );
  const { ctx, out } = ctxFor({ BOOM_CONFIG: repo }, repo);
  const rc = await runUserCommand("hello", ["a", "b"], ctx);
  expect(rc).toBe(0);
  expect(out()).toBe("hi a,b");
});

test("linkRemoteConfigRepo clones into the managed cache dir and records the breadcrumb (the `boom source set` core)", async () => {
  const origin = await gitFixture();
  const env = { XDG_STATE_HOME: await base() };
  const target = await linkRemoteConfigRepo(env, origin);
  expect(target).toBe(configRepoCacheDir(env));
  // The breadcrumb is the only resolution signal here (no BOOM_CONFIG, cwd elsewhere).
  expect(await resolveConfigDir(env, await base())).toBe(target);
  expect((await readConfigBreadcrumb(env))?.remote.url).toBe(origin);
});

test("linkRemoteConfigRepo rejects a remote with no boomfile.toml", async () => {
  const origin = await gitFixture(false);
  const env = { XDG_STATE_HOME: await base() };
  expect(linkRemoteConfigRepo(env, origin)).rejects.toBeInstanceOf(BoomConfigError);
});

test("linkRemoteConfigRepo refuses to clobber an unclean managed clone on re-link", async () => {
  const origin = await gitFixture();
  const env = { XDG_STATE_HOME: await base() };
  const dest = await linkRemoteConfigRepo(env, origin);
  await writeFile(join(dest, "dirty.txt"), "uncommitted\n");
  expect(linkRemoteConfigRepo(env, origin)).rejects.toBeInstanceOf(BoomConfigError);
});

test("linkRemoteConfigRepo refuses to clobber a managed clone with committed-but-unpushed work", async () => {
  const origin = await gitFixture();
  const env = { XDG_STATE_HOME: await base() };
  const dest = await linkRemoteConfigRepo(env, origin);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", dest, ...args], { stdout: "ignore", stderr: "ignore" });
  await writeFile(join(dest, "new.txt"), "hi\n");
  git("add", "-A");
  git("-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "local work");
  // Working tree is clean once committed — `git status --porcelain` alone would miss
  // this. Re-linking must still refuse, or the commit is silently discarded on re-clone.
  expect(linkRemoteConfigRepo(env, origin)).rejects.toBeInstanceOf(BoomConfigError);
});

test("linkRemoteConfigRepo refuses to clobber unpushed commits on a pinned (detached-HEAD) clone", async () => {
  const origin = await gitFixture();
  const sha = captureArgv(["git", "-C", origin, "rev-parse", "HEAD"], {}).stdout;
  const env = { XDG_STATE_HOME: await base() };
  const dest = await linkRemoteConfigRepo(env, `${origin}@${sha}`);
  // Commit on the detached HEAD: the tree is clean and there is no upstream to be
  // "ahead of" — only the not-on-any-remote check can see this commit, so an
  // @{u}-based guard would let the re-link wipe it.
  await writeFile(join(dest, "new.txt"), "hi\n");
  captureArgv(["git", "-C", dest, "add", "-A"], {});
  captureArgv(
    ["git", "-C", dest, "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "pinned work"],
    {},
  );
  expect(await linkRemoteConfigRepo(env, origin).catch((e) => e)).toBeInstanceOf(BoomConfigError);
});

test("a failed re-link leaves the existing clone and breadcrumb untouched", async () => {
  const good = await gitFixture();
  const env = { XDG_STATE_HOME: await base() };
  const dest = await linkRemoteConfigRepo(env, good);
  const other = await gitFixture();
  // Clone of `other` succeeds but the bogus pin fails its checkout: the last-known-good
  // clone must survive (offline sync depends on it), and the breadcrumb must still
  // name `good` — not dangle over a half-linked dir holding `other`'s content.
  expect(await linkRemoteConfigRepo(env, `${other}@nosuchref`).catch((e) => e)).toBeInstanceOf(
    BoomConfigError,
  );
  expect((await readConfigBreadcrumb(env))?.remote.url).toBe(good);
  expect(await resolveConfigDir(env, await base())).toBe(dest);
  expect(captureArgv(["git", "-C", dest, "remote", "get-url", "origin"], {}).stdout).toBe(good);
});

test("linkRemoteConfigRepo refuses a relative state dir (HOME and XDG_STATE_HOME both unset)", async () => {
  const origin = await gitFixture();
  expect(linkRemoteConfigRepo({}, origin)).rejects.toBeInstanceOf(BoomConfigError);
});

test("runUserCommand returns undefined for an unknown command", async () => {
  const repo = await base();
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  const { ctx } = ctxFor({ BOOM_CONFIG: repo }, repo);
  expect(await runUserCommand("nope", [], ctx)).toBeUndefined();
});
