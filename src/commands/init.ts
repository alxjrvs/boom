// `botu init <owner/repo[@ref]>` — clone a remote dotfiles repo (`botu link`) and
// apply it immediately: the one-command fresh-machine bootstrap is now just
// `curl install.sh | sh && botu init owner/repo`. Repo-only: there is no local-path
// variant, and no repo-relative botuinit.sh to generate — botu clones and applies
// itself, so a bootstrap script has nothing left to do that `botu init` doesn't.
import { buildCommand } from "@stricli/core";
import { linkRemoteConfigRepo } from "../config/remote.ts";
import type { BotuContext } from "../context.ts";
import { reconcile } from "../engine/reconcile.ts";

export const initCommand = buildCommand<Record<never, never>, [string], BotuContext>({
  docs: { brief: "Clone a remote dotfiles repo and apply it — one-command bootstrap" },
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
    this.process.exitCode = await reconcile("apply", this, {});
  },
});
