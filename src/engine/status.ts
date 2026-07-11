// `boom source status` — the read-only "how does my config clone stand against origin?"
// that the source namespace was missing: to answer "behind / ahead / dirty" you otherwise
// had to run `boom verify` (which also walks the whole machine) or `boom doctor`. Fetches,
// then reports the same drift summary sync's verify path shows, over the shared repoDrift
// helper so the two can't diverge. Exit 0 when fully in sync, 2 on any drift (mirrors
// verify's warning tier), 1 when nothing is linked or git can't answer.
import { requireConfigBreadcrumb } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { fetchOrigin, hasUpstream, repoDrift } from "../lib/git.ts";
import { Reporter } from "../lib/reporter.ts";

export async function statusConfigRepo(ctx: BoomContext): Promise<number> {
  const breadcrumb = await requireConfigBreadcrumb(ctx);
  if (!breadcrumb) return 1;
  const { path, remote } = breadcrumb;
  const report = new Reporter(ctx.process.stdout, ctx.process.stderr, colorEnabled(ctx.env));

  report.header("Config repo");
  report.note(`${remote.url} → ${path}`);

  if (fetchOrigin(path, ctx.env).code !== 0) {
    report.warn(`could not reach ${remote.url} — reporting local state as-is`);
  }
  if (!hasUpstream(path, ctx.env)) {
    report.ok(`pinned to ${remote.ref ?? "a fixed ref"} — not tracking a moving branch`);
    ctx.process.stdout.write("\n");
    return 0;
  }

  const drift = repoDrift(path, ctx.env);
  if (!drift) {
    report.fail("could not determine drift against origin (git rev-list failed)");
    ctx.process.stdout.write("\n");
    return 1;
  }
  if (drift.behind > 0) report.warn(`${drift.behind} commit(s) behind origin — boom source to pull`);
  if (drift.unpushed) report.warn("local commit(s) not pushed — boom source push");
  if (drift.dirty) report.warn("uncommitted local changes — boom source diff | push");
  const clean = drift.behind === 0 && !drift.unpushed && !drift.dirty;
  if (clean) report.ok("up to date with origin");

  ctx.process.stdout.write("\n");
  return clean ? 0 : 2;
}
