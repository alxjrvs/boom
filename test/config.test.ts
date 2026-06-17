// M1: TOML config schema + loader.
import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotuConfigError, loadConfig, resolveConfigDir } from "../src/config/load.ts";

const sandbox = () => mkdtemp(join(tmpdir(), "botu-cfg-"));

test("loadConfig parses a nested-by-section botufile.toml", async () => {
  const dir = await sandbox();
  await writeFile(
    join(dir, "botufile.toml"),
    `[[section]]
name = "Shell"
link = [{ src = ".zshrc", dst = "~/.zshrc" }]
run  = [{ on = "apply", cmd = "lefthook install" }]
`,
  );
  const cfg = await loadConfig(dir);
  expect(cfg.section).toHaveLength(1);
  expect(cfg.section[0]?.name).toBe("Shell");
  expect(cfg.section[0]?.link?.[0]?.dst).toBe("~/.zshrc");
  expect(cfg.section[0]?.run?.[0]?.on).toBe("apply");
});

test("loadConfig rejects a schema-invalid botufile.toml", async () => {
  const dir = await sandbox();
  // section missing `name`; link missing `dst`.
  await writeFile(join(dir, "botufile.toml"), `[[section]]\nlink = [{ src = ".zshrc" }]\n`);
  await expect(loadConfig(dir)).rejects.toBeInstanceOf(BotuConfigError);
});

test("resolveConfigDir honors BOTU_CONFIG over a bogus cwd", async () => {
  const dir = await sandbox();
  await writeFile(join(dir, "botufile.toml"), `[[section]]\nname = "x"\n`);
  expect(await resolveConfigDir({ BOTU_CONFIG: dir }, "/definitely/not/here")).toBe(dir);
});
