// What boom no longer accepts, and how it says so. A retired config key stays *declared* in the
// schema (as `v.never`) so the failure can name the migration — the error text is the contract
// here, not just the reject — and a retired flag fails at the parser, loudly, rather than
// quietly doing something other than asked.
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "@stricli/core";
import { app } from "../src/cli.ts";
import { BoomConfigError, loadConfig } from "../src/config/load.ts";
import { makeSandbox } from "./support/sandbox.ts";
import { tmp } from "./support/tmp.ts";

async function loadError(toml: string): Promise<string> {
  const dir = await tmp("retired");
  await writeFile(join(dir, "boomfile.toml"), toml);
  const err = await loadConfig(dir).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BoomConfigError);
  return (err as Error).message;
}

test("loadConfig rejects the retired `copy.expand` and names `tmpl` in the error", async () => {
  const msg = await loadError(
    `[[section]]\nname = "x"\ncopy = [{ src = "a", dst = "~/a", expand = true }]\n`,
  );
  expect(msg).toContain("section.0.copy.0.expand");
  expect(msg).toMatch(/copy\.expand/); // what to stop doing
  expect(msg).toMatch(/tmpl/); // what to do instead — the migration must be nameable from the error
});

// Every other retired key is the same shape: rejected by name, pointing at the CHANGELOG entry.
for (const [label, toml] of [
  ["secret", '[[section]]\nname = "x"\nsecret = [{ dst = "~/.t", ref = "op://v/i/f" }]\n'],
  ["[boom] schedule", '[boom]\nschedule = [{ cmd = "verify", every = "1h" }]\n[[section]]\nname = "x"\n'],
  ["[boom] sudo_askpass", '[boom]\nsudo_askpass = "op://v/i/f"\n[[section]]\nname = "x"\n'],
] as const) {
  test(`loadConfig rejects the retired \`${label}\` key and names the changelog entry`, async () => {
    expect(await loadError(toml)).toContain("CHANGELOG.md#0390");
  });
}

test('loadConfig rejects `upgrade_on_sync = "auto"`', async () => {
  expect(await loadError('[boom]\nupgrade_on_sync = "auto"\n[[section]]\nname = "x"\n')).toContain(
    "upgrade_on_sync",
  );
});

// Guard against over-rejecting: `v.optional(v.never(…))` must still let an absent key through,
// or retiring one flag would break every plain `copy` in every boomfile.
test("loadConfig still accepts a copy entry without expand", async () => {
  const dir = await tmp("retired");
  await writeFile(
    join(dir, "boomfile.toml"),
    `[[section]]\nname = "x"\ncopy = [{ src = "a", dst = "~/a" }]\n`,
  );
  const cfg = await loadConfig(dir);
  expect(cfg.section[0]?.copy?.[0]?.dst).toBe("~/a");
});

// Failing loudly, like `source --update` did: the parser rejects the flag (stricli reports it on
// stderr) and the verify verb never runs.
test("verify --ci is not a flag any more", async () => {
  const sb = await makeSandbox('[[section]]\nname = "x"\n', { prefix: "retired" });
  await run(app, ["verify", "--ci"], sb.ctx);
  expect(sb.out()).toContain("--ci");
  expect(sb.out()).not.toContain("VERIFY..."); // no verdict band: the verb was never entered
});
