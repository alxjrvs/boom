// `botu validate` — parse + schema-check the botufile (and every overlay) without
// touching the machine. Lets a dotfiles repo CI-check its config the way `botu apply`
// would load it, but read-only. Exit 0 if every file is valid, 1 otherwise.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, loadConfigFile, resolveConfigDir } from "../config/load.ts";
import type { BotuContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { Reporter } from "../lib/reporter.ts";

// Overlay files are botufile.<os|host|profile>.toml beside the base botufile.toml.
// Validate every one present, regardless of which would activate, so a typo in an
// overlay that only triggers on another host is still caught here.
const OVERLAY_RE = /^botufile\..+\.toml$/;

// Parse + schema-check the base botufile and every overlay, reporting one line each.
// Shared with `botu doctor`'s Config section so the parse check can't drift between the
// two commands (doctor is the same check plus tools/keychain/state; validate is it alone,
// as a read-only CI gate). Reports into the caller's Reporter; drives the caller's exit.
export async function validateConfigFiles(repo: string, report: Reporter): Promise<void> {
  const entries = await readdir(repo);
  const files = [CONFIG_FILE, ...entries.filter((f) => OVERLAY_RE.test(f)).sort()];
  for (const file of files) {
    try {
      const config = await loadConfigFile(join(repo, file));
      report.ok(`${file} — ${config.section.length} section(s)`);
    } catch (e) {
      report.fail((e as Error).message);
    }
  }
}

export async function validateConfig(ctx: BotuContext): Promise<number> {
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env));
  report.header("Validate");

  const repo = await resolveConfigDir(ctx.env, ctx.cwd);
  if (!repo) {
    report.fail("no dotfiles repo found — run `botu source set <owner/repo>`");
    ctx.process.stdout.write("\n");
    return 1;
  }

  await validateConfigFiles(repo, report);

  ctx.process.stdout.write("\n");
  if (report.failures > 0) {
    report.fail(`validate: ${report.failures} invalid file(s)`);
    return 1;
  }
  report.ok("validate: config OK");
  return 0;
}
