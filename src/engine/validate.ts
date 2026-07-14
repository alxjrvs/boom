// Config-file validation: parse + schema-check the boomfile and every overlay without
// touching the machine. The user-facing entry point is `boom doctor --config` (a read-only
// CI gate); this module is just the shared parse used there and in full `boom doctor`, so
// the check can't drift between the two paths.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, loadConfigFile } from "../config/load.ts";
import type { Reporter } from "../lib/reporter.ts";

// Overlay files are boomfile.<os|host|profile>.toml beside the base boomfile.toml.
// Validate every one present, regardless of which would activate, so a typo in an
// overlay that only triggers on another host is still caught here.
const OVERLAY_RE = /^boomfile\..+\.toml$/;

// Parse + schema-check the base boomfile and every overlay, reporting one line each.
// Reports into the caller's Reporter; the caller (doctor) drives the exit code.
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
