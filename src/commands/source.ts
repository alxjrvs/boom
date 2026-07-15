// `boom source` — reconcile your machine from its config source. Bare `boom source` runs
// the sync verb (the route map's `defaultCommand`), the "make it so" reconcile. The
// subcommands operate the source itself — the git remote your machine is reconciled from,
// and its managed clone: `set` points boom at a repo (clone + record, then sync); the rest
// (`diff|push|reset`) operate the clone in place without cd-ing into the cache dir it lives
// in — `push` commits and pushes local edits in one step. A nested route map so the whole
// config-source story is one namespace; each verb is a thin wrapper over its engine module,
// and the clone-operating ones share the single `requireConfigBreadcrumb` guard.
import { buildCommand, buildRouteMap } from "@stricli/core";
import { linkRemoteConfigRepo } from "../config/remote.ts";
import type { BoomContext } from "../context.ts";
import { diffConfigRepo } from "../engine/diff.ts";
import { pushConfigRepo } from "../engine/push.ts";
import { reconcile } from "../engine/reconcile.ts";
import { resetConfigRepo } from "../engine/reset.ts";
import { statusConfigRepo } from "../engine/status.ts";
import { str } from "./flags.ts";
import { syncCommand } from "./reconcile.ts";

// `boom source set <owner/repo>` — the fresh-machine bootstrap
// (`curl install.sh | sh && boom source set owner/repo`) and the way to re-point at a
// different repo later. Clones + records the remote, then syncs it. `--no-sync` records
// only. There is no local-path variant — config is always a git remote (repo-only).
const setCommand = buildCommand<{ sync?: boolean; verbose?: boolean }, [string], BoomContext>({
  docs: { brief: "Point boom at a config repo: clone, record, and sync it" },
  parameters: {
    flags: {
      sync: {
        kind: "boolean",
        optional: true,
        brief: "Reconcile immediately after cloning (default; --no-sync records only)",
      },
      verbose: {
        kind: "boolean",
        optional: true,
        brief: "Show every step of the post-clone sync (default: only changes + attention)",
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          parse: str,
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
    // Sync by default; --no-sync is the record-only path (clone + record, don't reconcile).
    if (flags.sync !== false)
      this.process.exitCode = await reconcile("sync", this, {
        verbose: flags.verbose,
        command: "source",
      });
  },
});

const diffCommand = buildCommand<Record<never, never>, [], BoomContext>({
  docs: { brief: "Show uncommitted local changes in the config repo" },
  parameters: {},
  async func() {
    this.process.exitCode = await diffConfigRepo(this);
  },
});

// `boom source status` — read-only drift against origin (behind/ahead/dirty), the cheap
// "am I in sync?" that doesn't also walk the whole machine like `boom verify` does.
const statusCommand = buildCommand<Record<never, never>, [], BoomContext>({
  docs: { brief: "Show how the config repo stands against origin (behind/ahead/dirty)" },
  parameters: {},
  async func() {
    this.process.exitCode = await statusConfigRepo(this);
  },
});

// `boom source push` — the one "save my edits remotely" command: commit any local changes,
// then push. No separate commit verb; `-m` names the commit message.
const pushCommand = buildCommand<{ message?: string }, [], BoomContext>({
  docs: { brief: "Commit local config-repo changes and push them upstream" },
  parameters: {
    flags: {
      message: {
        kind: "parsed",
        parse: str,
        optional: true,
        brief: 'Commit message for local changes (default: "boom: local changes")',
      },
    },
    aliases: { m: "message" },
  },
  async func(flags) {
    this.process.exitCode = await pushConfigRepo(this, flags.message);
  },
});

const resetCommand = buildCommand<{ force?: boolean; yes?: boolean; dryRun?: boolean }, [], BoomContext>({
  docs: { brief: "Discard local changes in the config repo and reset it to origin" },
  parameters: {
    flags: {
      force: {
        kind: "boolean",
        optional: true,
        brief: "Also discard commits no remote has (refused otherwise)",
      },
      yes: {
        kind: "boolean",
        optional: true,
        brief: "Skip the confirmation prompt for a dirty tree (for scripts/CI)",
      },
      dryRun: { kind: "boolean", optional: true, brief: "Show what would be discarded; change nothing" },
    },
    aliases: { f: "force", y: "yes" },
  },
  async func(flags) {
    this.process.exitCode = await resetConfigRepo(this, {
      force: flags.force,
      yes: flags.yes,
      dryRun: flags.dryRun,
    });
  },
});

export const sourceRouteMap = buildRouteMap({
  routes: {
    // `sync` is the reconcile verb, wired as the route map's `defaultCommand` so bare
    // `boom source` reconciles — and also exposed as the explicit `boom source sync` spelling
    // (the canonical name; bare `boom source` is its shorthand). The rest operate the config repo.
    sync: syncCommand,
    set: setCommand,
    status: statusCommand,
    diff: diffCommand,
    push: pushCommand,
    reset: resetCommand,
  },
  defaultCommand: "sync",
  docs: {
    brief:
      "Reconcile your machine (bare, or `sync`); or operate the config repo (set | status | diff | push | reset)",
  },
});
