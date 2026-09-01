// Doc-lint: the three things that must agree with the code and that nothing else enforces —
// the Bun pin (and its types + engines floor), the route map vs. the docs' command list, and
// every hook example export. Each fails loudly rather than letting a doc rot in place.
//
// `cli.ts` is imported first on purpose: the route map has to evaluate fully before catalog
// reads it (catalog.ts reads `routes` lazily for exactly this reason).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import "../src/cli.ts";
import { commandNames } from "../src/commands/catalog.ts";

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
  const wfDir = join(import.meta.dir, "../.github/workflows");
  const workflows = readdirSync(wfDir).filter((f) => f.endsWith(".yml"));
  expect(workflows.length).toBeGreaterThan(0);
  for (const wf of workflows) {
    const text = readFileSync(join(wfDir, wf), "utf8");
    const literal = text.split("\n").filter((l) => /bun-version:\s*\d/.test(l));
    expect(literal, `${wf} should read .bun-version, not pin a literal`).toEqual([]);
  }
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

// SPEC.md enumerates the route map by hand. Set *equality*, not containment, so both directions
// of drift fail: adding a route without naming it in SPEC, and leaving a name in SPEC after its
// route is gone. The <!-- commands:begin/end --> markers give the assertion an unambiguous region
// and are invisible in the rendered markdown output.
test("SPEC.md's command list equals the route map's", () => {
  const spec = readFileSync(join(import.meta.dir, "..", "SPEC.md"), "utf8");
  const region = /<!-- commands:begin -->([\s\S]*?)<!-- commands:end -->/.exec(spec);
  expect(region, "SPEC.md is missing the commands:begin/end markers").not.toBeNull();
  const listed = [...(region?.[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
  expect(new Set(listed)).toEqual(new Set(commandNames()));
  // A duplicate would satisfy the Set comparison while the prose still read wrong.
  expect(listed).toHaveLength(commandNames().length);
});
