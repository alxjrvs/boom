// `boom validate` — parse + schema-check the boomfile (and every overlay) without
// touching the machine. Lets a dotfiles repo CI-check its config the way `boom source`
// would load it, but read-only. Exit 0 if every file is valid, 1 otherwise.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, loadConfigFile, NO_CONFIG_REPO_MSG, resolveConfigDir } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { Reporter } from "../lib/reporter.ts";

// Overlay files are boomfile.<os|host|profile>.toml beside the base boomfile.toml.
// Validate every one present, regardless of which would activate, so a typo in an
// overlay that only triggers on another host is still caught here.
const OVERLAY_RE = /^boomfile\..+\.toml$/;

// Parse + schema-check the base boomfile and every overlay, reporting one line each.
// Shared with `boom doctor`'s Config section so the parse check can't drift between the
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

export async function validateConfig(ctx: BoomContext): Promise<number> {
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env));
  report.header("Validate");

  const repo = await resolveConfigDir(ctx.env, ctx.cwd);
  if (!repo) {
    report.fail(NO_CONFIG_REPO_MSG);
    ctx.process.stdout.write("\n");
    return 1;
  }

  await validateConfigFiles(repo, report);

  // No warning tier: validate is pass/fail (a file parses or it doesn't).
  return report.finish({
    ok: "validate: config OK",
    fail: (f) => `validate: ${f} invalid file(s)`,
  });
}
