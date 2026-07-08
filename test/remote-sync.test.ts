// Repo-only config: ref parsing, the clone/fetch/pull-and-report sync step, the
// doctor config-repo section, and `botu push`. Fixtures are local git repos —
// `git clone`/`fetch`/`push` treat a local path exactly like any other remote, so
// none of this needs real network access.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigBreadcrumb } from "../src/config/load.ts";
import { linkRemoteConfigRepo, parseRemoteRef } from "../src/config/remote.ts";
import type { BotuContext } from "../src/context.ts";
import { doctor } from "../src/engine/doctor.ts";
import { pushConfigRepo } from "../src/engine/push.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { captureArgv } from "../src/lib/proc.ts";

async function base(): Promise<string> {
  return mkdtemp(join(tmpdir(), "botu-sync-"));
}

function git(dir: string, ...args: string[]) {
  return captureArgv(["git", "-C", dir, ...args], {});
}
function commitAll(dir: string, msg: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", msg);
}

async function originFixture(): Promise<string> {
  const dir = await base();
  await writeFile(join(dir, "botufile.toml"), `[[section]]\nname = "x"\n`);
  git(dir, "init", "-q", "-b", "main");
  commitAll(dir, "init");
  return dir;
}

async function bareOriginFixture(): Promise<string> {
  const bare = await base();
  git(bare, "init", "-q", "--bare", "-b", "main");
  const staging = await base();
  captureArgv(["git", "clone", "-q", bare, staging], {});
  await writeFile(join(staging, "botufile.toml"), `[[section]]\nname = "x"\n`);
  commitAll(staging, "init");
  captureArgv(["git", "push", "-q", "origin", "main"], {}, { cwd: staging });
  return bare;
}

function ctxFor(env: Record<string, string | undefined>, cwd: string): { ctx: BotuContext; out(): string } {
  const buf = { out: "" };
  const write = (s: string) => {
    buf.out += s;
  };
  const proc = { stdout: { write }, stderr: { write }, env, exitCode: 0 };
  return { ctx: { process: proc, env, cwd } as unknown as BotuContext, out: () => buf.out };
}

// ---- parseRemoteRef ----------------------------------------------------------

test("parseRemoteRef expands owner/repo shorthand to a GitHub URL", () => {
  expect(parseRemoteRef("alxjrvs/dotfiles")).toEqual({ url: "https://github.com/alxjrvs/dotfiles.git" });
});

test("parseRemoteRef expands the github: prefix", () => {
  expect(parseRemoteRef("github:alxjrvs/dotfiles")).toEqual({
    url: "https://github.com/alxjrvs/dotfiles.git",
  });
});

test("parseRemoteRef splits a trailing @ref pin", () => {
  expect(parseRemoteRef("alxjrvs/dotfiles@develop")).toEqual({
    url: "https://github.com/alxjrvs/dotfiles.git",
    ref: "develop",
  });
});

test("parseRemoteRef passes a full URL through untouched", () => {
  expect(parseRemoteRef("https://example.com/x/y.git")).toEqual({ url: "https://example.com/x/y.git" });
});

test("parseRemoteRef doesn't mistake the SSH shorthand's @ for a ref pin", () => {
  expect(parseRemoteRef("git@github.com:alxjrvs/dotfiles.git")).toEqual({
    url: "git@github.com:alxjrvs/dotfiles.git",
  });
});

test("parseRemoteRef pins a full URL", () => {
  expect(parseRemoteRef("https://example.com/x/y.git@v1.2.3")).toEqual({
    url: "https://example.com/x/y.git",
    ref: "v1.2.3",
  });
});

// ---- sync: verify reports drift, apply pulls -------------------------------

test("verify reports 0 drift right after linking", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("verify", ctx, {});
  expect(out()).toContain("up to date with origin");
  expect(rc).toBe(0);
});

test("verify reports commits-behind as drift without pulling", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  const before = await readFile(join(repo, "botufile.toml"), "utf8");

  await writeFile(join(origin, "botufile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "y"\n`);
  commitAll(origin, "add y");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("verify", ctx, {});
  expect(out()).toContain("commit(s) behind origin");
  expect(rc).toBe(2);
  // verify never touches the working tree
  expect(await readFile(join(repo, "botufile.toml"), "utf8")).toBe(before);
});

test("apply fast-forward-pulls and reports what changed", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);

  await writeFile(join(origin, "botufile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "y"\n`);
  commitAll(origin, "add y");

  const { ctx, out } = ctxFor(env, repo);
  await reconcile("apply", ctx, {});
  expect(out()).toContain("pulled 1 commit(s)");
  expect(out()).toContain("botufile.toml");
  expect(await readFile(join(repo, "botufile.toml"), "utf8")).toContain('name = "y"');
});

test("a pinned ref is reported as static, not checked for drift", async () => {
  const origin = await originFixture();
  const sha = git(origin, "rev-parse", "HEAD").stdout;
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, `${origin}@${sha}`);

  await writeFile(join(origin, "botufile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "y"\n`);
  commitAll(origin, "add y");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("verify", ctx, {});
  expect(out()).toContain("not tracking a moving branch");
  expect(rc).toBe(0);
});

// ---- doctor -------------------------------------------------------------------

test("doctor reports the linked config repo as reachable", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  const { ctx, out } = ctxFor({ ...env, BOTU_OS: "linux" }, repo);
  await doctor(ctx);
  expect(out()).toContain(`${origin} reachable`);
});

test("doctor warns when no remote config is linked", async () => {
  const { ctx, out } = ctxFor(
    { XDG_STATE_HOME: await base(), BOTU_OS: "linux", NO_COLOR: "1" },
    await base(),
  );
  await doctor(ctx);
  expect(out()).toContain("no remote config linked");
});

// ---- push -----------------------------------------------------------------

test("push sends local commits to the managed clone's origin", async () => {
  const bare = await bareOriginFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, bare);

  await mkdir(join(repo, "extra"), { recursive: true });
  await writeFile(join(repo, "extra", "file.txt"), "hi\n");
  commitAll(repo, "add extra file");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await pushConfigRepo(ctx);
  expect(rc).toBe(0);
  expect(out()).toContain("pushed");

  const breadcrumb = await readConfigBreadcrumb(env);
  expect(breadcrumb?.path).toBe(repo);
  // The bare origin now has the commit — verify by fetching into a fresh clone.
  const check = await base();
  captureArgv(["git", "clone", "-q", bare, check], {});
  expect(await readFile(join(check, "extra", "file.txt"), "utf8")).toBe("hi\n");
});

test("push fails cleanly when no remote config is linked", async () => {
  const { ctx } = ctxFor({ XDG_STATE_HOME: await base(), NO_COLOR: "1" }, await base());
  expect(await pushConfigRepo(ctx)).toBe(1);
});
