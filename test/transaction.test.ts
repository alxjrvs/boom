// M3: the sync transaction — journal, backups, rollback, verify --json, and orphan
// reaping. Each test drives the engine against a fully sandboxed $HOME + repo.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoomContext } from "../src/context.ts";
import { listRuns, newRunId } from "../src/engine/journal.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { listRollbacks, rollback } from "../src/engine/rollback.ts";
import { linkTarget, pathExists, stat } from "../src/lib/fs.ts";

interface Sandbox {
  readonly home: string;
  readonly repo: string;
  readonly ctx: BoomContext;
  out(): string;
  clear(): void;
  write(file: string, body: string): Promise<void>;
}

async function sandbox(boomfile: string): Promise<Sandbox> {
  const base = await mkdtemp(join(tmpdir(), "boom-tx-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "boomfile.toml"), boomfile);
  const env: Record<string, string | undefined> = {
    HOME: home,
    XDG_STATE_HOME: join(base, "state"),
    BOOM_CONFIG: repo,
    NO_COLOR: "1",
  };
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
    home,
    repo,
    ctx: { process: proc, env, cwd: repo } as unknown as BoomContext,
    out: () => buf.out,
    clear: () => {
      buf.out = "";
    },
    write: (file, body) => writeFile(join(repo, file), body),
  };
}

test("rollback removes a freshly applied link", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\n`);
  await sb.write(".z", "z");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".z"))).toBe(true);
  expect(await rollback(sb.ctx)).toBe(0);
  expect(await pathExists(join(sb.home, ".z"))).toBe(false);
});

test("newRunId is unique across same-millisecond calls (no journal collision)", () => {
  // Back-to-back runs in one process must never share an id — the millisecond-resolution
  // timestamp alone can collide, which would make two runs write one journal file.
  const ids = Array.from({ length: 50 }, () => newRunId());
  expect(new Set(ids).size).toBe(ids.length);
  // …and still sort chronologically (later call → lexically-greater id).
  expect([...ids].sort()).toEqual(ids);
});

test("listRuns / rollback --list enumerate a committed sync's journal", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\n`);
  await sb.write(".z", "z");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);

  const runs = await listRuns(sb.ctx.env);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.ops).toBeGreaterThanOrEqual(1);
  expect(runs[0]?.committed).toBe(true);

  sb.clear();
  expect(await listRollbacks(sb.ctx)).toBe(0);
  expect(sb.out()).toContain(runs[0]?.runId ?? "MISSING");
  expect(sb.out()).toContain("boom rollback --run-id");
});

test("rollback restores a file displaced by an overwrite", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\n`);
  await sb.write(".z", "new");
  await writeFile(join(sb.home, ".z"), "ORIGINAL"); // a foreign file in the way
  expect(await reconcile("repair", sb.ctx, {})).toBe(0); // repair overwrites → backs the original up
  expect(await linkTarget(join(sb.home, ".z"))).toBe(join(sb.repo, ".z"));
  expect(await rollback(sb.ctx)).toBe(0);
  expect(await readFile(join(sb.home, ".z"), "utf8")).toBe("ORIGINAL");
});

test("glob self-heals a stale non-directory left at `into` (e.g. a link→glob migration)", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\nglob = [{ pattern = "skills/*", into = "~/.claude/skills" }]\n`,
  );
  await mkdir(join(sb.repo, "skills"), { recursive: true });
  await sb.write("skills/a.md", "a");
  await mkdir(join(sb.home, ".claude"), { recursive: true });
  // A broken symlink at the shared `into` dir — mkdir(recursive) throws EEXIST on this
  // (it only no-ops for a real directory), which is exactly the crash being fixed here.
  await symlink(join(sb.repo, "gone"), join(sb.home, ".claude/skills"));
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect((await stat(join(sb.home, ".claude/skills"))).isDirectory()).toBe(true);
  expect(await linkTarget(join(sb.home, ".claude/skills/a.md"))).toBe(join(sb.repo, "skills/a.md"));
});

test("rollback restores a stale `into` symlink a glob sync cleared", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\nglob = [{ pattern = "skills/*", into = "~/.claude/skills" }]\n`,
  );
  await mkdir(join(sb.repo, "skills"), { recursive: true });
  await sb.write("skills/a.md", "a");
  await mkdir(join(sb.home, ".claude"), { recursive: true });
  await symlink(join(sb.repo, "gone"), join(sb.home, ".claude/skills"));
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await rollback(sb.ctx)).toBe(0);
  expect(await linkTarget(join(sb.home, ".claude/skills"))).toBe(join(sb.repo, "gone"));
});

test("verify --json emits a parseable structured report", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\n`);
  await sb.write(".z", "z");
  await reconcile("sync", sb.ctx, {});
  sb.clear();
  expect(await reconcile("verify", sb.ctx, { json: true })).toBe(0);
  const parsed = JSON.parse(sb.out());
  expect(parsed.schemaVersion).toBe(1);
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
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(sb.out()).toContain("already up to date");
  expect(sb.out()).not.toContain("copied");
});

test("rollback warns about run side effects it cannot reverse", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\nrun = [{ on = "sync", cmd = 'touch "$HOME/marker"' }]\n`,
  );
  await sb.write(".z", "z");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  sb.clear();
  expect(await rollback(sb.ctx)).toBe(0);
  expect(await pathExists(join(sb.home, ".z"))).toBe(false); // link reversed
  expect(sb.out()).toContain("Not reversible");
  expect(sb.out()).toContain('touch "$HOME/marker"'); // the run is surfaced
});

test("sync --json emits a parseable structured report", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\n`);
  await sb.write(".z", "z");
  expect(await reconcile("sync", sb.ctx, { json: true })).toBe(0);
  const parsed = JSON.parse(sb.out());
  expect(parsed.schemaVersion).toBe(1);
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

test("rollback restores a link orphaned (and reaped) by the same run", async () => {
  // A reap is a real mutation like any other in the run — it must go through the same
  // journal + backup transaction so `boom rollback` can undo it, not delete outside it.
  const sb = await sandbox(
    `[[section]]\nname = "S"\nlink = [{ src = ".a", dst = "~/.a" }, { src = ".b", dst = "~/.b" }]\n`,
  );
  await sb.write(".a", "a");
  await sb.write(".b", "b");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);

  await sb.write("boomfile.toml", `[[section]]\nname = "S"\nlink = [{ src = ".a", dst = "~/.a" }]\n`);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".b"))).toBe(false); // reaped

  expect(await rollback(sb.ctx)).toBe(0);
  expect(await linkTarget(join(sb.home, ".b"))).toBe(join(sb.repo, ".b")); // restored
});
