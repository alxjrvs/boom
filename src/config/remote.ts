// Config source is always a git remote (repo-only): `botu link`/`botu init` take a
// remote reference — `owner/repo`, `github:owner/repo`, a full git URL, optionally
// `@ref` — clone it into the botu-managed cache dir, and record the breadcrumb.
// engine/sync.ts owns the ongoing fetch/pull-and-report on every apply/verify/fix;
// this file owns only the initial (re-)clone.
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { Env } from "../engine/state.ts";
import { pathExists } from "../lib/fs.ts";
import { checkoutRef, cloneRepo, isAheadOfUpstream, isClean } from "../lib/git.ts";
import {
  BotuConfigError,
  CONFIG_FILE,
  type ConfigRemote,
  configRepoCacheDir,
  hasBotufile,
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
// (uncommitted changes, or commits made but not yet pushed) — push or clean it up
// first, then re-link.
export async function linkRemoteConfigRepo(env: Env, refInput: string): Promise<string> {
  const { url, ref } = parseRemoteRef(refInput);
  const dest = configRepoCacheDir(env);

  // configRepoCacheDir is state-dir-relative; state dir falls back to a *relative*
  // path when neither XDG_STATE_HOME nor HOME is set (see engine/state.ts:stateHome).
  // The rm below would then resolve against the process cwd — mirrors the same
  // guard engine/code.ts's materializeAgentsFarm takes before its own rebuild-via-rm.
  if (!isAbsolute(dest)) {
    throw new BotuConfigError(
      "botu's state dir resolved to a relative path (HOME and XDG_STATE_HOME both unset) — refusing to clone/wipe there",
    );
  }

  if (await pathExists(dest)) {
    if (!isClean(dest, env) || isAheadOfUpstream(dest, env)) {
      throw new BotuConfigError(
        `${dest} has uncommitted or unpushed changes — \`botu push\` or clean it up before re-linking`,
      );
    }
    await rm(dest, { recursive: true, force: true });
  }

  await mkdir(dirname(dest), { recursive: true });
  const clone = cloneRepo(url, dest, env);
  if (clone.code !== 0) {
    throw new BotuConfigError(`git clone ${url} failed: ${clone.stderr || "unknown error"}`);
  }
  if (ref) {
    const co = checkoutRef(dest, ref, env);
    if (co.code !== 0) {
      throw new BotuConfigError(`git checkout ${ref} failed: ${co.stderr || "unknown error"}`);
    }
  }
  if (!(await hasBotufile(dest))) {
    throw new BotuConfigError(`no ${CONFIG_FILE} at ${url} — doesn't look like a botu dotfiles repo`);
  }

  const remote: ConfigRemote = ref ? { url, ref } : { url };
  await writeConfigBreadcrumb(env, { path: dest, remote });
  return dest;
}
