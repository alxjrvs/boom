// `boom source` — reconcile your machine from its config source. Bare `boom source` runs
// the sync verb (the route map's `defaultCommand`), the "make it so" reconcile. The one
// subcommand operates the source itself — the git remote your machine is reconciled from,
// and its managed clone: `set` points boom at a repo (clone + record, then sync). A nested
// route map so the whole config-source story is one namespace.
//
// The git-operation verbs (`status`/`diff`/`push`/`reset`) were removed in 0.33: they wrapped
// git in a second, weaker spelling of commands the user already has. The clone's path is on
// the breadcrumb — `boom doctor` prints it — so `git -C <dir> …` is the equivalent, and it is
// the whole of git rather than the slice boom re-exposed. See docs/MIGRATING-0.33.md.
import { buildCommand, buildRouteMap } from "@stricli/core";
import { linkRemoteConfigRepo } from "../config/remote.ts";
import type { BoomContext } from "../context.ts";
import { reconcile } from "../engine/reconcile.ts";
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
    // The clone is a network round-trip (a first-time full fetch), so narrate it before the wait
    // rather than announcing only once it's done — the one in-flight beat this one-shot has.
    this.process.stdout.write(`boom: cloning ${ref}…\n`);
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
    // Explicit: the catch above returns an Error to signal failure, so "success" is a value
    // here, not a fallthrough. Required by noImplicitReturns.
    return undefined;
  },
});

export const sourceRouteMap = buildRouteMap({
  routes: {
    // `sync` is the reconcile verb, wired as the route map's `defaultCommand` so bare
    // `boom source` reconciles — and also exposed as the explicit `boom source sync` spelling
    // (the canonical name; bare `boom source` is its shorthand). `set` points it at a repo.
    sync: syncCommand,
    set: setCommand,
  },
  defaultCommand: "sync",
  docs: { brief: "Reconcile your machine (bare, or `sync`); or point boom at a config repo (`set`)" },
});
