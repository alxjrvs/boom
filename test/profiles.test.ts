// M4: host/OS profiles — section `when` gating (os/host/profile) + overlay files.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotuContext } from "../src/context.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { pathExists } from "../src/lib/fs.ts";

async function sandbox(
  env: Record<string, string | undefined>,
): Promise<{ home: string; repo: string; ctx: BotuContext }> {
  const base = await mkdtemp(join(tmpdir(), "botu-prof-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  const fullEnv = {
    HOME: home,
    XDG_STATE_HOME: join(base, "state"),
    BOTU_CONFIG: repo,
    NO_COLOR: "1",
    ...env,
  };
  const proc = {
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    env: fullEnv,
    exitCode: 0,
  };
  return { home, repo, ctx: { process: proc, env: fullEnv, cwd: repo } as unknown as BotuContext };
}

test("section when.os gates by operating system", async () => {
  const sb = await sandbox({ BOTU_OS: "linux" });
  await writeFile(join(sb.repo, ".a"), "a");
  await writeFile(join(sb.repo, ".b"), "b");
  await writeFile(
    join(sb.repo, "botufile.toml"),
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
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".a"))).toBe(false); // darwin section skipped on linux
  expect(await pathExists(join(sb.home, ".b"))).toBe(true);
});

test("section when.profile runs only when --profile names it", async () => {
  const base = `[[section]]
name = "work"
when = { profile = "work" }
link = [{ src = ".w", dst = "~/.w" }]
`;
  const off = await sandbox({});
  await writeFile(join(off.repo, ".w"), "w");
  await writeFile(join(off.repo, "botufile.toml"), base);
  await reconcile("apply", off.ctx, {});
  expect(await pathExists(join(off.home, ".w"))).toBe(false); // profile not active

  const on = await sandbox({});
  await writeFile(join(on.repo, ".w"), "w");
  await writeFile(join(on.repo, "botufile.toml"), base);
  await reconcile("apply", on.ctx, { profiles: ["work"] });
  expect(await pathExists(join(on.home, ".w"))).toBe(true);
});

test("overlay file botufile.<os>.toml is merged", async () => {
  const sb = await sandbox({ BOTU_OS: "darwin" });
  await writeFile(join(sb.repo, ".base"), "base");
  await writeFile(join(sb.repo, ".mac"), "mac");
  await writeFile(
    join(sb.repo, "botufile.toml"),
    `[[section]]\nname = "base"\nlink = [{ src = ".base", dst = "~/.base" }]\n`,
  );
  await writeFile(
    join(sb.repo, "botufile.darwin.toml"),
    `[[section]]\nname = "mac-overlay"\nlink = [{ src = ".mac", dst = "~/.mac" }]\n`,
  );
  expect(await reconcile("apply", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".base"))).toBe(true);
  expect(await pathExists(join(sb.home, ".mac"))).toBe(true); // from the darwin overlay
});
