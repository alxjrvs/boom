// `boom init` — cold-start the whole config-repo lifecycle in one command: adopt a proposal,
// git init + commit it, create the remote (via gh) and push, and record the breadcrumb so boom
// is pointed at the new repo. The chained superset of `adopt` + `source set`; see engine/init.ts.
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { boomInit } from "../engine/init.ts";
import { str } from "./flags.ts";

export const initCommand = buildCommand<
  { dir?: string; dryRun?: boolean; push?: boolean; force?: boolean },
  [string?],
  BoomContext
>({
  docs: {
    brief: "Cold-start a config repo: adopt, git init + commit, create the remote, and link it",
  },
  parameters: {
    flags: {
      dir: {
        kind: "parsed",
        parse: str,
        optional: true,
        brief: "Directory to create the config repo in (default: ./boom-config)",
      },
      push: {
        kind: "boolean",
        optional: true,
        brief: "Create the remote and push (default; --no-push does everything local-only)",
      },
      dryRun: { kind: "boolean", optional: true, brief: "Show the planned steps; change nothing" },
      force: {
        kind: "boolean",
        optional: true,
        brief: "Reuse the target dir even if it already holds a config/repo",
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          parse: str,
          placeholder: "owner/repo",
          optional: true,
          brief: "GitHub repo to create for the config (omit for a local-only repo)",
        },
      ],
    },
  },
  async func(flags, repo) {
    this.process.exitCode = await boomInit(this, {
      repo,
      dir: flags.dir,
      dryRun: flags.dryRun,
      noPush: flags.push === false,
      force: flags.force,
    });
  },
});
