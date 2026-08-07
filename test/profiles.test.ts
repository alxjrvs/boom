// M4: host/OS profiles — section `when` gating (os/host/profile) + overlay files.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoomContext } from "../src/context.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { pathExists } from "../src/lib/fs.ts";

async function sandbox(
  env: Record<string, string | undefined>,
): Promise<{ home: string; repo: string; ctx: BoomContext }> {
  const base = await mkdtemp(join(tmpdir(), "boom-prof-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  const fullEnv = {
    HOME: home,
    XDG_STATE_HOME: join(base, "state"),
    BOOM_CONFIG: repo,
    NO_COLOR: "1",
    ...env,
  };
  const proc = {
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    env: fullEnv,
    exitCode: 0,
  };
  return { home, repo, ctx: { process: proc, env: fullEnv, cwd: repo } as unknown as BoomContext };
}

test("section when.os gates by operating system", async () => {
  const sb = await sandbox({ BOOM_OS: "linux" });
  await writeFile(join(sb.repo, ".a"), "a");
  await writeFile(join(sb.repo, ".b"), "b");
  await writeFile(
    join(sb.repo, "boomfile.toml"),
    `[[section]]
name = "mac"
when = { os = "darwin" }
link = [{ src = ".a", dst = "~/.a" }]

[[section]]
name = "linux"
when = { os = "linux" }
link = [{ src = ".b", dst = "~/.b" }]
`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".a"))).toBe(false); // darwin section skipped on linux
  expect(await pathExists(join(sb.home, ".b"))).toBe(true);
});

test("section when.os accepts a list (any-of)", async () => {
  const sb = await sandbox({ BOOM_OS: "linux" });
  await writeFile(join(sb.repo, ".a"), "a");
  await writeFile(join(sb.repo, ".b"), "b");
  await writeFile(
    join(sb.repo, "boomfile.toml"),
    `[[section]]
name = "mac only"
when = { os = ["darwin"] }
link = [{ src = ".a", dst = "~/.a" }]

[[section]]
name = "either"
when = { os = ["darwin", "linux"] }
link = [{ src = ".b", dst = "~/.b" }]
`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".a"))).toBe(false); // a one-element list still excludes
  expect(await pathExists(join(sb.home, ".b"))).toBe(true); // any-of within the axis
});

test("when axes still AND while a list is any-of", async () => {
  const boomfile = `[[section]]
name = "gated"
when = { os = ["linux"], profile = ["work", "home"] }
link = [{ src = ".g", dst = "~/.g" }]
`;
  const noProfile = await sandbox({ BOOM_OS: "linux" });
  await writeFile(join(noProfile.repo, ".g"), "g");
  await writeFile(join(noProfile.repo, "boomfile.toml"), boomfile);
  await reconcile("sync", noProfile.ctx, {});
  expect(await pathExists(join(noProfile.home, ".g"))).toBe(false); // neither profile active

  const oneProfile = await sandbox({ BOOM_OS: "linux" });
  await writeFile(join(oneProfile.repo, ".g"), "g");
  await writeFile(join(oneProfile.repo, "boomfile.toml"), boomfile);
  await reconcile("sync", oneProfile.ctx, { profiles: ["home"] });
  expect(await pathExists(join(oneProfile.home, ".g"))).toBe(true); // any-of satisfied

  const wrongOs = await sandbox({ BOOM_OS: "darwin" });
  await writeFile(join(wrongOs.repo, ".g"), "g");
  await writeFile(join(wrongOs.repo, "boomfile.toml"), boomfile);
  await reconcile("sync", wrongOs.ctx, { profiles: ["home"] });
  expect(await pathExists(join(wrongOs.home, ".g"))).toBe(false); // axes still AND
});

test("section when.profile runs only when --profile names it", async () => {
  const base = `[[section]]
name = "work"
when = { profile = "work" }
link = [{ src = ".w", dst = "~/.w" }]
`;
  const off = await sandbox({});
  await writeFile(join(off.repo, ".w"), "w");
  await writeFile(join(off.repo, "boomfile.toml"), base);
  await reconcile("sync", off.ctx, {});
  expect(await pathExists(join(off.home, ".w"))).toBe(false); // profile not active

  const on = await sandbox({});
  await writeFile(join(on.repo, ".w"), "w");
  await writeFile(join(on.repo, "boomfile.toml"), base);
  await reconcile("sync", on.ctx, { profiles: ["work"] });
  expect(await pathExists(join(on.home, ".w"))).toBe(true);
});

test("overlay file boomfile.<os>.toml is merged", async () => {
  const sb = await sandbox({ BOOM_OS: "darwin" });
  await writeFile(join(sb.repo, ".base"), "base");
  await writeFile(join(sb.repo, ".mac"), "mac");
  await writeFile(
    join(sb.repo, "boomfile.toml"),
    `[[section]]\nname = "base"\nlink = [{ src = ".base", dst = "~/.base" }]\n`,
  );
  await writeFile(
    join(sb.repo, "boomfile.darwin.toml"),
    `[[section]]\nname = "mac-overlay"\nlink = [{ src = ".mac", dst = "~/.mac" }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".base"))).toBe(true);
  expect(await pathExists(join(sb.home, ".mac"))).toBe(true); // from the darwin overlay
});
