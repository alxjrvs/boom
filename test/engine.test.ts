// M2: the reconcile engine. Calls reconcile() directly against a fully sandboxed
// $HOME + repo and asserts on filesystem state + exit codes — the TS port of the
// bats behavioral oracle (verbs/exit-codes/--only/copy-vs-link/hook).
import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotuContext } from "../src/context.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { linkTarget, pathExists } from "../src/lib/fs.ts";

interface Sandbox {
  readonly home: string;
  readonly repo: string;
  readonly ctx: BotuContext;
  out(): string;
}

async function sandbox(botufile: string): Promise<Sandbox> {
  const base = await mkdtemp(join(tmpdir(), "botu-eng-"));
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
    // Never let a repo's git sync (src/lib/git.ts) see this machine's real system-wide
    // git config (e.g. a global commit hook) — HOME is already sandboxed above.
    GIT_CONFIG_NOSYSTEM: "1",
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
  const ctx = { process: proc, env, cwd: repo } as unknown as BotuContext;
  return { home, repo, ctx, out: () => buf.out };
}

test("link: apply → verify ok → uninstall removes", async () => {
  const sb = await sandbox(`[[section]]\nname = "Shell"\nlink = [{ src = ".zshrc", dst = "~/.zshrc" }]\n`);
  await writeFile(join(sb.repo, ".zshrc"), "z\n");
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(await linkTarget(join(sb.home, ".zshrc"))).toBe(join(sb.repo, ".zshrc"));
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".zshrc"))).toBe(false);
});

test("link: default (no linkMode given) overwrites a foreign file at dst", async () => {
  const sb = await sandbox(`[[section]]\nname = "Shell"\nlink = [{ src = ".zshrc", dst = "~/.zshrc" }]\n`);
  await writeFile(join(sb.repo, ".zshrc"), "z\n");
  await writeFile(join(sb.home, ".zshrc"), "pre-existing, not ours\n");
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(await linkTarget(join(sb.home, ".zshrc"))).toBe(join(sb.repo, ".zshrc"));
  expect(sb.out()).toContain("overwritten");
});

test("link: linkMode skip leaves a foreign file at dst untouched", async () => {
  const sb = await sandbox(`[[section]]\nname = "Shell"\nlink = [{ src = ".zshrc", dst = "~/.zshrc" }]\n`);
  await writeFile(join(sb.repo, ".zshrc"), "z\n");
  await writeFile(join(sb.home, ".zshrc"), "pre-existing, not ours\n");
  expect(await reconcile("apply", sb.ctx, { linkMode: "skip" })).toBe(0);
  expect(await linkTarget(join(sb.home, ".zshrc"))).toBeUndefined();
  expect(await readFile(join(sb.home, ".zshrc"), "utf8")).toBe("pre-existing, not ours\n");
  expect(sb.out()).toContain("exists but is not our symlink — skipped");
});

test("link: --dry-run warns it would overwrite a foreign file, and changes nothing", async () => {
  const sb = await sandbox(`[[section]]\nname = "Shell"\nlink = [{ src = ".zshrc", dst = "~/.zshrc" }]\n`);
  await writeFile(join(sb.repo, ".zshrc"), "z\n");
  await writeFile(join(sb.home, ".zshrc"), "pre-existing, not ours\n");
  expect(await reconcile("apply", sb.ctx, { dryRun: true })).toBe(0);
  expect(sb.out()).toContain("would overwrite an existing file");
  expect(await linkTarget(join(sb.home, ".zshrc"))).toBeUndefined();
  expect(await readFile(join(sb.home, ".zshrc"), "utf8")).toBe("pre-existing, not ours\n");
});

test("link: fix always overwrites a foreign file regardless of linkMode", async () => {
  const sb = await sandbox(`[[section]]\nname = "Shell"\nlink = [{ src = ".zshrc", dst = "~/.zshrc" }]\n`);
  await writeFile(join(sb.repo, ".zshrc"), "z\n");
  await writeFile(join(sb.home, ".zshrc"), "pre-existing, not ours\n");
  expect(await reconcile("fix", sb.ctx, {})).toBe(0);
  expect(await linkTarget(join(sb.home, ".zshrc"))).toBe(join(sb.repo, ".zshrc"));
});

test("verify fails (exit 1) when a link is missing", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nlink = [{ src = ".x", dst = "~/.x" }]\n`);
  await writeFile(join(sb.repo, ".x"), "x");
  expect(await reconcile("verify", sb.ctx, {})).toBe(1);
});

test("dry-run changes nothing", async () => {
  const sb = await sandbox(`[[section]]\nname = "S"\nlink = [{ src = ".z", dst = "~/.z" }]\n`);
  await writeFile(join(sb.repo, ".z"), "z");
  expect(await reconcile("apply", sb.ctx, { dryRun: true })).toBe(0);
  expect(await pathExists(join(sb.home, ".z"))).toBe(false);
});

test("--only runs just the named section", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "a"\nlink = [{ src = ".a", dst = "~/.a" }]\n[[section]]\nname = "b"\nlink = [{ src = ".b", dst = "~/.b" }]\n`,
  );
  await writeFile(join(sb.repo, ".a"), "a");
  await writeFile(join(sb.repo, ".b"), "b");
  await reconcile("apply", sb.ctx, { only: ["a"] });
  expect(await pathExists(join(sb.home, ".a"))).toBe(true);
  expect(await pathExists(join(sb.home, ".b"))).toBe(false);
});

test("copy installs a real file and verifies", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\ncopy = [{ src = "bin/tool", dst = "~/.local/bin/tool", mode = "755" }]\n`,
  );
  await mkdir(join(sb.repo, "bin"), { recursive: true });
  await writeFile(join(sb.repo, "bin/tool"), "#!/bin/sh\n");
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".local/bin/tool"))).toBe(true);
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
});

test("run step fires on apply", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\nrun = [{ on = "apply", cmd = 'touch "$HOME/marker"' }]\n`,
  );
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, "marker"))).toBe(true);
});

test("run step executes in the repo, independent of the invocation cwd", async () => {
  // The step records its own working dir. apply must run it from the dotfiles repo
  // (so e.g. `lefthook install` targets the repo's `.git`), NOT from process.cwd().
  const sb = await sandbox(
    `[[section]]\nname = "S"\nrun = [{ on = "apply", cmd = 'pwd > "$HOME/where"' }]\n`,
  );
  const elsewhere = await mkdtemp(join(tmpdir(), "botu-cwd-"));
  const prev = process.cwd();
  process.chdir(elsewhere); // invoke from somewhere other than the repo
  try {
    expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  } finally {
    process.chdir(prev);
  }
  const where = (await readFile(join(sb.home, "where"), "utf8")).trim();
  // realpath both sides: macOS tmpdir is a /var → /private/var symlink.
  expect(realpathSync(where)).toBe(realpathSync(sb.repo));
  expect(realpathSync(where)).not.toBe(realpathSync(elsewhere));
});

test("run step with on = uninstall fires on uninstall, not apply", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "S"\nrun = [{ on = "uninstall", cmd = 'touch "$HOME/torn-down"' }]\n`,
  );
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, "torn-down"))).toBe(false); // not on apply
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, "torn-down"))).toBe(true); // fires on uninstall
});

test("hook runs a TS resource module with its inputs", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "H"\nhook = [{ name = "greet", with = { who = "world" } }]\n`,
  );
  await mkdir(join(sb.repo, "hooks"), { recursive: true });
  await writeFile(
    join(sb.repo, "hooks/greet.ts"),
    `export function apply(api) { api.ok("hello " + api.with.who); }\n`,
  );
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(sb.out()).toContain("hello world");
});
