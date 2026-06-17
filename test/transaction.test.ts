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
