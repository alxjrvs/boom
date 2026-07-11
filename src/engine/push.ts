// `boom source push` — commit any local changes in the managed config-repo clone and push
// them upstream, in one step. This is the single "save my edits remotely" command: there's
// no separate commit verb, so you never cd into the cache dir to operate the clone by hand.
// `commitLocalChanges` (commit.ts) is the shared commit half — sync's --commit mode uses
// it too, so the default message/behavior can't drift. A clean tree just pushes whatever
// commits are already ahead of the upstream. Exit 0 on success, 1 otherwise (no config
// linked, or git commit/push failed).
import { requireConfigBreadcrumb } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { push } from "../lib/git.ts";
import { Reporter } from "../lib/reporter.ts";
import { commitLocalChanges } from "./commit.ts";

export async function pushConfigRepo(ctx: BoomContext, message?: string): Promise<number> {
  // One Reporter voice across the source subcommands; hard failures return 1, not 2.
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env));
  const breadcrumb = await requireConfigBreadcrumb(ctx);
  if (!breadcrumb) return 1;

  const commit = commitLocalChanges(breadcrumb.path, ctx.env, message);
  if (commit.kind === "failed") {
    report.fail(`git commit failed: ${commit.stderr}`);
    return 1;
  }
  if (commit.kind === "committed") report.ok(`committed (${commit.message})`);

  // git's own push output is passed through verbatim (its progress/refs go to stderr) —
  // the Reporter owns only boom's status line, mirroring how diff streams the raw git diff.
  const result = push(breadcrumb.path, ctx.env);
  if (result.stdout) ctx.process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) ctx.process.stderr.write(`${result.stderr}\n`);
  if (result.code !== 0) {
    report.fail("git push failed");
    return 1;
  }
  report.ok("pushed");
  return 0;
}
