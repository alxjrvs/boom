// Config source is always a git remote (repo-only): `boom source set` takes a
// remote reference — `owner/repo`, `github:owner/repo`, a full git URL, optionally
// `@ref` — clone it into the boom-managed cache dir, and record the breadcrumb.
// engine/sync.ts owns the ongoing fetch/pull-and-report on every apply/verify/fix;
// this file owns only the initial (re-)clone.
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { Env } from "../engine/state.ts";
import { pathExists } from "../lib/fs.ts";
import { checkoutRef, cloneRepo, hasUnpushedCommits, isClean } from "../lib/git.ts";
import {
  BoomConfigError,
  CONFIG_FILE,
  type ConfigRemote,
  configRepoCacheDir,
  hasBoomfile,
  writeConfigBreadcrumb,
} from "./load.ts";

export interface ParsedRemoteRef {
  readonly url: string;
  readonly ref?: string;
}

// A userinfo `@` — `user@host` in `ssh://user@host/...`, or the bare `user@host:path`
// scp-like shorthand — always sits before the "authority boundary": the first `/`
// that follows any `scheme://` prefix (or the very start, for the bare scp shorthand,
// since it has no scheme). A ref pin's `@`, if any, always comes after that boundary —
// so find the boundary first, then look for a pin only past it. This is what lets both
// `ssh://user@host/...` (no pin) and a ref that itself contains a slash (`owner/repo@
// feature/foo`, common in git-flow branch names) resolve correctly at once; comparing
// raw @/slash positions in the whole string can't get both.
function authorityBoundary(input: string): number {
  const scheme = /^[a-zA-Z][\w+.-]*:\/\//.exec(input);
  const start = scheme ? scheme[0].length : 0;
  const slash = input.indexOf("/", start);
  return slash === -1 ? input.length : slash;
}

function splitRef(input: string): { base: string; ref?: string } {
  const pinAt = input.indexOf("@", authorityBoundary(input));
  if (pinAt === -1) return { base: input };
  return { base: input.slice(0, pinAt), ref: input.slice(pinAt + 1) };
}

const GITHUB_SHORTHAND_RE = /^[\w.-]+\/[\w.-]+$/;

// Generic git under the hood — GitHub shorthand is sugar, not a hard dependency. A
// full URL (scheme, or `git@host:`) passes through untouched.
function expandUrl(base: string): string {
  if (base.startsWith("github:")) return `https://github.com/${base.slice("github:".length)}.git`;
  if (GITHUB_SHORTHAND_RE.test(base)) return `https://github.com/${base}.git`;
  return base;
}

export function parseRemoteRef(input: string): ParsedRemoteRef {
  const { base, ref } = splitRef(input);
  return { url: expandUrl(base), ref };
}

// (Re-)clone `refInput` into the managed cache dir and record it as the active
// config. Re-linking always wipes and re-clones — the cache dir is never meant to
// hold precious work, so refuse instead of silently clobbering one that has any
// (uncommitted changes, or commits made but not yet pushed) — `boom source push` (to keep
// it) or `boom source reset` (to discard it) first, then re-link.
export async function linkRemoteConfigRepo(env: Env, refInput: string): Promise<string> {
  const { url, ref } = parseRemoteRef(refInput);
  const dest = configRepoCacheDir(env);

  // configRepoCacheDir is state-dir-relative; state dir falls back to a *relative*
  // path when neither XDG_STATE_HOME nor HOME is set (see engine/state.ts:stateHome).
  // The rm below would then resolve against the process cwd — mirrors the same
  // guard engine/code.ts's materializeAgentsFarm takes before its own rebuild-via-rm.
  if (!isAbsolute(dest)) {
    throw new BoomConfigError(
      "boom's state dir resolved to a relative path (HOME and XDG_STATE_HOME both unset) — refusing to clone/wipe there",
    );
  }

  if ((await pathExists(dest)) && (!isClean(dest, env) || hasUnpushedCommits(dest, env))) {
    throw new BoomConfigError(
      `${dest} has uncommitted or unpushed changes — \`boom source push\` or \`boom source reset\` before re-linking`,
    );
  }

  // Clone-validate-swap: the new repo is cloned and vetted in a staging dir, and the
  // existing clone is replaced only after every check passes. Wiping dest up front
  // would turn a failed link (typo'd repo, offline, bad @ref) into lost offline-apply
  // capability — or worse, leave a *different* repo's working tree at the path the
  // still-unrewritten breadcrumb names, and the next apply would reconcile from it.
  const staging = `${dest}.staging`;
  await mkdir(dirname(dest), { recursive: true });
  await rm(staging, { recursive: true, force: true }); // leftover from a crashed link
  try {
    const clone = cloneRepo(url, staging, env);
    if (clone.code !== 0) {
      throw new BoomConfigError(`git clone ${url} failed: ${clone.stderr || "unknown error"}`);
    }
    if (ref) {
      const co = checkoutRef(staging, ref, env);
      if (co.code !== 0) {
        throw new BoomConfigError(`git checkout ${ref} failed: ${co.stderr || "unknown error"}`);
      }
    }
    if (!(await hasBoomfile(staging))) {
      throw new BoomConfigError(`no ${CONFIG_FILE} at ${url} — doesn't look like a boom dotfiles repo`);
    }
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const remote: ConfigRemote = ref ? { url, ref } : { url };
  await writeConfigBreadcrumb(env, { path: dest, remote });
  return dest;
}
