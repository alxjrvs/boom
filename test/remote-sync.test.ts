// Repo-only config: ref parsing, the clone/fetch/pull-and-report sync step, the
// doctor config-repo section, and `boom source push`. Fixtures are local git repos —
// `git clone`/`fetch`/`push` treat a local path exactly like any other remote, so
// none of this needs real network access.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigBreadcrumb } from "../src/config/load.ts";
import { linkRemoteConfigRepo, parseRemoteRef } from "../src/config/remote.ts";
import type { BoomContext } from "../src/context.ts";
import { diffConfigRepo } from "../src/engine/diff.ts";
import { doctor } from "../src/engine/doctor.ts";
import { pushConfigRepo } from "../src/engine/push.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { resetConfigRepo } from "../src/engine/reset.ts";
import { statusConfigRepo } from "../src/engine/status.ts";
import { pathExists } from "../src/lib/fs.ts";
import { captureArgv } from "../src/lib/proc.ts";

async function base(): Promise<string> {
  return mkdtemp(join(tmpdir(), "boom-sync-"));
}

function git(dir: string, ...args: string[]) {
  return captureArgv(["git", "-C", dir, ...args], {});
}
function commitAll(dir: string, msg: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", msg);
}

// The engine's own commit path (engine/commit.ts) shells `git commit` with no `-c`
// override, unlike commitAll above — it relies on the machine's ambient git identity
// at runtime, which a CI runner may not have. Tests exercising it configure the
// managed clone's local identity explicitly so they don't depend on that fallback.
function configureIdentity(dir: string): void {
  git(dir, "config", "user.email", "t@t.com");
  git(dir, "config", "user.name", "t");
}

async function originFixture(): Promise<string> {
  const dir = await base();
  await writeFile(join(dir, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  git(dir, "init", "-q", "-b", "main");
  commitAll(dir, "init");
  return dir;
}

async function bareOriginFixture(): Promise<string> {
  const bare = await base();
  git(bare, "init", "-q", "--bare", "-b", "main");
  const staging = await base();
  captureArgv(["git", "clone", "-q", bare, staging], {});
  await writeFile(join(staging, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  commitAll(staging, "init");
  captureArgv(["git", "push", "-q", "origin", "main"], {}, { cwd: staging });
  return bare;
}

function ctxFor(env: Record<string, string | undefined>, cwd: string): { ctx: BoomContext; out(): string } {
  const buf = { out: "" };
  const write = (s: string) => {
    buf.out += s;
  };
  const proc = { stdout: { write }, stderr: { write }, env, exitCode: 0 };
  return { ctx: { process: proc, env, cwd } as unknown as BoomContext, out: () => buf.out };
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

test("parseRemoteRef pins a ref that itself contains a slash", () => {
  // git-flow-style branch names (feature/x, release/1.0) are extremely common — a
  // slash-position heuristic for the SSH-shorthand split gets this wrong.
  expect(parseRemoteRef("alxjrvs/dotfiles@feature/foo")).toEqual({
    url: "https://github.com/alxjrvs/dotfiles.git",
    ref: "feature/foo",
  });
});

test("parseRemoteRef doesn't mistake an ssh:// URL's userinfo @ for a ref pin", () => {
  expect(parseRemoteRef("ssh://git@github.com/alxjrvs/dotfiles.git")).toEqual({
    url: "ssh://git@github.com/alxjrvs/dotfiles.git",
  });
});

test("parseRemoteRef pins an ssh:// URL past its userinfo @", () => {
  expect(parseRemoteRef("ssh://git@github.com/alxjrvs/dotfiles.git@v1.0")).toEqual({
    url: "ssh://git@github.com/alxjrvs/dotfiles.git",
    ref: "v1.0",
  });
});

test("parseRemoteRef can pin an SSH scp-shorthand too, past its host @", () => {
  expect(parseRemoteRef("git@github.com:alxjrvs/dotfiles.git@v1.0")).toEqual({
    url: "git@github.com:alxjrvs/dotfiles.git",
    ref: "v1.0",
  });
});

// ---- sync: verify reports drift, sync pulls -------------------------------

test("verify reports 0 drift right after linking", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("verify", ctx, {});
  expect(out()).toContain("up to date with origin");
  expect(rc).toBe(0);
});

test("source status reports in-sync (exit 0) right after linking", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  const { ctx, out } = ctxFor(env, repo);
  const rc = await statusConfigRepo(ctx);
  expect(out()).toContain("up to date with origin");
  expect(rc).toBe(0);
});

test("source status reports commits-behind as drift (exit 2) without pulling", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  const before = await readFile(join(repo, "boomfile.toml"), "utf8");

  await writeFile(join(origin, "boomfile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "y"\n`);
  commitAll(origin, "add y");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await statusConfigRepo(ctx);
  expect(out()).toContain("commit(s) behind origin");
  expect(rc).toBe(2);
  // status is read-only — the working tree is untouched.
  expect(await readFile(join(repo, "boomfile.toml"), "utf8")).toBe(before);
});

test("verify reports commits-behind as drift without pulling", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  const before = await readFile(join(repo, "boomfile.toml"), "utf8");

  await writeFile(join(origin, "boomfile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "y"\n`);
  commitAll(origin, "add y");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("verify", ctx, {});
  expect(out()).toContain("commit(s) behind origin");
  expect(rc).toBe(2);
  // verify never touches the working tree
  expect(await readFile(join(repo, "boomfile.toml"), "utf8")).toBe(before);
});

test("verify warns on a dirty tree even when commit history matches origin", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  await writeFile(join(repo, "scratch.txt"), "uncommitted local edit\n");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("verify", ctx, {});
  expect(out()).toContain("uncommitted local changes");
  expect(out()).not.toContain("up to date with origin");
  expect(rc).toBe(2);
});

test("verify warns on committed-but-unpushed local commits even when behind-count is 0", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  configureIdentity(repo);
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "local"\n`);
  commitAll(repo, "local edit");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("verify", ctx, {});
  expect(out()).toContain("not pushed to origin");
  expect(out()).not.toContain("up to date with origin");
  expect(rc).toBe(2);
});

test("sync pulls and reports what changed", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);

  await writeFile(join(origin, "boomfile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "y"\n`);
  commitAll(origin, "add y");

  const { ctx, out } = ctxFor(env, repo);
  await reconcile("sync", ctx, {});
  expect(out()).toContain("pulled 1 commit(s)");
  expect(out()).toContain("boomfile.toml");
  expect(await readFile(join(repo, "boomfile.toml"), "utf8")).toContain('name = "y"');
});

test("sync reports an unreachable origin but still reconciles from the local clone", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  await rm(origin, { recursive: true, force: true }); // origin vanishes (moved/deleted/offline)

  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("sync", ctx, {});
  expect(out()).toContain("could not reach");
  expect(out()).toContain("reconciling from the local clone as-is");
  expect(rc).toBe(0);
});

test("sync reports a genuine rebase conflict, aborts cleanly, but still reconciles from local state", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);

  // Diverge: a local-only commit in the managed clone...
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "local"\n`);
  commitAll(repo, "local edit");
  // ...and an incompatible commit on origin's main, off the same base — replaying the
  // local commit on top of it via rebase conflicts.
  await writeFile(join(origin, "boomfile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "remote"\n`);
  commitAll(origin, "remote edit");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("sync", ctx, {});
  expect(out()).toContain("pull --rebase failed");
  // never blocks reconciling from the last-known-good (here: locally-committed) state
  expect(await readFile(join(repo, "boomfile.toml"), "utf8")).toContain('name = "local"');
  // rebase --abort must have restored a clean, non-conflicted working tree.
  expect(git(repo, "status", "--porcelain").stdout.trim()).toBe("");
  expect(rc).toBe(1);
});

test("sync pulls a remote change while preserving an uncommitted local edit (autostash)", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);

  await writeFile(join(origin, "boomfile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "y"\n`);
  commitAll(origin, "add y");
  // uncommitted, dirty tree — the default pull must autostash this and restore it.
  await writeFile(join(repo, "scratch.txt"), "uncommitted local edit\n");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("sync", ctx, {});
  expect(rc).toBe(0);
  expect(out()).toContain("pulled 1 commit(s)");
  expect(await readFile(join(repo, "boomfile.toml"), "utf8")).toContain('name = "y"');
  expect(await readFile(join(repo, "scratch.txt"), "utf8")).toBe("uncommitted local edit\n");
});

test("sync --commit commits local edits first, then rebases them onto the pulled remote", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  configureIdentity(repo);

  await writeFile(join(origin, "boomfile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "y"\n`);
  commitAll(origin, "add y");
  await writeFile(join(repo, "scratch.txt"), "local addition\n");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("sync", ctx, { commit: true, commitMessage: "test commit" });
  expect(rc).toBe(0);
  expect(out()).toContain("committed local changes (test commit)");
  expect(await readFile(join(repo, "boomfile.toml"), "utf8")).toContain('name = "y"');
  expect(await readFile(join(repo, "scratch.txt"), "utf8")).toBe("local addition\n");
  expect(git(repo, "log", "-1", "--format=%s").stdout.trim()).toBe("test commit");
  // the commit replayed on top of the pull, not left behind as a stray unpushed tip.
  expect(git(repo, "status", "--porcelain").stdout.trim()).toBe("");
});

test("sync --commit with a clean tree pulls normally, without an empty commit", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);

  await writeFile(join(origin, "boomfile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "y"\n`);
  commitAll(origin, "add y");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("sync", ctx, { commit: true });
  expect(rc).toBe(0);
  expect(out()).not.toContain("committed local changes");
  expect(await readFile(join(repo, "boomfile.toml"), "utf8")).toContain('name = "y"');
});

test("sync --commit commits local edits even when already up to date with origin", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  configureIdentity(repo);
  // origin hasn't moved — there's nothing to pull, but --commit should still commit.
  await writeFile(join(repo, "scratch.txt"), "local addition\n");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("sync", ctx, { commit: true, commitMessage: "test commit" });
  expect(rc).toBe(0);
  expect(out()).toContain("committed local changes (test commit)");
  expect(git(repo, "log", "-1", "--format=%s").stdout.trim()).toBe("test commit");
  expect(git(repo, "status", "--porcelain").stdout.trim()).toBe("");
});

test("a pinned ref is reported as static, not checked for drift", async () => {
  const origin = await originFixture();
  const sha = git(origin, "rev-parse", "HEAD").stdout;
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, `${origin}@${sha}`);

  await writeFile(join(origin, "boomfile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "y"\n`);
  commitAll(origin, "add y");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await reconcile("verify", ctx, {});
  expect(out()).toContain("not tracking a moving branch");
  expect(rc).toBe(0);
});

// ---- reset ------------------------------------------------------------------

test("reset refuses to discard committed-but-unpushed local commits without --force", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);

  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "local"\n`);
  commitAll(repo, "local edit");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await resetConfigRepo(ctx);
  expect(rc).toBe(1);
  expect(out()).toContain("local edit"); // the at-risk commit is listed
  expect(out()).toContain("--force");
  // refused, so nothing was actually discarded
  expect(await readFile(join(repo, "boomfile.toml"), "utf8")).toContain('name = "local"');
});

test("reset --force discards uncommitted and committed-but-unpushed local changes", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);

  // A committed-but-unpushed local change...
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "local"\n`);
  commitAll(repo, "local edit");
  // ...plus an uncommitted one on top.
  await writeFile(join(repo, "untracked.txt"), "oops\n");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await resetConfigRepo(ctx, { force: true });
  expect(rc).toBe(0);
  expect(out()).toContain("reset");
  expect(await readFile(join(repo, "boomfile.toml"), "utf8")).toBe(
    await readFile(join(origin, "boomfile.toml"), "utf8"),
  );
  expect(await pathExists(join(repo, "untracked.txt"))).toBe(false);
});

test("reset discards a dirty-but-uncommitted tree with no unpushed commits, no --force needed", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);

  await writeFile(join(repo, "untracked.txt"), "oops\n"); // uncommitted only — not "unpushed work"

  const { ctx } = ctxFor(env, repo);
  // --yes consents to the dirty-tree confirm (a non-TTY refuses without it); the point of
  // this case is that --force is NOT required — only unpushed commits need that.
  expect(await resetConfigRepo(ctx, { yes: true })).toBe(0);
  expect(await pathExists(join(repo, "untracked.txt"))).toBe(false);
});

test("reset on a pinned clone goes back to the pinned ref, not origin's current tip", async () => {
  const origin = await originFixture();
  const sha = git(origin, "rev-parse", "HEAD").stdout;
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, `${origin}@${sha}`);

  // origin moves on...
  await writeFile(join(origin, "boomfile.toml"), `[[section]]\nname = "x"\n[[section]]\nname = "y"\n`);
  commitAll(origin, "add y");
  // ...and the pinned clone gets a local edit.
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "local"\n`);
  commitAll(repo, "local edit");

  const { ctx } = ctxFor(env, repo);
  // a committed-but-unpushed local commit on the pinned clone too — needs --force
  expect(await resetConfigRepo(ctx, { force: true })).toBe(0);
  // back to the pin, not origin's now-two-commits-ahead tip
  expect(await readFile(join(repo, "boomfile.toml"), "utf8")).toBe(`[[section]]\nname = "x"\n`);
});

test("reset fails cleanly when no remote config is linked", async () => {
  const { ctx } = ctxFor({ XDG_STATE_HOME: await base(), NO_COLOR: "1" }, await base());
  expect(await resetConfigRepo(ctx)).toBe(1);
});

test("reset fails cleanly when origin is unreachable", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  await rm(origin, { recursive: true, force: true });

  const { ctx, out } = ctxFor(env, repo);
  expect(await resetConfigRepo(ctx)).toBe(1);
  expect(out()).toContain("could not reach");
});

// ---- doctor -------------------------------------------------------------------

test("doctor reports the linked config repo as reachable", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  const { ctx, out } = ctxFor({ ...env, BOOM_OS: "linux" }, repo);
  await doctor(ctx);
  expect(out()).toContain(`${origin} reachable`);
});

test("doctor warns when no remote config is linked", async () => {
  const { ctx, out } = ctxFor(
    { XDG_STATE_HOME: await base(), BOOM_OS: "linux", NO_COLOR: "1" },
    await base(),
  );
  await doctor(ctx);
  expect(out()).toContain("no config repo linked");
});

// ---- diff -----------------------------------------------------------------

test("diff reports no local changes on a clean tree", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);

  const { ctx, out } = ctxFor(env, repo);
  const rc = await diffConfigRepo(ctx);
  expect(rc).toBe(0);
  expect(out()).toContain("no local changes");
});

test("diff surfaces an untracked new file the way push would capture it", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  await writeFile(join(repo, "scratch.txt"), "local addition\n");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await diffConfigRepo(ctx);
  expect(rc).toBe(0);
  expect(out()).not.toContain("no local changes");
  expect(out()).toContain("untracked");
  expect(out()).toContain("scratch.txt");
});

test("diff does not take the clean path for a modified tracked file", async () => {
  const origin = await originFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, origin);
  // boomfile.toml is tracked (from originFixture) — a content edit is a tracked change.
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "y"\n`);

  const { ctx, out } = ctxFor(env, repo);
  const rc = await diffConfigRepo(ctx);
  expect(rc).toBe(0);
  expect(out()).not.toContain("no local changes");
});

test("diff fails cleanly when no remote config is linked", async () => {
  const { ctx, out } = ctxFor({ XDG_STATE_HOME: await base(), NO_COLOR: "1" }, await base());
  const rc = await diffConfigRepo(ctx);
  expect(rc).toBe(1);
  expect(out()).toContain("no config repo linked");
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

test("push commits local changes with the given message, then pushes them", async () => {
  const bare = await bareOriginFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, bare);
  configureIdentity(repo);
  await writeFile(join(repo, "scratch.txt"), "local addition\n");

  const { ctx, out } = ctxFor(env, repo);
  const rc = await pushConfigRepo(ctx, "my message");
  expect(rc).toBe(0);
  expect(out()).toContain("committed (my message)");
  expect(out()).toContain("pushed");
  // The commit landed and the tree is clean.
  expect(git(repo, "status", "--porcelain").stdout.trim()).toBe("");
  expect(git(repo, "log", "-1", "--format=%s").stdout.trim()).toBe("my message");
  // The bare origin received it.
  const check = await base();
  captureArgv(["git", "clone", "-q", bare, check], {});
  expect(await readFile(join(check, "scratch.txt"), "utf8")).toBe("local addition\n");
});

test("push on a clean tree commits nothing and still pushes", async () => {
  const bare = await bareOriginFixture();
  const env = { XDG_STATE_HOME: await base(), NO_COLOR: "1" };
  const repo = await linkRemoteConfigRepo(env, bare);

  const { ctx, out } = ctxFor(env, repo);
  const rc = await pushConfigRepo(ctx);
  expect(rc).toBe(0);
  expect(out()).not.toContain("committed");
  expect(out()).toContain("pushed");
});

test("push fails cleanly when no remote config is linked", async () => {
  const { ctx } = ctxFor({ XDG_STATE_HOME: await base(), NO_COLOR: "1" }, await base());
  expect(await pushConfigRepo(ctx)).toBe(1);
});

// ---- captureArgv hardening --------------------------------------------------

test("captureArgv reports a missing executable or cwd as a failed result, not a throw", () => {
  // Bun.spawnSync throws for both; sync/push/reset rely on getting a code back so a
  // missing git (or a stale breadcrumb path) degrades to their reported-error paths.
  expect(captureArgv(["boom-definitely-not-a-real-tool"], {}).code).toBe(-1);
  expect(captureArgv(["git", "status"], {}, { cwd: join(tmpdir(), "boom-no-such-dir") }).code).toBe(-1);
});
