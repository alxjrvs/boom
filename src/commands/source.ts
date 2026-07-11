// `boom source <set|diff|commit|push|reset>` — everything about the config source: the
// git remote your machine is reconciled from, and the managed clone of it. `set` points
// boom at a repo (clone + record, then apply); the rest operate the clone in place without
// cd-ing into the cache dir it lives in. A nested route map so the whole config-source
// story is one namespace; each verb is a thin wrapper over its engine module, and the
// clone-operating ones share the single `requireConfigBreadcrumb` guard.
import { buildCommand, buildRouteMap } from "@stricli/core";
import { linkRemoteConfigRepo } from "../config/remote.ts";
import type { BoomContext } from "../context.ts";
import { commitConfigRepo } from "../engine/commit.ts";
import { diffConfigRepo } from "../engine/diff.ts";
import { pushConfigRepo } from "../engine/push.ts";
import { reconcile } from "../engine/reconcile.ts";
import { resetConfigRepo } from "../engine/reset.ts";

// `boom source set <owner/repo>` — the fresh-machine bootstrap
// (`curl install.sh | sh && boom source set owner/repo`) and the way to re-point at a
// different repo later. Clones + records the remote, then applies it. `--no-apply` records
// only. There is no local-path variant — config is always a git remote (repo-only).
const setCommand = buildCommand<{ apply?: boolean }, [string], BoomContext>({
  docs: { brief: "Point boom at a config repo: clone, record, and apply it" },
  parameters: {
    flags: {
      apply: {
        kind: "boolean",
        optional: true,
        brief: "Reconcile immediately after cloning (default; --no-apply records only)",
      },
    },
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
  async func(flags, ref) {
    let target: string;
    try {
      target = await linkRemoteConfigRepo(this.env, ref);
    } catch (e) {
      return e as Error;
    }
    this.process.stdout.write(`boom: dotfiles repo cloned → ${target}\n`);
    // Apply by default; --no-apply is the record-only path (clone + record, don't reconcile).
    if (flags.apply !== false) this.process.exitCode = await reconcile("apply", this, {});
  },
});

const diffCommand = buildCommand<Record<never, never>, [], BoomContext>({
  docs: { brief: "Show uncommitted local changes in the config repo" },
  parameters: {},
  async func() {
    this.process.exitCode = await diffConfigRepo(this);
  },
});

const commitCommand = buildCommand<{ message?: string }, [], BoomContext>({
  docs: { brief: "Commit local changes in the config repo" },
  parameters: {
    flags: {
      message: {
        kind: "parsed",
        parse: (s: string) => s,
        optional: true,
        brief: 'Commit message (default: "boom: local changes")',
      },
    },
    aliases: { m: "message" },
  },
  async func(flags) {
    this.process.exitCode = await commitConfigRepo(this, flags.message);
  },
});

const pushCommand = buildCommand<Record<never, never>, [], BoomContext>({
  docs: { brief: "Push the config repo's local commits upstream" },
  parameters: {},
  async func() {
    this.process.exitCode = await pushConfigRepo(this);
  },
});

const resetCommand = buildCommand<{ force?: boolean }, [], BoomContext>({
  docs: { brief: "Discard local changes in the config repo and reset it to origin" },
  parameters: {
    flags: {
      force: {
        kind: "boolean",
        optional: true,
        brief: "Also discard commits no remote has (refused otherwise)",
      },
    },
    aliases: { f: "force" },
  },
  async func(flags) {
    this.process.exitCode = await resetConfigRepo(this, { force: flags.force });
  },
});

export const sourceRouteMap = buildRouteMap({
  routes: {
    set: setCommand,
    diff: diffCommand,
    commit: commitCommand,
    push: pushCommand,
    reset: resetCommand,
  },
  docs: { brief: "Set or operate the config repo (set | diff | commit | push | reset)" },
});
