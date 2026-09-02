// Host/OS profiles: section `when` gating (os/host/profile), overlay files, and the [vars] an
// overlay carries. Sandboxed $HOME + repo, driving reconcile() directly.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { reconcile } from "../src/engine/reconcile.ts";
import { pathExists } from "../src/lib/fs.ts";
import { makeSandbox, type Sandbox } from "./support/sandbox.ts";

const sandbox = (boomfile: string, env: Record<string, string> = {}): Promise<Sandbox> =>
  makeSandbox(boomfile, { prefix: "prof", env });

test("section when.os gates by operating system", async () => {
  const sb = await sandbox(
    `[[section]]
name = "mac"
when = { os = "darwin" }
link = [{ src = ".a", dst = "~/.a" }]

[[section]]
name = "linux"
when = { os = "linux" }
link = [{ src = ".b", dst = "~/.b" }]
`,
    { BOOM_OS: "linux" },
  );
  await sb.write(".a", "a");
  await sb.write(".b", "b");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".a"))).toBe(false); // darwin section skipped on linux
  expect(await pathExists(join(sb.home, ".b"))).toBe(true);
});

test("section when.os accepts a list (any-of)", async () => {
  const sb = await sandbox(
    `[[section]]
name = "mac only"
when = { os = ["darwin"] }
link = [{ src = ".a", dst = "~/.a" }]

[[section]]
name = "either"
when = { os = ["darwin", "linux"] }
link = [{ src = ".b", dst = "~/.b" }]
`,
    { BOOM_OS: "linux" },
  );
  await sb.write(".a", "a");
  await sb.write(".b", "b");
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
  const gated = async (os: string, profiles: string[]): Promise<boolean> => {
    const sb = await sandbox(boomfile, { BOOM_OS: os });
    await sb.write(".g", "g");
    await reconcile("sync", sb.ctx, { profiles });
    return pathExists(join(sb.home, ".g"));
  };
  expect(await gated("linux", [])).toBe(false); // neither profile active
  expect(await gated("linux", ["home"])).toBe(true); // any-of satisfied
  expect(await gated("darwin", ["home"])).toBe(false); // axes still AND
});

test("section when.profile runs only when --profile names it", async () => {
  const boomfile = `[[section]]
name = "work"
when = { profile = "work" }
link = [{ src = ".w", dst = "~/.w" }]
`;
  const off = await sandbox(boomfile);
  await off.write(".w", "w");
  await reconcile("sync", off.ctx, {});
  expect(await pathExists(join(off.home, ".w"))).toBe(false); // profile not active

  const on = await sandbox(boomfile);
  await on.write(".w", "w");
  await reconcile("sync", on.ctx, { profiles: ["work"] });
  expect(await pathExists(join(on.home, ".w"))).toBe(true);
});

test("overlay file boomfile.<os>.toml is merged", async () => {
  const sb = await sandbox(`[[section]]\nname = "base"\nlink = [{ src = ".base", dst = "~/.base" }]\n`, {
    BOOM_OS: "darwin",
  });
  await sb.write(".base", "base");
  await sb.write(".mac", "mac");
  await sb.write(
    "boomfile.darwin.toml",
    `[[section]]\nname = "mac-overlay"\nlink = [{ src = ".mac", dst = "~/.mac" }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".base"))).toBe(true);
  expect(await pathExists(join(sb.home, ".mac"))).toBe(true); // from the darwin overlay
});

test("overlays: a vars-only overlay loads and its value wins over the base's", async () => {
  const sb = await sandbox(
    '[vars]\nEMAIL = "base"\n[[section]]\nname = "t"\ntmpl = [{ src = "gitconfig.tmpl", dst = "~/.gitconfig" }]\n',
    { BOOM_HOST: "testhost" },
  );
  // Built as a template literal so it reads as data (see template.test.ts's `ph`).
  await sb.write("gitconfig.tmpl", `email = \${EMAIL}\n`);
  // No [[section]] at all — a hard schema failure before `section` became optional, and its
  // [vars] were dropped on the floor before overlays merged anything but sections.
  await sb.write("boomfile.testhost.toml", '[vars]\nEMAIL = "host"\n');
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await readFile(join(sb.home, ".gitconfig"), "utf8")).toContain("email = host");
});
