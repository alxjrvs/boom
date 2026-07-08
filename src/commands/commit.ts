// `botu commit` — commit any uncommitted local changes in the dotfiles repo directly,
// without running a full apply. The standalone half of apply's --commit mode; both call
// into lib/git.ts's commitLocalChanges so the message/behavior never drifts apart.
import { buildCommand } from "@stricli/core";
import { resolveConfigDir } from "../config/load.ts";
import type { BotuContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { commitLocalChanges } from "../lib/git.ts";
import { Reporter } from "../lib/reporter.ts";

type CommitFlags = { message?: string };

export const commitCommand = buildCommand<CommitFlags, [], BotuContext>({
  docs: { brief: "Commit uncommitted local changes in the dotfiles repo" },
  parameters: {
    flags: {
      message: {
        kind: "parsed",
        parse: (s: string) => s,
        optional: true,
        brief: 'Commit message (default: "botu: local changes")',
      },
    },
    aliases: { m: "message" },
  },
  async func(flags) {
    const report = new Reporter(this.process.stdout, this.process.stderr, colorEnabled(this.env));
    const repo = await resolveConfigDir(this.env, this.cwd);
    if (!repo) {
      report.fail("no dotfiles repo found — run `botu init`");
      this.process.exitCode = 1;
      return;
    }
    const result = commitLocalChanges(repo, this.env, report, flags.message);
    this.process.exitCode = result.ok ? 0 : 1;
  },
});
