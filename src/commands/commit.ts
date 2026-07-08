// `botu commit` — thin wrapper over engine/commit.ts.
import { buildCommand } from "@stricli/core";
import type { BotuContext } from "../context.ts";
import { commitConfigRepo } from "../engine/commit.ts";

type CommitFlags = { message?: string };

export const commitCommand = buildCommand<CommitFlags, [], BotuContext>({
  docs: { brief: "Commit local changes in the config repo" },
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
    this.process.exitCode = await commitConfigRepo(this, flags.message);
  },
});
