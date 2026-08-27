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
