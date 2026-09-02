// M1: TOML config schema + loader.
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BoomConfigError, loadConfig, loadOverlayFile, resolveConfigDir } from "../src/config/load.ts";

import { tmp } from "./support/tmp.ts";

const sandbox = (): Promise<string> => tmp("cfg");

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
  // `pgk` is a typo for `pkg`; a non-strict object would silently drop it.
  await writeFile(join(dir, "boomfile.toml"), `[[section]]\nname = "x"\npgk = []\n`);
  await expect(loadConfig(dir)).rejects.toBeInstanceOf(BoomConfigError);
});

test("loadOverlayFile parses an overlay with no [[section]] into an empty list", async () => {
  const dir = await sandbox();
  // A vars-only OVERLAY is legal config. The `[]` default (not a bare v.optional) is what keeps
  // every `config.section.…` reader from having to handle undefined.
  const file = join(dir, "boomfile.testhost.toml");
  await writeFile(file, `[vars]\nEMAIL = "me@example.com"\n`);
  const cfg = await loadOverlayFile(file);
  expect(cfg?.section).toEqual([]);
  expect(cfg?.vars?.EMAIL).toBe("me@example.com");
});

test("loadConfig REJECTS a base boomfile with no [[section]]", async () => {
  const dir = await sandbox();
  // The inverse of the test above, and the one that matters: `section` is optional for an
  // overlay ONLY. A sectionless base is an empty/truncated/commented-out file, not a config
  // that declares nothing — accepting it would let orphan reaping delete every managed
  // destination and exit 0. It must fail at load, naming the key.
  await writeFile(join(dir, "boomfile.toml"), `[vars]\nEMAIL = "me@example.com"\n`);
  await expect(loadConfig(dir)).rejects.toBeInstanceOf(BoomConfigError);
  await expect(loadConfig(dir)).rejects.toThrow(/section/);
});

test("loadConfig REJECTS a zero-byte base boomfile", async () => {
  const dir = await sandbox();
  // The literal shape of the field report: an editor truncates the file mid-write and a
  // scheduled sync lands on it.
  await writeFile(join(dir, "boomfile.toml"), "");
  await expect(loadConfig(dir)).rejects.toThrow(/section/);
});

test("loadOverlayFile returns undefined for an absent overlay", async () => {
  const dir = await sandbox();
  expect(await loadOverlayFile(join(dir, "boomfile.nosuch.toml"))).toBeUndefined();
});

test("loadOverlayFile still rejects a typo'd [[sections]] (the overlay schema stays strict)", async () => {
  const dir = await sandbox();
  const file = join(dir, "boomfile.testhost.toml");
  await writeFile(file, `[[sections]]\nname = "x"\n`);
  await expect(loadOverlayFile(file)).rejects.toBeInstanceOf(BoomConfigError);
});

test("loadConfig still rejects a typo'd [[sections]] even though section is optional", async () => {
  const dir = await sandbox();
  await writeFile(join(dir, "boomfile.toml"), `[[sections]]\nname = "x"\n`);
  await expect(loadConfig(dir)).rejects.toBeInstanceOf(BoomConfigError);
});

test("loadConfig accepts a scalar and a list for every `when` axis", async () => {
  const dir = await sandbox();
  await writeFile(
    join(dir, "boomfile.toml"),
    `[[section]]
name = "scalar"
when = { os = "darwin", host = "laptop", profile = "work" }

[[section]]
name = "list"
when = { os = ["darwin", "linux"], host = ["laptop", "desktop"], profile = ["work", "home"] }
`,
  );
  const cfg = await loadConfig(dir);
  expect(cfg.section[0]?.when).toEqual({ os: "darwin", host: "laptop", profile: "work" });
  expect(cfg.section[1]?.when).toEqual({
    os: ["darwin", "linux"],
    host: ["laptop", "desktop"],
    profile: ["work", "home"],
  });
});

test("loadConfig rejects an unknown os in a `when` list", async () => {
  const dir = await sandbox();
  // Widening the axis to a union must not widen what an os *value* may be.
  await writeFile(join(dir, "boomfile.toml"), `[[section]]\nname = "x"\nwhen = { os = ["darwin", "win"] }\n`);
  await expect(loadConfig(dir)).rejects.toBeInstanceOf(BoomConfigError);
});

test("loadConfig accepts `unless`/`creates` guards on a run step", async () => {
  const dir = await sandbox();
  await writeFile(
    join(dir, "boomfile.toml"),
    `[[section]]\nname = "x"\nrun = [{ on = "sync", cmd = "lefthook install", creates = ".git/hooks/pre-commit", unless = "test -x /usr/bin/true" }]\n`,
  );
  const cfg = await loadConfig(dir);
  expect(cfg.section[0]?.run?.[0]?.creates).toBe(".git/hooks/pre-commit");
  expect(cfg.section[0]?.run?.[0]?.unless).toBe("test -x /usr/bin/true");
});

test("loadConfig rejects `remove_on_uninstall` on brew and on mise, and accepts it on gh", async () => {
  const dir = await sandbox();
  for (const mgr of ["brew", "mise"]) {
    await writeFile(
      join(dir, "boomfile.toml"),
      `[[section]]\nname = "x"\npkg = [{ manager = "${mgr}", remove_on_uninstall = true }]\n`,
    );
    const err = await loadConfig(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoomConfigError);
    expect((err as Error).message).toContain("remove_on_uninstall");
  }
  await writeFile(
    join(dir, "boomfile.toml"),
    `[[section]]
name = "x"
pkg = [
  { manager = "gh", file = "gh.txt", remove_on_uninstall = true },
]
`,
  );
  const cfg = await loadConfig(dir);
  expect(cfg.section[0]?.pkg?.[0]?.remove_on_uninstall).toBe(true);
});

test("loadConfig accepts `cleanup` on brew only, and only with a known mode", async () => {
  const dir = await sandbox();

  // brew-only: the key wraps `brew bundle cleanup`, which the other managers have no
  // equivalent for. Rejecting it loudly beats accepting it and silently doing nothing.
  for (const mgr of ["mise", "gh"]) {
    await writeFile(
      join(dir, "boomfile.toml"),
      `[[section]]\nname = "x"\npkg = [{ manager = "${mgr}", cleanup = "check" }]\n`,
    );
    const err = await loadConfig(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoomConfigError);
    expect((err as Error).message).toContain("cleanup");
  }

  // A typo'd mode must fail at load, not at the point where it would have removed something.
  await writeFile(
    join(dir, "boomfile.toml"),
    `[[section]]\nname = "x"\npkg = [{ manager = "brew", cleanup = "remove" }]\n`,
  );
  expect(await loadConfig(dir).catch((e: unknown) => e)).toBeInstanceOf(BoomConfigError);

  await writeFile(
    join(dir, "boomfile.toml"),
    `[[section]]
name = "x"
pkg = [{ manager = "brew", file = "Brewfile", cleanup = "uninstall" }]
`,
  );
  const cfg = await loadConfig(dir);
  expect(cfg.section[0]?.pkg?.[0]?.cleanup).toBe("uninstall");

  // Absent stays absent — today's behaviour is the default, so no existing boomfile changes.
  await writeFile(
    join(dir, "boomfile.toml"),
    `[[section]]\nname = "x"\npkg = [{ manager = "brew", file = "Brewfile" }]\n`,
  );
  expect((await loadConfig(dir)).section[0]?.pkg?.[0]?.cleanup).toBeUndefined();
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

test('loadConfig accepts manager = "gh"', async () => {
  const dir = await sandbox();
  await writeFile(
    join(dir, "boomfile.toml"),
    `[[section]]\nname = "x"\npkg = [{ manager = "gh", file = "gh-extensions.txt" }]\n`,
  );
  const cfg = await loadConfig(dir);
  expect(cfg.section[0]?.pkg?.[0]?.manager).toBe("gh");
});

test("loadConfig rejects an unknown pkg manager, naming the offending field", async () => {
  const dir = await sandbox();
  await writeFile(join(dir, "boomfile.toml"), `[[section]]\nname = "x"\npkg = [{ manager = "ghx" }]\n`);
  const err = await loadConfig(dir).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BoomConfigError);
  expect((err as Error).message).toContain("section.0.pkg.0.manager");
});

test("resolveConfigDir honors BOOM_CONFIG over a bogus cwd", async () => {
  const dir = await sandbox();
  await writeFile(join(dir, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  expect(await resolveConfigDir({ BOOM_CONFIG: dir }, "/definitely/not/here")).toBe(dir);
});
