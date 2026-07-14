// The `launchd` resource: link a user-authored LaunchAgent plist into ~/Library/LaunchAgents
// and own its launchctl lifecycle — collapsing the copy-pasted "link the plist, then
// `launchctl unload …; load -w`" boilerplate every macOS agent needs into one stanza. The
// plist link is journaled + manifest-owned (reused from the filesystem resource), so rollback
// and orphan-reaping treat it like any other link; the launchctl load/unload rides on top.
// OS-gated to darwin — a no-op with a note elsewhere, like osx_default.
import { basename, join } from "node:path";
import { detectOs } from "../../config/profile.ts";
import type { Launchd } from "../../config/schema.ts";
import { displayPath, expandTilde, linkTarget, pathExists, rm } from "../../lib/fs.ts";
import { agentLoaded, launchAgentsDir, plistLabel, reloadAgent, unloadAgent } from "../../lib/launchd.ts";
import type { ReconcileCtx } from "../types.ts";
import { applyLink } from "./filesystem.ts";

// The plist's launchd Label, read from the source (repo) copy — the authoritative content,
// available before the link exists. Undefined if the plist has no Label key.
async function labelOf(src: string): Promise<string | undefined> {
  try {
    return plistLabel(await Bun.file(src).text());
  } catch {
    return undefined;
  }
}

export async function reconcileLaunchd(entry: Launchd, ctx: ReconcileCtx): Promise<void> {
  const { report } = ctx;
  const src = join(ctx.repo, entry.src);
  const agents = launchAgentsDir(ctx.env);
  const dst = entry.dst ? expandTilde(entry.dst, ctx.env) : agents ? join(agents, basename(src)) : undefined;
  if (!dst) {
    report.skip(`launchd ${entry.src} — HOME unset, can't resolve LaunchAgents dir`);
    return;
  }
  const disp = displayPath(dst, ctx.env);

  if (detectOs(ctx.env) !== "darwin") {
    // Non-darwin: nothing to load. Report so `verify` doesn't silently pass a macOS-only
    // agent on a Linux box, but don't fail — the section may legitimately target both.
    if (ctx.verb === "verify") report.skip(`${disp} — launchd is macOS-only`);
    return;
  }

  const ours = async (): Promise<boolean> => (await linkTarget(dst)) === src;

  switch (ctx.verb) {
    case "sync": {
      await applyLink(src, dst, disp, ctx.linkMode, ctx);
      ctx.declared.push({ kind: "link", dst, src });
      if (ctx.dryRun || !(await ours())) return; // applyLink already planned/skipped
      if (reloadAgent(dst, ctx.env)) report.ok(`${disp} loaded`);
      else report.fail(`${disp} linked but launchctl load failed`);
      return;
    }
    case "verify": {
      ctx.declared.push({ kind: "link", dst, src });
      if (!(await ours())) {
        report.fail((await pathExists(dst)) ? `${disp} exists but is not our plist` : `${disp} not linked`);
        return;
      }
      const label = await labelOf(src);
      if (label && !agentLoaded(label, ctx.env)) report.warn(`${disp} linked but agent ${label} not loaded`);
      else report.ok(label ? `${disp} (agent ${label} loaded)` : disp);
      return;
    }
    case "uninstall": {
      if (!(await ours())) return;
      if (ctx.dryRun) {
        report.note(`would unload + remove ${disp}`);
        return;
      }
      unloadAgent(dst, ctx.env);
      await rm(dst, { force: true });
      report.ok(`${disp} unloaded + removed`);
      return;
    }
  }
}
