// `boom skill` — emit a Claude Code SKILL.md so an agent can drive boom correctly. Prints
// to stdout by default; `--install` writes it to <claude-config>/skills/boom/SKILL.md.
// The doc itself lives in engine/skill.ts (the engine renders it too, for
// `[boom] skill_on_sync` and `boom doctor`); this module is only the Stricli wrapper.
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { installSkill, skillDoc, skillInstallPath } from "../engine/skill.ts";
import { VERSION } from "../lib/version.ts";

export const skillCommand = buildCommand<{ install?: boolean }, [], BoomContext>({
  docs: { brief: "Emit a Claude Code SKILL.md for driving boom (agentic use)" },
  parameters: {
    flags: {
      install: {
        kind: "boolean",
        optional: true,
        brief: "Write it to <claude-config>/skills/boom/SKILL.md instead of stdout",
      },
    },
  },
  async func(flags) {
    const doc = skillDoc(VERSION);
    if (!flags.install) {
      this.process.stdout.write(doc);
      return;
    }
    const file = skillInstallPath(this.env);
    if (!file) {
      this.process.stderr.write(
        "boom: can't resolve the Claude config dir — set HOME or CLAUDE_CONFIG_DIR\n",
      );
      this.process.exitCode = 1;
      return;
    }
    await installSkill({ file, doc });
    this.process.stdout.write(`boom: installed skill → ${file}\n`);
  },
});
