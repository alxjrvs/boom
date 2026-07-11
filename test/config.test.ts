// M1: TOML config schema + loader.
import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoomConfigError, loadConfig, resolveConfigDir } from "../src/config/load.ts";

const sandbox = () => mkdtemp(join(tmpdir(), "boom-cfg-"));

test("loadConfig parses a nested-by-section boomfile.toml", async () => {
  const dir = await sandbox();
  await writeFile(
    join(dir, "boomfile.toml"),
    `[[section]]
name = "Shell"
link = [{ src = ".zshrc", dst = "~/.zshrc" }]
run  = [{ on = "sync", cmd = "lefthook install" }]
`,
  );
  const cfg = await loadConfig(dir);
  expect(cfg.section).toHaveLength(1);
  expect(cfg.section[0]?.name).toBe("Shell");
  expect(cfg.section[0]?.link?.[0]?.dst).toBe("~/.zshrc");
  expect(cfg.section[0]?.run?.[0]?.on).toBe("sync");
});

test("loadConfig rejects a schema-invalid boomfile.toml", async () => {
  const dir = await sandbox();
  // section missing `name`; link missing `dst`.
  await writeFile(join(dir, "boomfile.toml"), `[[section]]\nlink = [{ src = ".zshrc" }]\n`);
  await expect(loadConfig(dir)).rejects.toBeInstanceOf(BoomConfigError);
});

test("loadConfig rejects an unknown key (strict schema catches typos)", async () => {
  const dir = await sandbox();
  // `brewfle` is a typo for `brewfile`; a non-strict object would silently drop it.
  await writeFile(join(dir, "boomfile.toml"), `[[section]]\nname = "x"\nbrewfle = "Brewfile"\n`);
  await expect(loadConfig(dir)).rejects.toBeInstanceOf(BoomConfigError);
});

test("loadConfig rejects a non-octal link mode at the schema boundary", async () => {
  const dir = await sandbox();
  await writeFile(
    join(dir, "boomfile.toml"),
    `[[section]]\nname = "x"\nlink = [{ src = "a", dst = "~/a", mode = "999" }]\n`,
  );
  await expect(loadConfig(dir)).rejects.toBeInstanceOf(BoomConfigError);
});

test("loadConfig accepts a valid octal link mode", async () => {
  const dir = await sandbox();
  await writeFile(
    join(dir, "boomfile.toml"),
    `[[section]]\nname = "x"\nlink = [{ src = "a", dst = "~/a", mode = "0700" }]\n`,
  );
  const cfg = await loadConfig(dir);
  expect(cfg.section[0]?.link?.[0]?.mode).toBe("0700");
});

test("resolveConfigDir honors BOOM_CONFIG over a bogus cwd", async () => {
  const dir = await sandbox();
  await writeFile(join(dir, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  expect(await resolveConfigDir({ BOOM_CONFIG: dir }, "/definitely/not/here")).toBe(dir);
});
