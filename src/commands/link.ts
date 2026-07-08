// `botu link <owner/repo[@ref]>` — clone (or re-clone) a remote dotfiles repo into
// botu's managed cache dir and record it as the active config. Repo-only: config is
// always git-remote-backed, never an arbitrary local folder.
import { buildCommand } from "@stricli/core";
import { linkRemoteConfigRepo } from "../config/remote.ts";
import type { BotuContext } from "../context.ts";

export const linkCommand = buildCommand<Record<never, never>, [string], BotuContext>({
  docs: { brief: "Clone a remote dotfiles repo and record it as the active config" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          parse: (s: string) => s,
          placeholder: "owner/repo[@ref]",
          brief: "remote dotfiles repo: owner/repo, github:owner/repo, or a git URL",
        },
      ],
    },
  },
  async func(_flags, ref) {
    let target: string;
    try {
      target = await linkRemoteConfigRepo(this.env, ref);
    } catch (e) {
      return e as Error;
    }
    this.process.stdout.write(`botu: dotfiles repo cloned → ${target}\n`);
  },
});
