// M3: the apply transaction — journal, backups, rollback, verify --json, and orphan
// reaping. Each test drives the engine against a fully sandboxed $HOME + repo.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotuContext } from "../src/context.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { rollback } from "../src/engine/rollback.ts";
import { linkTarget, pathExists } from "../src/lib/fs.ts";

interface Sandbox {
  readonly home: string;
  readonly repo: string;
  readonly ctx: BotuContext;
  out(): string;
  clear(): void;
  write(file: string, body: string): Promise<void>;
}

async function sandbox(botufile: string): Promise<Sandbox> {
  const base = await mkdtemp(join(tmpdir(), "botu-tx-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "botufile.toml"), botufile);
  const env: Record<string, string | undefined> = {
    HOME: home,
    XDG_STATE_HOME: join(base, "state"),
    BOTU_CONFIG: repo,
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
    ctx: { process: proc, env, cwd: repo } as unknown as BotuContext,
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
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".z"))).toBe(true);
  expect(await rollback(sb.ctx)).toBe(0);
  expect(await pathExists(join(sb.home, ".z"))).toBe(false);
});

test("rollback restores a file displaced by an overwrite", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\n`);
  await sb.write(".z", "new");
  await writeFile(join(sb.home, ".z"), "ORIGINAL"); // a foreign file in the way
  expect(await reconcile("fix", sb.ctx, {})).toBe(0); // fix overwrites → backs the original up
  expect(await linkTarget(join(sb.home, ".z"))).toBe(join(sb.repo, ".z"));
  expect(await rollback(sb.ctx)).toBe(0);
  expect(await readFile(join(sb.home, ".z"), "utf8")).toBe("ORIGINAL");
});

test("verify --json emits a parseable structured report", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\n`);
  await sb.write(".z", "z");
  await reconcile("apply", sb.ctx, {});
  sb.clear();
  expect(await reconcile("verify", sb.ctx, { json: true })).toBe(0);
  const parsed = JSON.parse(sb.out());
  expect(parsed.ok).toBe(true);
  expect(parsed.failures).toBe(0);
  expect(Array.isArray(parsed.records)).toBe(true);
});

test("--only does NOT reap links owned by other sections", async () => {
  // Regression: a scoped apply only re-declares its named section, so reaping must be
  // skipped and the manifest merged — otherwise every other section looks orphaned.
  const sb = await sandbox(
    `[[section]]\nname = "a"\nlink = [{ src = ".a", dst = "~/.a" }]\n[[section]]\nname = "b"\nlink = [{ src = ".b", dst = "~/.b" }]\n`,
  );
  await sb.write(".a", "a");
  await sb.write(".b", "b");
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".b"))).toBe(true);

  // Re-apply scoped to "a" only. "b" must survive untouched.
  expect(await reconcile("apply", sb.ctx, { only: ["a"] })).toBe(0);
  expect(await linkTarget(join(sb.home, ".a"))).toBe(join(sb.repo, ".a"));
  expect(await linkTarget(join(sb.home, ".b"))).toBe(join(sb.repo, ".b"));

  // And a later full apply still knows it owns "b" (merged manifest), so dropping "b"
  // from the config reaps it as expected — proving the manifest wasn't narrowed.
  await sb.write("botufile.toml", `[[section]]\nname = "a"\nlink = [{ src = ".a", dst = "~/.a" }]\n`);
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".b"))).toBe(false);
});

test("orphan reaping reaps an unmodified copy but leaves a modified one", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\ncopy = [{ src = "u", dst = "~/u" }, { src = "m", dst = "~/m" }]\n`,
  );
  await sb.write("u", "u");
  await sb.write("m", "m");
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  await writeFile(join(sb.home, "m"), "edited by user"); // diverge from source

  await sb.write("botufile.toml", `[[section]]\nname = "S"\n`); // drop both copies
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, "u"))).toBe(false); // unmodified → reaped
  expect(await pathExists(join(sb.home, "m"))).toBe(true); // modified → left in place
});

test("rollback warns about run side effects it cannot reverse", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\nrun = [{ on = "apply", cmd = 'touch "$HOME/marker"' }]\n`,
  );
  await sb.write(".z", "z");
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  sb.clear();
  expect(await rollback(sb.ctx)).toBe(0);
  expect(await pathExists(join(sb.home, ".z"))).toBe(false); // link reversed
  expect(sb.out()).toContain("Not reversible");
  expect(sb.out()).toContain('touch "$HOME/marker"'); // the run is surfaced
});

test("apply --json emits a parseable structured report", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\n`);
  await sb.write(".z", "z");
  expect(await reconcile("apply", sb.ctx, { json: true })).toBe(0);
  const parsed = JSON.parse(sb.out());
  expect(parsed.ok).toBe(true);
  expect(parsed.failures).toBe(0);
  expect(Array.isArray(parsed.records)).toBe(true);
});

test("orphan reaping removes a link dropped from the config", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\nlink = [{ src = ".a", dst = "~/.a" }, { src = ".b", dst = "~/.b" }]\n`,
  );
  await sb.write(".a", "a");
  await sb.write(".b", "b");
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".b"))).toBe(true);

  await sb.write("botufile.toml", `[[section]]\nname = "S"\nlink = [{ src = ".a", dst = "~/.a" }]\n`);
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".a"))).toBe(true);
  expect(await pathExists(join(sb.home, ".b"))).toBe(false); // reaped
});
