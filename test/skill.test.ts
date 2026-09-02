// `boom skill`: the SKILL.md an agent reads to learn what boom can do, generated from the route
// map — so it can never name a dead verb — and installed under the Claude config dir.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "@stricli/core";
import { app } from "../src/cli.ts";
import { commandList, commandNames } from "../src/commands/catalog.ts";
import { skillDoc } from "../src/engine/skill.ts";
import { fakeCtx } from "./support/ctx.ts";
import { tmp } from "./support/tmp.ts";

test("skill doc is a SKILL.md with frontmatter naming every command", () => {
  const s = skillDoc("9.9.9");
  expect(s).toStartWith("---\nname: boom\n");
  expect(s).toContain("# boom (v9.9.9)"); // version stamped in the heading
  for (const c of commandList()) expect(s).toContain(`\`boom ${c.name}\``);
  // the safety facts an agent must not miss
  expect(s).toContain("--dry-run");
  expect(s).toContain("--json");
  expect(s).toContain("boom uninstall");
});

// The inverse of the case above. skill.ts's command reference is generated from the catalog and
// cannot name a dead verb; the hand-written guidance around it can, and has — so every `boom X`
// the doc mentions is checked against the route map.
test("the skill names no command that isn't a route", () => {
  const s = skillDoc("9.9.9");
  const real = new Set(commandNames());
  const mentioned = [...s.matchAll(/`boom ([a-z][a-z-]*)/g)].map((m) => m[1] as string);
  expect(mentioned.length).toBeGreaterThan(0); // guard the guard
  const ghosts = [...new Set(mentioned)].filter((v) => !real.has(v));
  expect(ghosts).toEqual([]);
});

test("skill --install writes SKILL.md under the Claude config dir", async () => {
  const cfg = await tmp("skill"); // stand in for ~/.claude via CLAUDE_CONFIG_DIR
  const { ctx, out } = fakeCtx({ CLAUDE_CONFIG_DIR: cfg, NO_COLOR: "1" }, cfg);
  await run(app, ["skill", "--install"], ctx);
  const file = join(cfg, "skills", "boom", "SKILL.md");
  expect(await readFile(file, "utf8")).toStartWith("---\nname: boom\n");
  expect(out()).toContain(`installed skill → ${file}`);
});
