// `boom init` — the cold-start wizard that owns the whole config-repo lifecycle in one shot.
// `boom adopt` only drafts a proposal, and `boom source set` only points boom at an *existing*
// remote; nothing chained the full first run. init does: adopt (scaffold the boomfile.toml
// proposal — reused verbatim, never reimplemented), `git init`, commit, optionally create the
// GitHub remote via `gh` and push, then record the breadcrumb so boom is now pointed at the repo.
//
// It is the one mutating command here that can reach *off* the machine (creating a remote), so
// --dry-run is honored strictly (it plans and touches nothing) and an established repo at the
// target is a clean failure, never a silent clobber (adopt's --force philosophy).
import { resolve } from "node:path";
import { writeConfigBreadcrumb } from "../config/load.ts";
import { parseRemoteRef } from "../config/remote.ts";
import type { BoomContext } from "../context.ts";
import { addAll, addRemote, commitStaged, headSha, initRepo, isGitRepo } from "../lib/git.ts";
import { captureArgvAsync, hasCommand } from "../lib/proc.ts";
import { bandsReporter } from "../lib/reporter.ts";
import { adopt } from "./adopt.ts";

export interface InitOptions {
  readonly repo?: string; // owner/repo (or any git remote ref parseRemoteRef accepts)
  readonly dir?: string;
  readonly dryRun?: boolean;
  readonly noPush?: boolean;
  readonly force?: boolean;
}

const COMMIT_MSG = "boom: initial config";

export async function boomInit(ctx: BoomContext, opts: InitOptions): Promise<number> {
  const report = bandsReporter(ctx.process, ctx.env, "init", { setup: "COLD START — OWNING THE LIFECYCLE…" });
  const dir = resolve(ctx.cwd, opts.dir ?? "boom-config");
  const fail = (f: number): string => `init: ${f} failure(s)`;

  // Refuse an already-established repo (has commits) unless forced — creating a remote and
  // pushing over someone's existing history is exactly the clobber this command must never do.
  if (!opts.force && isGitRepo(dir, ctx.env) && headSha(dir, ctx.env) !== undefined) {
    report.fail(`${dir} is already a git repo with commits — pass --force to reuse it, or choose --dir`);
    return report.finish({ ok: "init done", fail });
  }

  // A remote is only formed when the user named one; boom's config model is repo-only, so the
  // breadcrumb (and any push) needs a URL. gh drives remote *creation*; git drives the wiring.
  const remoteUrl = opts.repo ? parseRemoteRef(opts.repo).url : undefined;
  const ghAvailable = hasCommand("gh", ctx.env);

  if (opts.dryRun) {
    report.header("Plan");
    report.plan(`scaffold a boomfile.toml proposal into ${dir} (via adopt)`);
    report.plan(`git init -b main, git add -A, git commit -m "${COMMIT_MSG}"`);
    if (opts.repo && remoteUrl) {
      if (ghAvailable && !opts.noPush) {
        report.plan(`gh repo create ${opts.repo} --private --source=${dir} --remote=origin --push`);
      } else {
        report.plan(`git remote add origin ${remoteUrl}`);
        if (opts.noPush)
          report.plan("(--no-push) skip the push — publish later with git push -u origin main");
        else report.plan("(gh not on PATH) create the repo on your host, then git push -u origin main");
      }
      report.plan(`record the config breadcrumb → boom points at ${dir} (${remoteUrl})`);
    } else {
      report.plan("no <owner/repo> given — no remote created, no breadcrumb recorded");
    }
    return report.finish({ ok: "init: plan only (dry run) — nothing changed", fail });
  }

  // 1. Scaffold the proposal — reuse adopt wholesale (it prints its own report). --force flows
  //    through so a re-init can overwrite an existing boomfile.toml the same way adopt would.
  const scaffold = await adopt(ctx, { out: dir, force: opts.force });
  if (scaffold !== 0) {
    report.header("Config repo");
    report.fail("adopt could not scaffold the proposal (see above) — pass --force to overwrite");
    return report.finish({ ok: "init done", fail });
  }

  report.header("Config repo");

  // 2. git init (skip if already a repo — e.g. --force over a repo with no commits yet).
  if (isGitRepo(dir, ctx.env)) {
    report.skip("already a git repo — leaving it in place");
  } else {
    const r = initRepo(dir, ctx.env);
    if (r.code !== 0) {
      report.fail(`git init failed: ${r.stderr || "unknown error"}`);
      return report.finish({ ok: "init done", fail });
    }
    report.ok(`git init → ${dir}`);
  }

  // 3. Stage + commit. A missing git identity is the common cold-start snag — report it as a
  //    clear, actionable failure rather than letting the raw git error crash out.
  addAll(dir, ctx.env);
  if (headSha(dir, ctx.env) === undefined) {
    const c = commitStaged(dir, COMMIT_MSG, ctx.env);
    if (c.code !== 0) {
      const why = /user\.(name|email)|identity|empty ident/i.test(c.stderr)
        ? "set your git identity first (git config --global user.email …)"
        : c.stderr || "unknown error";
      report.fail(`git commit failed: ${why}`);
      return report.finish({ ok: "init done", fail });
    }
    report.ok(`committed the initial config ("${COMMIT_MSG}")`);
  } else {
    report.skip("repo already has commits — nothing to commit");
  }

  // 4. Remote: create + push via gh when available and asked; otherwise wire the local remote
  //    and leave the manual publish step. No <owner/repo> → local-only, no breadcrumb (repo-only
  //    config needs a remote URL to point at).
  if (!opts.repo || !remoteUrl) {
    report.note(
      "no <owner/repo> given — repo is local-only. Add a remote, then `boom source set <owner/repo>`.",
    );
    return report.finish({ ok: "init: local config repo ready", fail });
  }

  if (ghAvailable && !opts.noPush) {
    const g = await report.spin(`gh repo create ${opts.repo}`, () =>
      captureArgvAsync(
        [
          "gh",
          "repo",
          "create",
          opts.repo as string,
          "--private",
          `--source=${dir}`,
          "--remote=origin",
          "--push",
        ],
        ctx.env,
      ),
    );
    if (g.code !== 0) {
      report.fail(`gh repo create failed: ${g.stderr || "unknown error"}`);
      return report.finish({ ok: "init done", fail });
    }
    report.ok(`created private remote ${opts.repo} and pushed → origin`);
  } else {
    const r = addRemote(dir, "origin", remoteUrl, ctx.env);
    if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
      report.fail(`git remote add origin failed: ${r.stderr || "unknown error"}`);
      return report.finish({ ok: "init done", fail });
    }
    report.ok(`wired origin → ${remoteUrl}`);
    if (opts.noPush) {
      report.note("--no-push: nothing pushed. Publish with: git push -u origin main");
    } else {
      report.note(`gh not on PATH: create ${opts.repo} on your host, then: git push -u origin main`);
    }
  }

  // 5. Record the breadcrumb — boom is now pointed at this repo.
  await writeConfigBreadcrumb(ctx.env, { path: dir, remote: { url: remoteUrl } });
  report.ok("recorded the config breadcrumb — boom now reconciles from this repo");

  return report.finish({ ok: "init: config repo created and linked", fail });
}
