// Layering lint: the module graph points *down*. `lib/` is the foundation, `config/` sits on
// it, `engine/` on both, and `commands/` on top — so an import that runs the other way is a
// defect the compiler will never notice (a cycle still resolves, right up until the module
// that closes it becomes the entry point and reads an export in its temporal dead zone).
// Same shape as the docs-hygiene doc-lint: a static assertion over the source text.
import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name.endsWith(".ts")) out.push(join(e.parentPath, e.name));
  }
  return out;
}

// Any depth of `../` — `engine/resources/*.ts` reaches up twice, `engine/*.ts` once.
const UP_TO_ENGINE = /from "(\.\.\/)+engine\//;
const UP_TO_COMMANDS = /from "(\.\.\/)+commands\//;

test("lib/ and config/ never import from engine/", async () => {
  const offenders: string[] = [];
  for (const dir of ["src/lib", "src/config"]) {
    for (const f of await tsFiles(join(root, dir))) {
      const text = await Bun.file(f).text();
      if (UP_TO_ENGINE.test(text)) offenders.push(f.slice(root.length + 1));
    }
  }
  expect(offenders).toEqual([]);
});

test("engine/ imports commands/ from exactly one file, by design", async () => {
  const offenders: string[] = [];
  for (const f of await tsFiles(join(root, "src/engine"))) {
    const text = await Bun.file(f).text();
    if (UP_TO_COMMANDS.test(text)) offenders.push(f.slice(root.length + 1));
  }
  // Asserted by name, not by count: `engine/skill.ts` reads the command catalog to render the
  // SKILL.md reference, and that one edge is safe only because every hop in the resulting cycle
  // is call-time (see the header of engine/skill.ts). A second exception must fail here and be
  // argued for, not absorbed.
  expect(offenders).toEqual(["src/engine/skill.ts"]);
});

// The regression for that cycle. Must stay a subprocess: `bun test` shares one module registry
// across files and cli.test/cli-extra.test/docs-hygiene.test all sort earlier and statically
// import src/cli.ts, so an in-process import here would find cli.ts already evaluated and pass
// whether or not the hazard exists.
test("engine/settings.ts as the entry point still renders the skill doc (no TDZ)", () => {
  const probe = join(root, "test", "fixtures", "tdz-probe.ts");
  const r = Bun.spawnSync([process.execPath, "run", probe], {
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = r.stderr.toString();
  expect({ code: r.exitCode, stderr }).toEqual({ code: 0, stderr: "" });
  // The rendered command list — proof the cycle was walked, not just that the module loaded.
  expect(r.stdout.toString()).toContain("boom verify");
});
