// M3: the sync transaction — journal, backups, rollback, verify --json, and orphan
// reaping. Each test drives the engine against a fully sandboxed $HOME + repo.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, listRuns, newRunId, readRun } from "../src/engine/journal.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { readManifest } from "../src/engine/state.ts";
import { linkTarget, pathExists, stat } from "../src/lib/fs.ts";
import { backupsDir } from "../src/lib/paths.ts";
import { makeSandbox, type Sandbox } from "./support/sandbox.ts";

const sandbox = (boomfile: string): Promise<Sandbox> => makeSandbox(boomfile, { prefix: "boom-tx-" });

// Snapshot every entry under `dir` (path → bytes, or a `symlink:` marker), NOT following
// symlinks. Used to assert the config repo comes out of a sync byte-identical: the `**` bug
// moved the repo's own sources into the backup tree and left self-referential links behind,
// which a spot-check of one file would miss.

// Post-condition for every reconcile that creates links: no symlink may LIVE inside the config
// repo. A link whose *target* is in the repo is the normal, intended case — the damage guarded
// against here is the inverse, a link written INTO the repo because its dst resolved there
// through a directory symlink boom had just created itself (`nvim/**` matching the directory
// `nvim` as well as its files). Reaching that state requires following directory symlinks, so
// the walk does, with a visited set of realpaths so a cycle cannot hang it.
async function expectNoLinkIntoRepo(home: string, repo: string): Promise<void> {
  const root = await realpath(repo);
  const seen = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    const real = await realpath(dir).catch(() => undefined);
    if (real === undefined || seen.has(real)) return;
    seen.add(real);
    const inRepo = real === root || real.startsWith(`${root}/`);
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        expect(inRepo ? p : undefined).toBeUndefined();
        if ((await stat(p).catch(() => undefined))?.isDirectory()) await walk(p);
      } else if (e.isDirectory()) {
        await walk(p);
      }
    }
  };
  await walk(home);
}

test("--resume re-applies a missing dst and skips one already correct on disk (idempotent)", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\nlink = [{ src = ".a", dst = "~/.a" }, { src = ".b", dst = "~/.b" }]\n`,
  );
  await sb.write(".a", "a");
  await sb.write(".b", "b");
  // Simulate an interrupted run: ~/.b was actually linked; ~/.a never got created (its
  // create threw/was killed). Resume must trust the DISK, not the journal — re-applying the
  // missing ~/.a and skipping the already-correct ~/.b — so a create that failed after its
  // journal row was written is retried, not silently declared done.
  await symlink(join(sb.repo, ".b"), join(sb.home, ".b"));
  const prior = new Journal(sb.ctx.env, newRunId());
  // Both got a journal `done` row, but only ~/.b landed on disk — ~/.a's create failed
  // after its row was written. A journal row must NOT cause resume to skip ~/.a.
  await prior.done("link", join(sb.home, ".a"), { kind: "remove" });
  await prior.done("link", join(sb.home, ".b"), { kind: "remove" });
  prior.close();

  sb.clear();
  expect(await reconcile("sync", sb.ctx, { resume: true, verbose: true })).toBe(0);
  expect(sb.out()).toContain("already linked"); // ~/.b skipped by the reality check (verbose: skips are quiet by default)
  expect(await linkTarget(join(sb.home, ".a"))).toBe(join(sb.repo, ".a")); // ~/.a re-applied
  expect(await linkTarget(join(sb.home, ".b"))).toBe(join(sb.repo, ".b")); // ~/.b intact
});

test("newRunId is unique across same-millisecond calls (no journal collision)", () => {
  // Back-to-back runs in one process must never share an id — the millisecond-resolution
  // timestamp alone can collide, which would make two runs write one journal file.
  const ids = Array.from({ length: 50 }, () => newRunId());
  expect(new Set(ids).size).toBe(ids.length);
  // …and still sort chronologically (later call → lexically-greater id).
  expect([...ids].sort()).toEqual(ids);
});

test("glob link self-heals a stale non-directory at the dst dir (a whole-dir → glob migration)", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\nlink = [{ src = "skills/*", dst = "~/.claude/skills" }]\n`,
  );
  await mkdir(join(sb.repo, "skills"), { recursive: true });
  await sb.write("skills/a.md", "a");
  await mkdir(join(sb.home, ".claude"), { recursive: true });
  // A broken symlink at the shared dst dir — mkdir(recursive) throws EEXIST on this
  // (it only no-ops for a real directory), which is exactly the crash being fixed here.
  await symlink(join(sb.repo, "gone"), join(sb.home, ".claude/skills"));
  // Clearing a foreign squatter is an overwrite, so the self-heal is the --fix path;
  // skip-by-default sync leaves the stale link in place rather than clobbering it.
  expect(await reconcile("sync", sb.ctx, { linkMode: "overwrite" })).toBe(0);
  expect((await stat(join(sb.home, ".claude/skills"))).isDirectory()).toBe(true);
  expect(await linkTarget(join(sb.home, ".claude/skills/a.md"))).toBe(join(sb.repo, "skills/a.md"));
  await expectNoLinkIntoRepo(sb.home, sb.repo);
});

test("globbing a directory to link it whole still works (the ancestor drop must not fire)", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\nlink = [{ src = "skills/*", dst = "~/.claude/skills" }]\n`,
  );
  await mkdir(join(sb.repo, "skills/pack"), { recursive: true });
  await sb.write("skills/pack/SKILL.md", "s");
  // `skills/*` returns only `skills/pack` — no descendant of it is also a match, so the
  // ancestor filter has nothing to drop and the whole-directory link survives.
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await linkTarget(join(sb.home, ".claude/skills/pack"))).toBe(join(sb.repo, "skills/pack"));
  await expectNoLinkIntoRepo(sb.home, sb.repo);
});

test("a dst that resolves into the repo through a pre-existing symlink is refused", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\nlink = [{ src = "nvim/init.lua", dst = "~/.config/nvim/init.lua" }]\n`,
  );
  await mkdir(join(sb.repo, "nvim"), { recursive: true });
  await sb.write("nvim/init.lua", "init");
  await mkdir(join(sb.home, ".config"), { recursive: true });
  // The damaged state a previous `**` sync leaves behind — boom must report it, not "repair"
  // it by overwriting its own source with a symlink to itself.
  await symlink(join(sb.repo, "nvim"), join(sb.home, ".config/nvim"));
  expect(await reconcile("sync", sb.ctx, { linkMode: "overwrite" })).toBe(1);
  expect(sb.out()).toContain("refusing to link the repo into itself");
  expect(await readFile(join(sb.repo, "nvim/init.lua"), "utf8")).toBe("init");
});

test("verify --json emits a parseable structured report", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\n`);
  await sb.write(".z", "z");
  await reconcile("sync", sb.ctx, {});
  sb.clear();
  expect(await reconcile("verify", sb.ctx, { json: true })).toBe(0);
  const parsed = JSON.parse(sb.out());
  expect(parsed.schemaVersion).toBe(2);
  expect(parsed.ok).toBe(true);
  expect(parsed.failures).toBe(0);
  expect(Array.isArray(parsed.records)).toBe(true);
});

test("--only does NOT reap links owned by other sections", async () => {
  // Regression: a scoped sync only re-declares its named section, so reaping must be
  // skipped and the manifest merged — otherwise every other section looks orphaned.
  const sb = await sandbox(
    `[[section]]\nname = "a"\nlink = [{ src = ".a", dst = "~/.a" }]\n[[section]]\nname = "b"\nlink = [{ src = ".b", dst = "~/.b" }]\n`,
  );
  await sb.write(".a", "a");
  await sb.write(".b", "b");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".b"))).toBe(true);

  // Re-sync scoped to "a" only. "b" must survive untouched.
  expect(await reconcile("sync", sb.ctx, { only: ["a"] })).toBe(0);
  expect(await linkTarget(join(sb.home, ".a"))).toBe(join(sb.repo, ".a"));
  expect(await linkTarget(join(sb.home, ".b"))).toBe(join(sb.repo, ".b"));

  // And a later full sync still knows it owns "b" (merged manifest), so dropping "b"
  // from the config reaps it as expected — proving the manifest wasn't narrowed.
  await sb.write("boomfile.toml", `[[section]]\nname = "a"\nlink = [{ src = ".a", dst = "~/.a" }]\n`);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".b"))).toBe(false);
});

test("orphan reaping reaps an unmodified copy but leaves a modified one", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\ncopy = [{ src = "u", dst = "~/u" }, { src = "m", dst = "~/m" }]\n`,
  );
  await sb.write("u", "u");
  await sb.write("m", "m");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  await writeFile(join(sb.home, "m"), "edited by user"); // diverge from source

  await sb.write("boomfile.toml", `[[section]]\nname = "S"\n`); // drop both copies
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, "u"))).toBe(false); // unmodified → reaped
  expect(await pathExists(join(sb.home, "m"))).toBe(true); // modified → left in place
});

test("copy sync is a no-op once the destination already matches the source", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\ncopy = [{ src = "u", dst = "~/u" }]\n`);
  await sb.write("u", "u");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);

  sb.clear();
  expect(await reconcile("sync", sb.ctx, { verbose: true })).toBe(0);
  expect(sb.out()).toContain("already up to date"); // verbose: the no-op skip is quiet by default
  expect(sb.out()).not.toContain("copied");
});

test("sync --json emits a parseable structured report", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\n`);
  await sb.write(".z", "z");
  expect(await reconcile("sync", sb.ctx, { json: true })).toBe(0);
  const parsed = JSON.parse(sb.out());
  expect(parsed.schemaVersion).toBe(2);
  expect(parsed.ok).toBe(true);
  expect(parsed.failures).toBe(0);
  expect(Array.isArray(parsed.records)).toBe(true);
});

// Subprocess (not in-process): a `run` step's stdout uses real OS fds, so only a real
// child can prove --json keeps stdout pure. Must be Bun.spawnSync (oven-sh/bun#24690).
test("sync --json keeps run-step output off stdout (routes it to stderr)", async () => {
  const base = await mkdtemp(join(tmpdir(), "boom-json-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(
    join(repo, "boomfile.toml"),
    `[[section]]\nname = "S"\nrun = [{ on = "sync", cmd = "echo POLLUTION_ON_STDOUT" }]\n`,
  );
  const index = join(import.meta.dir, "../src/index.ts");
  const env = {
    HOME: home,
    XDG_STATE_HOME: join(base, "state"),
    BOOM_CONFIG: repo,
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "",
  };
  const p = Bun.spawnSync(["bun", index, "source", "--json"], { cwd: repo, env });
  const stdout = p.stdout.toString();
  const stderr = p.stderr.toString();
  // stdout is exactly the JSON envelope — no leaked child output.
  expect(stdout).not.toContain("POLLUTION_ON_STDOUT");
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.ok).toBe(true);
  // the run output isn't lost — it's diverted to stderr.
  expect(stderr).toContain("POLLUTION_ON_STDOUT");
});

test("orphan reaping removes a link dropped from the config", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\nlink = [{ src = ".a", dst = "~/.a" }, { src = ".b", dst = "~/.b" }]\n`,
  );
  await sb.write(".a", "a");
  await sb.write(".b", "b");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".b"))).toBe(true);

  await sb.write("boomfile.toml", `[[section]]\nname = "S"\nlink = [{ src = ".a", dst = "~/.a" }]\n`);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".a"))).toBe(true);
  expect(await pathExists(join(sb.home, ".b"))).toBe(false); // reaped
});

test("a truncated base boomfile FAILS the sync — it never reaps every managed file", async () => {
  // The regression guard for the whole base-vs-overlay split. A base boomfile with no
  // `[[section]]` (zero-byte after an editor truncation, half-written when a scheduled sync
  // fires, every section commented out) must not parse as "this machine declares nothing":
  // that hands reconcile an empty `declared` set, and orphan reaping then deletes EVERY
  // destination in the prior manifest while exiting 0. Loud failure, and the files survive.
  const sb = await sandbox(
    `[[section]]\nname = "S"\nlink = [{ src = ".a", dst = "~/.a" }, { src = ".b", dst = "~/.b" }]\n`,
  );
  await sb.write(".a", "a");
  await sb.write(".b", "b");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".a"))).toBe(true);

  sb.clear();
  await sb.write("boomfile.toml", "");
  expect(await reconcile("sync", sb.ctx, {})).not.toBe(0);
  expect(sb.out()).toContain("section");
  expect(sb.out()).not.toContain("reaped orphan");
  expect(await pathExists(join(sb.home, ".a"))).toBe(true);
  expect(await pathExists(join(sb.home, ".b"))).toBe(true);
});

// --- hooks as first-class resources -------------------------------------------------------

// Drop a hook module into the sandbox repo. Hooks are untyped `.ts` loaded by runtime import(),
// so the body is written as source text — exactly how a user ships one.
async function hookModule(repo: string, name: string, body: string): Promise<void> {
  await mkdir(join(repo, "hooks"), { recursive: true });
  await writeFile(join(repo, "hooks", `${name}.ts`), body);
}

const PLACER = `import { copyFileSync } from "node:fs";
  const dst = (api) => api.env.HOME + "/.hooked";
  const src = (api) => api.repo + "/hooked.src";
  export function declare(api) { api.declare({ kind: "copy", dst: dst(api), src: src(api) }); }
  export function sync(api) { copyFileSync(src(api), dst(api)); }
  export function verify(api) { api.skip("hooked is current"); }
`;

test("a hook-declared destination enters the manifest and is reaped when the hook stops declaring it", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nhook = [{ name = "placer" }]\n`);
  await sb.write("hooked.src", "generated\n");
  await hookModule(sb.repo, "placer", PLACER);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const dst = join(sb.home, ".hooked");
  expect(await pathExists(dst)).toBe(true);
  expect((await readManifest(sb.env)).some((e) => e.dst === dst)).toBe(true); // boom owns it

  // Drop the hook from the config: what a hook declared is reaped exactly like a core copy.
  await sb.write("boomfile.toml", `[[section]]\nname = "S"\n`);
  sb.clear();
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(dst)).toBe(false);
  expect(sb.out()).toContain("reaped orphan");
});

test("an unloadable hook suppresses reaping instead of deleting what it declared", async () => {
  // The invariant the core resources hold by construction (filesystem.ts pushes to `declared`
  // before it does anything that can fail) and a hook cannot: its declarations live in a module
  // that may not load. Without the guard, `rm hooks/placer.ts` is a DELETE of ~/.hooked on a run
  // that still exits 0 — and the byte-match guard doesn't save it, since a generated file is
  // byte-identical to its source by definition. Realistic triggers: a `use`d module that failed
  // to fetch, a renamed hook file, a partial checkout — all reachable by a scheduled `boom source`.
  const missing = await sandbox(`[[section]]\nname = "S"\nhook = [{ name = "placer" }]\n`);
  const missingDst = join(missing.home, ".hooked");
  await missing.write("hooked.src", "generated\n");
  await hookModule(missing.repo, "placer", PLACER);
  expect(await reconcile("sync", missing.ctx, {})).toBe(0);
  expect(await pathExists(missingDst)).toBe(true);

  await rm(join(missing.repo, "hooks/placer.ts"));
  missing.clear();
  expect(await reconcile("sync", missing.ctx, {})).toBe(0);
  expect(await pathExists(missingDst)).toBe(true);
  expect(missing.out()).not.toContain("reaped");
  // Ownership survives too, or the deletion is merely deferred to the next run.
  expect((await readManifest(missing.env)).some((e) => e.dst === missingDst)).toBe(true);

  // The other bail-out before `declare`: a module that exists but throws on import. It has to be
  // a DIFFERENT hook name than the one that already ran — `import()` caches by resolved path, so
  // rewriting placer.ts in place would re-serve the working module out of the ESM registry and
  // test nothing.
  const broken = await sandbox(`[[section]]\nname = "S"\nhook = [{ name = "placer" }]\n`);
  const brokenDst = join(broken.home, ".hooked");
  await broken.write("hooked.src", "generated\n");
  await hookModule(broken.repo, "placer", PLACER);
  expect(await reconcile("sync", broken.ctx, {})).toBe(0);
  await broken.write("boomfile.toml", `[[section]]\nname = "S"\nhook = [{ name = "wrecked" }]\n`);
  await hookModule(broken.repo, "wrecked", `throw new Error("kaboom");\n`);
  broken.clear();
  expect(await reconcile("sync", broken.ctx, {})).toBe(1); // a failed load is still a failure
  expect(await pathExists(brokenDst)).toBe(true);
  expect(broken.out()).not.toContain("reaped");
});

test("a hook-declared destination does not false-orphan on verify", async () => {
  // `declare` has to run on EVERY verb: reapOrphans compares the prior manifest against
  // ctx.declared on verify too, and an unmatched entry is a warn — which is verify's exit-2
  // tier. Assert the exit code, not just the text; that is the failure mode.
  const sb = await sandbox(`[[section]]\nname = "S"\nhook = [{ name = "placer" }]\n`);
  await sb.write("hooked.src", "generated\n");
  await hookModule(sb.repo, "placer", PLACER);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  sb.clear();
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(sb.out()).not.toContain("no longer declared");
  expect(sb.out()).not.toContain("reaped");
});

test("a hook's journalWrite never displaces outside a mutating sync", async () => {
  // The sharpest edge in the contract: journalWrite calls displace(), and displace with no
  // backupRoot REMOVES the path. journal + backupRoot exist only for a mutating sync, so an
  // unguarded call on a verify or a dry run would delete the hook's target while the run
  // reports changing nothing.
  const sb = await sandbox(`[[section]]\nname = "S"\nhook = [{ name = "eager" }]\n`);
  await hookModule(
    sb.repo,
    "eager",
    `const f = (api) => api.env.HOME + "/.j";
     export function sync(api) { return api.journalWrite("hook", f(api)); }
     export function verify(api) { return api.journalWrite("hook", f(api)); }
    `,
  );
  const f = join(sb.home, ".j");
  await writeFile(f, "original");
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(await readFile(f, "utf8")).toBe("original");
  expect(await reconcile("sync", sb.ctx, { dryRun: true })).toBe(0);
  expect(await readFile(f, "utf8")).toBe("original");
});

test("uninstall opens its own run rather than adopting an interrupted sync's under --resume", async () => {
  // A shared run id would let rollback replay one run that both created and destroyed the same
  // destination — not a state the machine was ever in.
  const sb = await sandbox(`[[section]]\nname = "S"\ncopy = [{ src = "cfg", dst = "~/.cfg" }]\n`);
  await writeFile(join(sb.repo, "cfg"), "v\n");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const syncRun = (await readRun(sb.env))?.runId;

  expect(await reconcile("uninstall", sb.ctx, { resume: true })).toBe(0);
  expect((await readRun(sb.env))?.runId).not.toBe(syncRun);
});

// Both of the cases below survive the rollback removal on purpose. Neither tests undo: one
// asserts the mode of the backup tree `displace()` writes into (the thing that makes an
// overwrite recoverable at all, and which `source --fix` depends on), and the other asserts
// `--resume` reuses an interrupted run. They read journal state via `listRuns`, which is why
// that reader outlived `boom rollback`.

test("the run backup tree is created 0700 — root and run dir alike", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\n`);
  await sb.write(".z", "new");
  await writeFile(join(sb.home, ".z"), "ORIGINAL");
  // Only a run that actually displaces something creates the tree (backupTo makes it lazily),
  // and it can hold a displaced secret at 0600 — so the directories above must not advertise
  // its path at 0755. The run dir is an *intermediate* of that one recursive mkdir, so
  // asserting only the leaf would not prove the fix.
  expect(await reconcile("sync", sb.ctx, { linkMode: "overwrite" })).toBe(0);
  const runId = (await listRuns(sb.env))[0]?.runId ?? "MISSING";
  expect(((await stat(backupsDir(sb.env))).mode & 0o777).toString(8)).toBe("700");
  expect(((await stat(join(backupsDir(sb.env), runId))).mode & 0o777).toString(8)).toBe("700");
});

test("--resume continues the interrupted run rather than opening a second one", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\nlink = [{ src = ".a", dst = "~/.a" }, { src = ".b", dst = "~/.b" }]\n`,
  );
  await sb.write(".a", "a");
  await sb.write(".b", "b");
  // An interrupted (uncommitted) run that recorded ~/.a as done.
  const prior = new Journal(sb.ctx.env, newRunId());
  await prior.done("link", join(sb.home, ".a"), { kind: "remove" });
  prior.close();

  expect(await reconcile("sync", sb.ctx, { resume: true })).toBe(0);
  const runs = await listRuns(sb.ctx.env);
  expect(runs).toHaveLength(1); // reused the interrupted run — did NOT open a second
  expect(runs[0]?.committed).toBe(true); // and it's now completed cleanly
});
