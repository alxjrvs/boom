// composeConfig: the one seam that turns [base, overlays…] into a single ordered,
// origin-stamped section list plus the merged `[vars]` / `[boom]` tables. Asserted on the
// returned Composition, so no reconcile runs and no self-wiring executes.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ComposeNotifier, composeConfig } from "../src/config/compose.ts";
import { loadConfig } from "../src/config/load.ts";
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

test("compose: an overlay's [boom] merges per key over the base's", async () => {
  const repo = await repoWith({
    "boomfile.toml": '[boom]\nskill_on_sync = true\n[[section]]\nname = "x"\n',
    "boomfile.testhost.toml": '[boom]\nupgrade_on_sync = "check"\n',
  });
  const c = await compose(repo);
  expect(c.boom?.skill_on_sync).toBe(true);
  expect(c.boom?.upgrade_on_sync).toBe("check");
});

test("compose: base and overlay sections are stamped with origin + source", async () => {
  const repo = await repoWith({
    "boomfile.toml": '[[section]]\nname = "strong"\n',
    "boomfile.linux.toml": '[[section]]\nname = "os"\n',
    "boomfile.testhost.toml": '[[section]]\nname = "overlaid"\n',
  });
  const c = await compose(repo);
  // The base, then each matching overlay in overlayFiles order — composition order IS
  // precedence order.
  expect(c.sections.map((s) => s.name)).toEqual(["strong", "os", "overlaid"]);
  // Every section's paths resolve against the one repo — there is no per-section origin any
  // more, so `source` (which file declared it) is the only provenance a composed section carries.
  expect(c.sections.find((s) => s.name === "strong")?.source).toBe("boomfile.toml");
  expect(c.sections.find((s) => s.name === "os")?.source).toBe("boomfile.linux.toml");
  expect(c.sections.find((s) => s.name === "overlaid")?.source).toBe("boomfile.testhost.toml");
});

// --- precedence: duplicate destinations resolve last-wins -----------------------------------

test("compose: duplicate dst — the LAST declaration wins and the loser is dropped", async () => {
  const repo = await repoWith({
    "boomfile.linux.toml":
      '[[section]]\nname = "strong"\nlink = [{ src = "repo/zshrc", dst = "~/.zshrc" }]\n',
    "boomfile.toml": '[[section]]\nname = "weak"\nlink = [{ src = "weak/zshrc", dst = "~/.zshrc" }]\n',
  });
  const c = await compose(repo);
  expect(linkDsts(c.sections)).toEqual(["~/.zshrc"]); // exactly one survivor
  expect(c.sections.find((s) => s.name === "strong")?.link?.[0]?.src).toBe("repo/zshrc");
  expect(c.sections.find((s) => s.name === "weak")?.link).toEqual([]);
});

test("compose: duplicate dst across kinds — the stronger layer's `copy` beats a `link`", async () => {
  const repo = await repoWith({
    "boomfile.linux.toml":
      '[[section]]\nname = "strong"\ncopy = [{ src = "repo/npmrc", dst = "~/.npmrc" }]\n',
    "boomfile.toml": '[[section]]\nname = "weak"\nlink = [{ src = "weak/npmrc", dst = "~/.npmrc" }]\n',
  });
  const c = await compose(repo);
  // Both kinds own their destination, so they share one keyspace — same file, same manifest
  // primary key, one winner. (The kinds that own nothing are partitioned out; see below.)
  expect(c.sections.find((s) => s.name === "weak")?.link).toEqual([]);
  expect(c.sections.find((s) => s.name === "strong")?.copy).toHaveLength(1);
});

test("compose: an override emits a note naming both sides", async () => {
  const repo = await repoWith({
    "boomfile.linux.toml":
      '[[section]]\nname = "strong"\ncopy = [{ src = "repo/zshrc", dst = "~/.zshrc" }]\n',
    "boomfile.toml": '[[section]]\nname = "weak"\nlink = [{ src = "weak/zshrc", dst = "~/.zshrc" }]\n',
  });
  const { notify, notes } = notifier();
  await compose(repo, { notify });
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("~/.zshrc");
  expect(notes[0]).toContain("link from boomfile.toml");
  expect(notes[0]).toContain("copy in boomfile.linux.toml");
});

test("compose: a glob `src` is never keyed", async () => {
  const repo = await repoWith({
    "boomfile.linux.toml":
      '[[section]]\nname = "strong"\nlink = [{ src = "repo/*.lua", dst = "~/.config/nvim" }]\n',
    "boomfile.toml": '[[section]]\nname = "weak"\nlink = [{ src = "weak/*.lua", dst = "~/.config/nvim" }]\n',
  });
  const c = await compose(repo);
  // A glob's `dst` is a DIRECTORY the matches land under, not a destination — both survive.
  expect(linkDsts(c.sections)).toEqual(["~/.config/nvim", "~/.config/nvim"]);
});

test("compose: a section emptied by dedupe is kept, so `--only` and `when` still resolve", async () => {
  const repo = await repoWith({
    "boomfile.linux.toml":
      '[[section]]\nname = "strong"\nlink = [{ src = "repo/zshrc", dst = "~/.zshrc" }]\n',
    "boomfile.toml": '[[section]]\nname = "weak"\nlink = [{ src = "weak/zshrc", dst = "~/.zshrc" }]\n',
  });
  const c = await compose(repo);
  expect(c.sections.map((s) => s.name)).toEqual(["weak", "strong"]);
});

// The destructive path the gate exists for: a winner that never runs must not take the
// destination away from a loser that does — nobody would declare it and reapOrphans would delete
// the file. Both directions are asserted, so the gate can't be "fixed" by simply disabling it.
test("compose: a gated-out section is never a dedupe winner", async () => {
  const files = {
    "boomfile.linux.toml":
      '[[section]]\nname = "work"\nwhen = { profile = "work" }\nlink = [{ src = "repo/npmrc", dst = "~/.npmrc" }]\n',
    "boomfile.toml": '[[section]]\nname = "weak"\nlink = [{ src = "weak/npmrc", dst = "~/.npmrc" }]\n',
  };

  const repo = await repoWith(files);
  const off = notifier();
  const without = await compose(repo, { notify: off.notify });
  // No `--profile work`: the gated section never runs, so the module keeps the destination.
  expect(without.sections.find((s) => s.name === "weak")?.link).toHaveLength(1);
  expect(without.sections.find((s) => s.name === "work")?.link).toHaveLength(1);
  expect(off.notes).toEqual([]);

  const on = notifier();
  const active = await compose(repo, { profiles: ["work"], notify: on.notify });
  expect(active.sections.find((s) => s.name === "weak")?.link).toEqual([]);
  expect(active.sections.find((s) => s.name === "work")?.link).toHaveLength(1);
  expect(on.notes).toHaveLength(1);
});

// The same destructive path, reached by kind rather than by gating: `secret` never pushes to
// `ctx.declared`, and `launchd` doesn't either off macOS (ENV pins BOOM_OS=linux here). A winner
// that owns nothing must not evict the loser that does, or reapOrphans deletes the file.
test("compose: a kind that owns no destination never evicts one that does", async () => {
  const repo = await repoWith({
    "boomfile.linux.toml":
      '[[section]]\nname = "strong"\nlaunchd = [{ src = "repo/a.plist", dst = "~/.npmrc" }]\n',
    "boomfile.toml":
      '[[section]]\nname = "weak"\ncopy = [{ src = "weak/netrc", dst = "~/.netrc" }]\nlink = [{ src = "weak/npmrc", dst = "~/.npmrc" }]\n',
  });
  const { notify, notes } = notifier();
  const c = await compose(repo, { notify });
  expect(c.sections.find((s) => s.name === "weak")?.copy).toHaveLength(1);
  expect(c.sections.find((s) => s.name === "weak")?.link).toHaveLength(1);
  expect(notes).toEqual([]);
});

// …but a non-owning kind still resolves against ITSELF, which is the duplicate that actually
// happens: two layers writing the same destination would otherwise both run, the last write
// silently winning after the first had already touched the file.
//
// Ported from `secret` at 0.37. `launchd` off darwin is now the only kind on this side of the
// partition, so it carries both halves of the rule: this one (a non-owning kind beats a
// duplicate of ITSELF) and the one above (it never beats a kind that owns).
test("compose: two off-darwin launchd entries at one dst still resolve last-wins", async () => {
  const repo = await repoWith({
    "boomfile.linux.toml":
      '[[section]]\nname = "strong"\nlaunchd = [{ src = "repo/base.plist", dst = "~/.netrc" }]\n',
    "boomfile.toml": '[[section]]\nname = "weak"\nlaunchd = [{ src = "repo/mod.plist", dst = "~/.netrc" }]\n',
  });
  const { notify, notes } = notifier();
  const c = await compose(repo, { notify });
  expect(c.sections.find((s) => s.name === "weak")?.launchd).toEqual([]);
  expect(c.sections.find((s) => s.name === "strong")?.launchd).toHaveLength(1);
  expect(notes[0]).toContain(
    "~/.netrc — launchd from boomfile.toml overridden by launchd in boomfile.linux.toml",
  );
});
