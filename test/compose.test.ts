// composeConfig: the one seam that turns [modules…, base, overlays…] into a single ordered,
// origin-stamped section list plus the merged `[vars]` / `[boom]` tables. Asserted on the
// returned Composition, so no reconcile runs and no self-wiring executes.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ComposeNotifier, composeConfig } from "../src/config/compose.ts";
import { BoomConfigError, loadConfig } from "../src/config/load.ts";
import { profileContext } from "../src/config/profile.ts";

// Both overlay names are pinned (BOOM_OS + BOOM_HOST) so overlayFiles is deterministic on any
// machine the suite runs on: boomfile.linux.toml then boomfile.testhost.toml, in that order.
const ENV = { HOME: "/nonexistent-home", BOOM_OS: "linux", BOOM_HOST: "testhost" };

// The `notify` stub is a plain object literal on purpose: widening the port (a `note` alongside
// `warn`) should cost one line here, not an edit to every test in the file.
function notifier(): { notify: ComposeNotifier; warns: string[]; notes: string[] } {
  const warns: string[] = [];
  const notes: string[] = [];
  return {
    notify: { warn: (m: string) => void warns.push(m), note: (m: string) => void notes.push(m) },
    warns,
    notes,
  };
}

async function repoWith(files: Record<string, string>): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "boom-compose-"));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(repo, name, ".."), { recursive: true });
    await writeFile(join(repo, name), body);
  }
  return repo;
}

async function compose(
  repo: string,
  opts: { profiles?: string[]; notify?: ComposeNotifier } = {},
): ReturnType<typeof composeConfig> {
  const config = await loadConfig(repo);
  const pc = profileContext(ENV, opts.profiles ?? []);
  return composeConfig(ENV, repo, config, pc, opts.notify ?? notifier().notify);
}

// Every `link` dst declared anywhere in the composition, in composed order — the shape most of
// the precedence assertions below are about.
function linkDsts(sections: readonly { link?: { dst: string }[] }[]): string[] {
  return sections.flatMap((s) => (s.link ?? []).map((l) => l.dst));
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

// --- precedence: duplicate destinations resolve last-wins -----------------------------------

test("compose: duplicate dst — the LAST declaration wins and the loser is dropped", async () => {
  const repo = await repoWith({
    "boomfile.toml":
      'use = ["./mod"]\n[[section]]\nname = "base"\nlink = [{ src = "repo/zshrc", dst = "~/.zshrc" }]\n',
    "mod/boomfile.toml": '[[section]]\nname = "shared"\nlink = [{ src = "mod/zshrc", dst = "~/.zshrc" }]\n',
  });
  const c = await compose(repo);
  expect(linkDsts(c.sections)).toEqual(["~/.zshrc"]); // exactly one survivor
  expect(c.sections.find((s) => s.name === "base")?.link?.[0]?.src).toBe("repo/zshrc");
  expect(c.sections.find((s) => s.name === "shared")?.link).toEqual([]);
});

test("compose: duplicate dst across kinds — a base `copy` beats a module `link`", async () => {
  const repo = await repoWith({
    "boomfile.toml":
      'use = ["./mod"]\n[[section]]\nname = "base"\ncopy = [{ src = "repo/npmrc", dst = "~/.npmrc" }]\n',
    "mod/boomfile.toml": '[[section]]\nname = "shared"\nlink = [{ src = "mod/npmrc", dst = "~/.npmrc" }]\n',
  });
  const c = await compose(repo);
  // Both kinds own their destination, so they share one keyspace — same file, same manifest
  // primary key, one winner. (The kinds that own nothing are partitioned out; see below.)
  expect(c.sections.find((s) => s.name === "shared")?.link).toEqual([]);
  expect(c.sections.find((s) => s.name === "base")?.copy).toHaveLength(1);
});

test("compose: an override emits a note naming both sides", async () => {
  const repo = await repoWith({
    "boomfile.toml":
      'use = ["./mod"]\n[[section]]\nname = "base"\ncopy = [{ src = "repo/zshrc", dst = "~/.zshrc" }]\n',
    "mod/boomfile.toml": '[[section]]\nname = "shared"\nlink = [{ src = "mod/zshrc", dst = "~/.zshrc" }]\n',
  });
  const { notify, notes } = notifier();
  await compose(repo, { notify });
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("~/.zshrc");
  expect(notes[0]).toContain("link from ./mod");
  expect(notes[0]).toContain("copy in boomfile.toml");
});

test("compose: a glob `src` is never keyed", async () => {
  const repo = await repoWith({
    "boomfile.toml":
      'use = ["./mod"]\n[[section]]\nname = "base"\nlink = [{ src = "repo/*.lua", dst = "~/.config/nvim" }]\n',
    "mod/boomfile.toml":
      '[[section]]\nname = "shared"\nlink = [{ src = "mod/*.lua", dst = "~/.config/nvim" }]\n',
  });
  const c = await compose(repo);
  // A glob's `dst` is a DIRECTORY the matches land under, not a destination — both survive.
  expect(linkDsts(c.sections)).toEqual(["~/.config/nvim", "~/.config/nvim"]);
});

test("compose: a section emptied by dedupe is kept, so `--only` and `when` still resolve", async () => {
  const repo = await repoWith({
    "boomfile.toml":
      'use = ["./mod"]\n[[section]]\nname = "base"\nlink = [{ src = "repo/zshrc", dst = "~/.zshrc" }]\n',
    "mod/boomfile.toml": '[[section]]\nname = "shared"\nlink = [{ src = "mod/zshrc", dst = "~/.zshrc" }]\n',
  });
  const c = await compose(repo);
  expect(c.sections.map((s) => s.name)).toEqual(["shared", "base"]);
});

// The destructive path the gate exists for: a winner that never runs must not take the
// destination away from a loser that does — nobody would declare it and reapOrphans would delete
// the file. Both directions are asserted, so the gate can't be "fixed" by simply disabling it.
test("compose: a gated-out section is never a dedupe winner", async () => {
  const files = {
    "boomfile.toml":
      'use = ["./mod"]\n[[section]]\nname = "work"\nwhen = { profile = "work" }\nlink = [{ src = "repo/npmrc", dst = "~/.npmrc" }]\n',
    "mod/boomfile.toml": '[[section]]\nname = "shared"\nlink = [{ src = "mod/npmrc", dst = "~/.npmrc" }]\n',
  };

  const repo = await repoWith(files);
  const off = notifier();
  const without = await compose(repo, { notify: off.notify });
  // No `--profile work`: the gated section never runs, so the module keeps the destination.
  expect(without.sections.find((s) => s.name === "shared")?.link).toHaveLength(1);
  expect(without.sections.find((s) => s.name === "work")?.link).toHaveLength(1);
  expect(off.notes).toEqual([]);

  const on = notifier();
  const active = await compose(repo, { profiles: ["work"], notify: on.notify });
  expect(active.sections.find((s) => s.name === "shared")?.link).toEqual([]);
  expect(active.sections.find((s) => s.name === "work")?.link).toHaveLength(1);
  expect(on.notes).toHaveLength(1);
});

// The same destructive path, reached by kind rather than by gating: `secret` never pushes to
// `ctx.declared`, and `launchd` doesn't either off macOS (ENV pins BOOM_OS=linux here). A winner
// that owns nothing must not evict the loser that does, or reapOrphans deletes the file.
test("compose: a kind that owns no destination never evicts one that does", async () => {
  const repo = await repoWith({
    "boomfile.toml":
      'use = ["./mod"]\n[[section]]\nname = "base"\nsecret = [{ dst = "~/.netrc", ref = "env:NETRC" }]\nlaunchd = [{ src = "repo/a.plist", dst = "~/.npmrc" }]\n',
    "mod/boomfile.toml":
      '[[section]]\nname = "shared"\ncopy = [{ src = "mod/netrc", dst = "~/.netrc" }]\nlink = [{ src = "mod/npmrc", dst = "~/.npmrc" }]\n',
  });
  const { notify, notes } = notifier();
  const c = await compose(repo, { notify });
  expect(c.sections.find((s) => s.name === "shared")?.copy).toHaveLength(1);
  expect(c.sections.find((s) => s.name === "shared")?.link).toHaveLength(1);
  expect(c.sections.find((s) => s.name === "base")?.secret).toHaveLength(1);
  expect(notes).toEqual([]);
});

// …but a non-owning kind still resolves against ITSELF, which is the duplicate that actually
// happens: two layers rendering the same secret would otherwise both run, last write silently
// winning after the first had already touched the file.
test("compose: two secrets at one dst still resolve last-wins", async () => {
  const repo = await repoWith({
    "boomfile.toml":
      'use = ["./mod"]\n[[section]]\nname = "base"\nsecret = [{ dst = "~/.netrc", ref = "env:BASE" }]\n',
    "mod/boomfile.toml": '[[section]]\nname = "shared"\nsecret = [{ dst = "~/.netrc", ref = "env:MOD" }]\n',
  });
  const { notify, notes } = notifier();
  const c = await compose(repo, { notify });
  expect(c.sections.find((s) => s.name === "shared")?.secret).toEqual([]);
  expect(c.sections.find((s) => s.name === "base")?.secret).toHaveLength(1);
  expect(notes[0]).toContain("~/.netrc — secret from ./mod overridden by secret in boomfile.toml");
});
