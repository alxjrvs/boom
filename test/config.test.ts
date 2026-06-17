// M1: TOML config schema + loader + the bash→toml migrator.
import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotuConfigError, loadConfig, resolveConfigDir } from "../src/config/load.ts";
import { parseBashBotufile } from "../src/config/migrate.ts";

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

test("parseBashBotufile converts every core primitive", () => {
  const { config } = parseBashBotufile(
    `section "Shell"
link .zshrc ~/.zshrc
link --mode 600 ssh/config ~/.ssh/config
glob 'zsh/[0-9]*.zsh' ~/.config/zsh/
brewfile Brewfile
mise_install
on apply lefthook install
hook claude_statusline repo=github.com/alxjrvs/claude-statusline`,
  );
  const s = config.section[0];
  expect(s?.name).toBe("Shell");
  expect(s?.link).toHaveLength(2);
  expect(s?.link?.[1]?.mode).toBe("600");
  expect(s?.glob?.[0]?.pattern).toBe("zsh/[0-9]*.zsh");
  expect(s?.brewfile).toBe("Brewfile");
  expect(s?.mise).toBe(true);
  expect(s?.run?.[0]).toEqual({ on: "apply", cmd: "lefthook install" });
  expect(s?.hook?.[0]?.with?.repo).toBe("github.com/alxjrvs/claude-statusline");
});
