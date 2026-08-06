// composeConfig: the one seam that turns [modules…, base, overlays…] into a single ordered,
// origin-stamped section list plus the merged `[vars]` / `[boom]` tables. Asserted on the
// returned Composition, so no reconcile runs and no self-wiring executes.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeConfig } from "../src/config/compose.ts";
import { BoomConfigError, loadConfig } from "../src/config/load.ts";
import { profileContext } from "../src/config/profile.ts";

// Both overlay names are pinned (BOOM_OS + BOOM_HOST) so overlayFiles is deterministic on any
// machine the suite runs on: boomfile.linux.toml then boomfile.testhost.toml, in that order.
const ENV = { HOME: "/nonexistent-home", BOOM_OS: "linux", BOOM_HOST: "testhost" };

// The `notify` stub is a plain object literal on purpose: widening the port (a `note` alongside
// `warn`) should cost one line here, not an edit to every test in the file.
function notifier(): { notify: { warn(m: string): void }; warns: string[] } {
  const warns: string[] = [];
  return { notify: { warn: (m: string) => void warns.push(m) }, warns };
}

async function repoWith(files: Record<string, string>): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "boom-compose-"));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(repo, name, ".."), { recursive: true });
    await writeFile(join(repo, name), body);
  }
  return repo;
}

async function compose(repo: string): ReturnType<typeof composeConfig> {
  const config = await loadConfig(repo);
  return composeConfig(ENV, repo, config, profileContext(ENV, []), notifier().notify);
}

test("compose: an overlay's [vars] win over the base's", async () => {
  const repo = await repoWith({
    "boomfile.toml": '[vars]\nEMAIL = "base"\nNAME = "base"\n[[section]]\nname = "x"\n',
    "boomfile.testhost.toml": '[vars]\nEMAIL = "host"\n',
  });
  const c = await compose(repo);
  expect(c.vars.EMAIL).toBe("host");
  expect(c.vars.NAME).toBe("base"); // untouched keys survive the merge
});

test("compose: a module's [vars] are the weakest layer", async () => {
  const repo = await repoWith({
    "boomfile.toml": 'use = ["./mod"]\n[vars]\nEMAIL = "base"\n[[section]]\nname = "x"\n',
    "mod/boomfile.toml": '[vars]\nEMAIL = "mod"\nONLY_MOD = "mod"\n[[section]]\nname = "m"\n',
  });
  const c = await compose(repo);
  expect(c.vars.EMAIL).toBe("base");
  expect(c.vars.ONLY_MOD).toBe("mod"); // but a module still *contributes* names
});

test("compose: an overlay's [boom] merges per key over the base's", async () => {
  const repo = await repoWith({
    "boomfile.toml": '[boom]\nskill_on_sync = true\n[[section]]\nname = "x"\n',
    "boomfile.testhost.toml": '[boom]\nupgrade_on_sync = "check"\n',
  });
  const c = await compose(repo);
  expect(c.boom?.skill_on_sync).toBe(true);
  expect(c.boom?.upgrade_on_sync).toBe("check");
});

test("compose: an overlay's [boom].schedule REPLACES the base's array", async () => {
  const repo = await repoWith({
    "boomfile.toml":
      '[boom]\nschedule = [{ cmd = "verify", every = "15m" }, { cmd = "code fetch", every = "1h" }]\n[[section]]\nname = "x"\n',
    "boomfile.testhost.toml": '[boom]\nschedule = [{ cmd = "verify", every = "1h" }]\n',
  });
  const c = await compose(repo);
  // A shallow last-wins merge on an array key is a replace, not an append — correct, surprising,
  // and the reason SPEC.md says so out loud.
  expect(c.boom?.schedule).toHaveLength(1);
  expect(c.boom?.schedule?.[0]?.every).toBe("1h");
});

test("compose: `use` in an overlay is a named error, never a silent drop", async () => {
  const repo = await repoWith({
    "boomfile.toml": '[[section]]\nname = "x"\n',
    "boomfile.testhost.toml": 'use = ["./mod"]\n',
    "mod/boomfile.toml": '[[section]]\nname = "m"\n',
  });
  const err = await compose(repo).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(BoomConfigError);
  expect(err?.message).toContain("boomfile.testhost.toml");
  expect(err?.message).toContain("`use`");
});

test("compose: base, overlay and module sections are stamped with origin + source", async () => {
  const repo = await repoWith({
    "boomfile.toml": 'use = ["./mod"]\n[[section]]\nname = "base"\n',
    "boomfile.testhost.toml": '[[section]]\nname = "overlaid"\n',
    "mod/boomfile.toml": '[[section]]\nname = "shared"\n',
  });
  const c = await compose(repo);
  // Modules first, then the base, then overlays — composition order IS precedence order.
  expect(c.sections.map((s) => s.name)).toEqual(["shared", "base", "overlaid"]);
  expect(c.sections.find((s) => s.name === "shared")?.origin).toBe(join(repo, "mod"));
  expect(c.sections.find((s) => s.name === "shared")?.source).toBe("./mod");
  expect(c.sections.filter((s) => s.name !== "shared").every((s) => s.origin === repo)).toBe(true);
  expect(c.sections.find((s) => s.name === "base")?.source).toBe("boomfile.toml");
  expect(c.sections.find((s) => s.name === "overlaid")?.source).toBe("boomfile.testhost.toml");
});

test("compose: an unresolvable module warns through `notify` and is skipped", async () => {
  const repo = await repoWith({ "boomfile.toml": 'use = ["./missing"]\n[[section]]\nname = "x"\n' });
  const { notify, warns } = notifier();
  const config = await loadConfig(repo);
  const c = await composeConfig(ENV, repo, config, profileContext(ENV, []), notify);
  expect(c.sections).toHaveLength(1);
  expect(warns.join("\n")).toContain("module ./missing");
});
