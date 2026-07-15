// `boom source status` — the read-only "how does my config clone stand against origin?"
// that the source namespace was missing: to answer "behind / ahead / dirty" you otherwise
// had to run `boom verify` (which also walks the whole machine) or `boom doctor`. Fetches,
// then reports the same drift summary sync's verify path shows, over the shared repoDrift
// helper so the two can't diverge. Exit 0 when fully in sync, 2 on any drift (mirrors
// verify's warning tier), 1 when nothing is linked or git can't answer.
import { requireConfigBreadcrumb } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import { fetchOriginAsync, hasUpstream, repoDrift } from "../lib/git.ts";
import { bandsReporter } from "../lib/reporter.ts";

// Shared verdict wording for the read-only source commands: a warning tier (drift → exit 2) and
// hard failures → exit 1, matching the classic 0/2/1 ladder these commands used before bands.
const DRIFT_MSGS = {
  ok: "in sync with origin",
  warn: (w: number) => `${w} thing(s) need attention`,
  fail: (f: number) => `${f} failure(s)`,
} as const;

export async function statusConfigRepo(ctx: BoomContext): Promise<number> {
  const breadcrumb = await requireConfigBreadcrumb(ctx);
  if (!breadcrumb) return 1;
  const { path, remote } = breadcrumb;
  const report = bandsReporter(ctx.process, ctx.env, "status", { setup: "READING THE OMENS…" });

  report.header("Config repo");
  report.note(`${remote.url} → ${path}`);

  const fetched = await report.spin("checking origin", () => fetchOriginAsync(path, ctx.env));
  if (fetched.code !== 0) {
    report.warn(`could not reach ${remote.url} — reporting local state as-is`);
  }
  if (!hasUpstream(path, ctx.env)) {
    report.ok(`pinned to ${remote.ref ?? "a fixed ref"} — not tracking a moving branch`);
    return report.finish(DRIFT_MSGS);
  }

  const drift = repoDrift(path, ctx.env);
  if (!drift) {
    report.fail("could not determine drift against origin (git rev-list failed)");
    return report.finish(DRIFT_MSGS);
  }
  if (drift.behind > 0) report.warn(`${drift.behind} commit(s) behind origin — boom source to pull`);
  if (drift.unpushed) report.warn("local commit(s) not pushed — boom source push");
  if (drift.dirty) report.warn("uncommitted local changes — boom source diff | push");
  if (drift.behind === 0 && !drift.unpushed && !drift.dirty) report.ok("up to date with origin");

  return report.finish(DRIFT_MSGS);
}
