// The `pkg` resource end to end. `gh` against a stateful fake so install/list/remove are
// observed, not assumed; and the dry-run rule for an absent manager: a dry run changes nothing
// and cannot install, so a missing CLI is machine state, not a config defect — before this,
// `boom source --dry-run` exited 1 on any box without brew, which is every CI runner and exactly
// where previewing a boomfile is most useful. Sandboxed $HOME + repo, driving reconcile().
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { reconcile } from "../src/engine/reconcile.ts";
import { makeSandbox, type Sandbox } from "./support/sandbox.ts";

// ---------------------------------------------------------------- gh (CLI extensions)

// A stateful fake `gh`: the state file holds one installed `owner/repo` per line, and
// `extension list` renders it the way real gh does when piped — a TSV row per extension whose
// *second* column is the repo ("gh stack\tgithub/gh-stack\tv0"). That shape is the regression
// guard for parsing by shape (the token containing a `/`) rather than by column index. With
// nothing installed real gh prints nothing and exits 1, so the fake does too.
interface GhRig {
  readonly sb: Sandbox;
  installed(): Promise<string>;
  calls(): Promise<string>;
}

async function ghRig(extensions: string, installed = ""): Promise<GhRig> {
  const sb = await makeSandbox(`[[section]]\nname = "P"\npkg = [{ manager = "gh", file = "gh-ext.txt" }]\n`, {
    prefix: "pkg",
  });
  await sb.write("gh-ext.txt", extensions);
  const state = join(sb.base, "gh.state");
  const log = join(sb.base, "gh-calls.log");
  await Bun.write(state, installed);
  await Bun.write(log, "");
  await sb.fakeBin(
    "gh",
    `S="${state}"; L="${log}"
case "$2" in
  list)
    [ -s "$S" ] || exit 1
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      n=$(basename "$r" | sed 's/^gh-//')
      printf 'gh %s\\t%s\\tv0\\n' "$n" "$r"
    done < "$S";;
  install) echo "install $3" >> "$L"; echo "$3" >> "$S";;
  remove) echo "remove $3" >> "$L"; grep -iv "/gh-$3$" "$S" > "$S.tmp"; mv "$S.tmp" "$S";;
esac
exit 0
`,
  );
  return {
    sb,
    installed: async () => (await readFile(state, "utf8")).trim(),
    calls: async () => (await readFile(log, "utf8")).trim(),
  };
}

test("pkg gh: sync installs a missing extension, verify diffs `gh extension list`, uninstall removes it", async () => {
  const { sb, installed } = await ghRig("# extensions\ngithub/gh-stack\n");

  // Nothing installed → verify warns (exit 2) and names the miss owner-qualified.
  expect(await reconcile("verify", sb.ctx, {})).toBe(2);
  expect(sb.out()).toContain("gh missing: github/gh-stack");

  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await installed()).toBe("github/gh-stack");
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);

  // uninstall reverses the declared set, leaving the extension list empty.
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await installed()).toBe("");
});

test("pkg gh: a second sync installs nothing", async () => {
  const { sb, calls } = await ghRig("github/gh-stack\n");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await calls()).toBe("install github/gh-stack");
});

test("pkg gh: a differently-cased declaration still matches an installed extension", async () => {
  // GitHub treats owner/repo case-insensitively; without the `key` hook this reinstalls forever.
  const { sb, calls } = await ghRig("GitHub/gh-Stack\n", "github/gh-stack\n");
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await calls()).toBe("");
});

test("pkg gh: uninstall calls `gh extension remove <name>`, not the owner/repo", async () => {
  const { sb, calls } = await ghRig("github/gh-stack\n", "github/gh-stack\n");

  // --dry-run must print the argv that would really run, not the owner/repo near miss.
  expect(await reconcile("uninstall", sb.ctx, { dryRun: true })).toBe(0);
  expect(sb.out()).toContain("gh extension remove stack");

  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await calls()).toBe("remove stack");
});

test("pkg gh: gh absent from PATH is a reported failure, not a crash", async () => {
  const sb = await makeSandbox(`[[section]]\nname = "P"\npkg = [{ manager = "gh", file = "gh-ext.txt" }]\n`, {
    prefix: "pkg",
    emptyPath: true,
  });
  await sb.write("gh-ext.txt", "github/gh-stack\n");
  expect(await reconcile("verify", sb.ctx, {})).toBe(1);
  expect(sb.out()).toContain("gh not installed");
});

// ---------------------------------------------------------------- an absent manager

async function brewless(): Promise<Sandbox> {
  const sb = await makeSandbox(
    `[[section]]\nname = "pkgs"\npkg = [{ manager = "brew", file = "Brewfile" }]\n`,
    {
      prefix: "pkg",
      emptyPath: true, // hasCommand reports every manager absent, deterministically
    },
  );
  await sb.write("Brewfile", 'brew "jq"\n');
  return sb;
}

test("pkg: a dry run without the manager skips rather than fails", async () => {
  const sb = await brewless();
  expect(await reconcile("sync", sb.ctx, { dryRun: true, verbose: true })).toBe(0);
  expect(sb.out()).toContain("cannot preview its plan"); // verbose: the skip is quiet by default
});

test("pkg: a real sync without the manager still fails, because there it is drift", async () => {
  const sb = await brewless();
  expect(await reconcile("sync", sb.ctx, {})).toBe(1);
});
