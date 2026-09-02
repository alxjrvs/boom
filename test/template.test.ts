// The `tmpl` resource: `${NAME}` placeholders rendered from [vars], with an unknown name a hard
// failure rather than an empty string in someone's config. Sandboxed $HOME + repo, driving
// reconcile() directly.
import { expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reconcile } from "../src/engine/reconcile.ts";
import { pathExists } from "../src/lib/fs.ts";
import { makeSandbox, octalMode, type Sandbox } from "./support/sandbox.ts";

// The literal `${NAME}` placeholder the template files carry — built via a template literal
// so it reads as data, not as an accidental un-interpolated string (biome flags a bare
// `"${x}"`; this form is the deliberate placeholder the tmpl resource resolves).
const ph = (name: string): string => `\${${name}}`;

// A boomfile with a top-level [vars] table + a section that renders one template. Written as
// a helper so each tmpl test starts from the same repo (boomfile + conf.tmpl on disk).
async function tmplSandbox(
  vars: string,
  template: string,
  entry = `tmpl = [{ src = "conf.tmpl", dst = "~/.conf" }]`,
): Promise<Sandbox> {
  const sb = await makeSandbox(`[vars]\n${vars}\n\n[[section]]\nname = "t"\n${entry}\n`, { prefix: "tmpl" });
  await sb.write("conf.tmpl", template);
  return sb;
}

test("tmpl: sync renders [vars] into dst, verify passes, uninstall removes it", async () => {
  const sb = await tmplSandbox(`greeting = "howdy"`, `hello ${ph("greeting")}\n`);
  const dst = join(sb.home, ".conf");

  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await readFile(dst, "utf8")).toBe("hello howdy\n"); // var substituted, not left verbatim

  expect(await reconcile("verify", sb.ctx, {})).toBe(0); // rendered file matches → clean
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(dst)).toBe(false);
});

test("tmpl: verify warns when the rendered file is edited or missing", async () => {
  const sb = await tmplSandbox(`greeting = "howdy"`, `hello ${ph("greeting")}\n`);
  const dst = join(sb.home, ".conf");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);

  await writeFile(dst, "hand-edited\n"); // drift
  expect(await reconcile("verify", sb.ctx, {})).toBe(2); // stale → warning tier

  await rm(dst);
  expect(await reconcile("verify", sb.ctx, {})).toBe(2); // missing → warning tier
});

test("tmpl: a missing var is reported, not silently emitted", async () => {
  const sb = await tmplSandbox(`greeting = "howdy"`, `hi ${ph("greeting")}, from ${ph("nickname")}\n`);
  const dst = join(sb.home, ".conf");

  expect(await reconcile("sync", sb.ctx, {})).toBe(1); // undefined ${nickname} → failure
  expect(await pathExists(dst)).toBe(false); // nothing written with a dangling placeholder
  expect(sb.out()).toContain(ph("nickname"));
});

test("tmpl: mode is applied and dryRun writes nothing", async () => {
  const sb = await tmplSandbox(
    `token = "abc"`,
    `k=${ph("token")}\n`,
    `tmpl = [{ src = "conf.tmpl", dst = "~/.conf", mode = "600" }]`,
  );
  const dst = join(sb.home, ".conf");

  expect(await reconcile("sync", sb.ctx, { dryRun: true })).toBe(0);
  expect(await pathExists(dst)).toBe(false); // dry-run plans, never writes

  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await readFile(dst, "utf8")).toBe("k=abc\n");
  expect(await octalMode(dst)).toBe("600");
});

test("tmpl: a prototype-chain name is an undefined var, not Object.prototype's member", async () => {
  // `${toString}` resolved through `name in ctx.vars`, which walks the prototype chain, so it
  // rendered "function toString() { [native code] }" into the destination and reported success —
  // silently defeating this resource's "an unknown ${NAME} is a hard failure" guarantee.
  const sb = await tmplSandbox(`greeting = "howdy"`, `hi ${ph("greeting")} ${ph("toString")}\n`);
  const dst = join(sb.home, ".conf");

  expect(await reconcile("sync", sb.ctx, {})).toBe(1); // undefined var → failure, as for any other name
  expect(await pathExists(dst)).toBe(false); // and nothing is written
  expect(sb.out()).toContain(ph("toString"));
  expect(sb.out()).not.toContain("native code");
});

test("tmpl: mode drift on an unchanged render is seen by verify and repaired by sync", async () => {
  const sb = await tmplSandbox(
    `token = "abc"`,
    `k=${ph("token")}\n`,
    `tmpl = [{ src = "conf.tmpl", dst = "~/.conf", mode = "600" }]`,
  );
  const dst = join(sb.home, ".conf");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await octalMode(dst)).toBe("600");

  await chmod(dst, 0o777); // content still current; only the mode drifted
  expect(await reconcile("verify", sb.ctx, {})).toBe(2); // warning tier — was silently 0
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await octalMode(dst)).toBe("600"); // repaired — the change-gate used to return first
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
});
