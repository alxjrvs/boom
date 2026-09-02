// The `[boom]` table: boom's own self-wiring settings, reconciled like any other resource.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { reconcile } from "../src/engine/reconcile.ts";
import { pathExists } from "../src/lib/fs.ts";
import { makeSandbox, type Sandbox } from "./support/sandbox.ts";

const sandbox = (boomfile: string): Promise<Sandbox> => makeSandbox(boomfile, { prefix: "settings" });

test("[boom] skill_on_sync: sync installs the skill; verify reports it current", async () => {
  const sb = await sandbox(`[boom]\nskill_on_sync = true\n\n[[section]]\nname = "s"\n`);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const skill = join(sb.home, ".claude", "skills", "boom", "SKILL.md");
  expect(await pathExists(skill)).toBe(true);
  expect(await Bun.file(skill).text()).toContain("name: boom");
  expect(await reconcile("verify", sb.ctx, { verbose: true })).toBe(0);
  expect(sb.out()).toContain("skill current"); // verbose: "current" is a quiet skip by default
});

test("[boom] an absent table changes nothing (no self-wiring header)", async () => {
  const sb = await sandbox(`[[section]]\nname = "s"\n`);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(sb.out()).not.toContain("self-wiring");
});
