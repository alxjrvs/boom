// Doc-lint: guards the docs against silently rotting when a verb is renamed. The engine
// was rebranded (botu → boom; apply/verify/fix → sync/verify/repair) and the drift verb
// was later renamed (repair → fix, giving sync/verify/fix); these assertions fail loudly
// if a retired name or a dangling man reference creeps back into the shipped metadata.
//
// `cli.ts` is imported first (before `man.ts`) on purpose: catalog→cli→man is a module
// cycle, and loading man.ts first lands cli.ts's route map in a temporal-dead-zone read of
// manCommand. Importing cli.ts first evaluates it fully, exactly as cli-extra.test.ts does.
import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { app } from "../src/cli.ts";
import { manPage } from "../src/commands/man.ts";

// The verb-set marketing strings boom retired: the pre-boom `apply/…` set, and the
// interim `…/repair` name the drift verb carried before it became `fix`. Match the full
// slash-joined strings that actually shipped in package.json — `fix`/`repair` are too
// common to grep bare.
const RETIRED = ["apply/verify/fix", "apply / verify / fix", "sync/verify/repair"];

test("the app route map builds (guards the catalog↔cli↔man import cycle)", () => {
  expect(app).toBeDefined();
});

test("package.json description uses the current verb names, not the retired ones", () => {
  for (const s of RETIRED) expect(pkg.description).not.toContain(s);
  expect(pkg.description).toContain("sync/verify/fix");
  expect(pkg.description).not.toContain("botu");
});

test("the man page has no dangling SEE ALSO refs and no stale framing", () => {
  const m = manPage(pkg.version);
  // boom-verify(1) / boom-source(1) man pages were never shipped — don't advertise them.
  expect(m).not.toContain("boom-verify");
  expect(m).not.toContain("boom-source");
  // The rebrand: "dotfiles + workspace engine" → "workspace manager".
  expect(m).not.toContain("dotfiles + workspace engine");
  expect(m).toContain("github.com/alxjrvs/boom");
});
