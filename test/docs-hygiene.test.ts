// Doc-lint: guards the docs against silently rotting when a verb is renamed. History:
// botu → boom rebrand (apply/verify/fix → sync/verify/repair); the drift verb was renamed
// (repair → fix); then it was dissolved entirely into `boom source --fix`, leaving the
// verb set at sync/verify(/uninstall). These assertions fail loudly if a retired name or a
// dangling man reference creeps back into the shipped metadata.
//
// `cli.ts` is imported first (before `man.ts`) on purpose: catalog→cli→man is a module
// cycle, and loading man.ts first lands cli.ts's route map in a temporal-dead-zone read of
// manCommand. Importing cli.ts first evaluates it fully, exactly as cli-extra.test.ts does.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { app } from "../src/cli.ts";
import { commandNames } from "../src/commands/catalog.ts";
import { manPage } from "../src/commands/man.ts";

// The verb-set marketing strings boom retired: the pre-boom `apply/…` set, and both
// spellings the drift verb had while it was still a verb (`…/repair`, then `…/fix`) before
// it became the `--fix` flag. Match the full slash-joined strings that actually shipped in
// package.json — `fix`/`repair` are too common to grep bare.
const RETIRED = ["apply/verify/fix", "apply / verify / fix", "sync/verify/repair", "sync/verify/fix"];

test("the app route map builds (guards the catalog↔cli↔man import cycle)", () => {
  expect(app).toBeDefined();
});

test("package.json description uses the current verb names, not the retired ones", () => {
  for (const s of RETIRED) expect(pkg.description).not.toContain(s);
  expect(pkg.description).toContain("sync/verify");
  expect(pkg.description).not.toContain("botu");
});

// `.bun-version` is the single Bun pin every workflow reads via setup-bun's `bun-version-file`,
// and it is what `bun build --compile` embeds into every shipped binary. Two things have to agree
// with it or the tree type-checks against a runtime it does not ship:
//   • `@types/bun` — types newer than the runtime describe APIs the binary will not have, which
//     is how `Bun.TOML.stringify` type-checks locally and throws for a user;
//   • `engines.bun` — the floor a contributor is told to build with.
// Checked here rather than trusted, because the whole point of collapsing four literal
// `bun-version:` pins into one file is that the remaining copies are few enough to enforce.
test("the Bun pin, its types, and the engines floor agree", () => {
  const pin = readFileSync(join(import.meta.dir, "../.bun-version"), "utf8").trim();
  expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.devDependencies["@types/bun"]).toBe(pin);
  expect(pkg.engines.bun).toBe(`>=${pin}`);

  // And no workflow may reintroduce a literal pin alongside the file. Asserted on the offending
  // LINES rather than the file text: matching the whole file makes a failure dump the entire
  // workflow into the diff, which buries the one line that actually needs changing.
  for (const wf of ["ci.yml", "release.yml", "pages.yml"]) {
    const text = readFileSync(join(import.meta.dir, "../.github/workflows", wf), "utf8");
    const literal = text.split("\n").filter((l) => /bun-version:\s*\d/.test(l));
    expect(literal, `${wf} should read .bun-version, not pin a literal`).toEqual([]);
  }
});

// The version-lockstep rule in CLAUDE.md has four locations and, until this test, one of them
// was enforced: `Formula/boom.rb` is WRITTEN by the release workflow and cannot drift, the
// `version-guard` CI job checks only that package.json moved one semver step from main, and
// site/index.html was hand-maintained with nothing checking it at all.
//
// That gap has a specific failure mode. site/build.ts injects `pkg.version` into the generated
// doc pages automatically, so after a bump the docs show the new version while the hand-authored
// landing still shows the old one — split-brain on a single deployed site.
//
// Asserted over EVERY semver-shaped string in the file rather than three known line numbers,
// because the point is to catch an occurrence nobody remembered to update — including a new one.
// CLAUDE.md says "the footer version"; there are in fact three (JSON-LD `softwareVersion`, the
// nav badge, the footer), which is exactly why following it by hand left two stale.
test("every version string on the landing page matches package.json", () => {
  const html = readFileSync(join(import.meta.dir, "../site/index.html"), "utf8");
  const found = [...html.matchAll(/\d+\.\d+\.\d+/g)].map((m) => m[0]);
  // Guard the guard: if the landing ever stops naming a version, this must fail loudly rather
  // than pass vacuously over an empty list.
  expect(found.length).toBeGreaterThanOrEqual(3);
  for (const v of found) expect(v).toBe(pkg.version);
});

// CLAUDE.md is the first thing a contributor (and every coding agent) reads, so a verb that
// does not exist there is worse than one in the README: it teaches the wrong model of the
// reconcile loop before anyone opens the code. The verb set is derived from the `Verb` union
// itself rather than hardcoded, so this can only fail when the docs and the type disagree.
test("the prose docs name only verbs that exist in the Verb union", () => {
  const types = readFileSync(join(import.meta.dir, "../src/engine/types.ts"), "utf8");
  const union = /export type Verb =([^;]+);/.exec(types)?.[1];
  expect(union).toBeString();
  const verbs = [...(union ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  expect(verbs).toEqual(["sync", "verify", "uninstall"]);

  // Every slash-joined verb list in the prose docs must be a subset of the real union.
  for (const doc of ["../CLAUDE.md", "../SPEC.md"]) {
    const text = readFileSync(join(import.meta.dir, doc), "utf8");
    for (const m of text.matchAll(/`sync`(?:\/`([a-z]+)`)+/g)) {
      for (const named of [...m[0].matchAll(/`([a-z]+)`/g)].map((x) => x[1])) {
        expect(verbs, `${doc} names a verb that does not exist: ${named}`).toContain(named);
      }
    }
  }
});

test("the man page has no dangling SEE ALSO refs and no stale framing", () => {
  const m = manPage(pkg.version);
  // boom-verify(1) / boom-source(1) man pages were never shipped — don't advertise them.
  expect(m).not.toContain("boom-verify");
  expect(m).not.toContain("boom-source");
  // The rebrand history: "dotfiles + workspace engine" → "workspace manager" →
  // "declarative machine reconciler" → "declarative dev-machine setup". All retired
  // framings must stay out of the man page ("machine reconciler" covers the last one).
  expect(m).not.toContain("dotfiles + workspace engine");
  expect(m).not.toContain("workspace manager");
  expect(m).not.toContain("machine reconciler");
  expect(m).toContain("github.com/alxjrvs/boom");
});

// SPEC.md enumerates the route map by hand. Set *equality*, not containment, so both directions
// of drift fail: adding a route without naming it in SPEC, and leaving a name in SPEC after its
// route is gone. The <!-- commands:begin/end --> markers give the assertion an unambiguous region
// and are invisible in the marked-rendered Pages output.
test("SPEC.md's command list equals the route map's", () => {
  const spec = readFileSync(join(import.meta.dir, "..", "SPEC.md"), "utf8");
  const region = /<!-- commands:begin -->([\s\S]*?)<!-- commands:end -->/.exec(spec);
  expect(region, "SPEC.md is missing the commands:begin/end markers").not.toBeNull();
  const listed = [...(region?.[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
  expect(new Set(listed)).toEqual(new Set(commandNames()));
  // A duplicate would satisfy the Set comparison while the prose still read wrong.
  expect(listed).toHaveLength(commandNames().length);
});
