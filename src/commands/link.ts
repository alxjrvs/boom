// `botu link [path]` — record your dotfiles repo as the active config (the config
// breadcrumb). The CWD-linking half of `botu init`, without the botuinit.sh bootstrap.

import { buildCommand } from "@stricli/core";
import { linkConfigRepo } from "../config/load.ts";
import type { BotuContext } from "../context.ts";

export const linkCommand = buildCommand<Record<never, never>, [string?], BotuContext>({
  docs: { brief: "Record your dotfiles repo as the active config" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          parse: (s: string) => s,
          optional: true,
          placeholder: "path",
          brief: "dotfiles repo (default: cwd)",
        },
      ],
    },
  },
  async func(_flags, path) {
    let target: string;
    try {
      target = await linkConfigRepo(this.env, path ?? this.cwd);
    } catch (e) {
      return e as Error;
    }
    this.process.stdout.write(`botu: dotfiles repo recorded → ${target}\n`);
  },
});
