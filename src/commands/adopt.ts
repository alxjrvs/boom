// `boom adopt` — reverse-engineer a boomfile.toml proposal from an already-configured machine
// (packages, tool versions, common dotfiles), so onboarding starts from "review what boom found"
// instead of a blank file. Writes to a fresh directory; never touches the live machine.
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { adopt } from "../engine/adopt.ts";
import { str } from "./flags.ts";

export const adoptCommand = buildCommand<{ out?: string; force?: boolean }, [], BoomContext>({
  docs: { brief: "Reverse-engineer a boomfile.toml proposal from this machine (packages, dotfiles)" },
  parameters: {
    flags: {
      out: {
        kind: "parsed",
        parse: str,
        optional: true,
        brief: "Directory to write the proposal into (default: ./boom-config)",
      },
      force: {
        kind: "boolean",
        optional: true,
        brief: "Overwrite an existing boomfile.toml in the output dir",
      },
    },
  },
  async func(flags) {
    this.process.exitCode = await adopt(this, { out: flags.out, force: flags.force });
  },
});
