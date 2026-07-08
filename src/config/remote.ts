// Config source is always a git remote (repo-only): `botu link`/`botu init` take a
// remote reference — `owner/repo`, `github:owner/repo`, a full git URL, optionally
// `@ref` — clone it into the botu-managed cache dir, and record the breadcrumb.
// engine/sync.ts owns the ongoing fetch/pull-and-report on every apply/verify/fix;
// this file owns only the initial (re-)clone.
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Env } from "../engine/state.ts";
import { pathExists } from "../lib/fs.ts";
import { checkoutRef, cloneRepo, isClean } from "../lib/git.ts";
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

// Split a trailing `@ref` pin off the reference. An SSH shorthand's `@` (as in
// `git@github.com:owner/repo`) always sits before the first `/`; a pin's `@` never
// does — so only split when the last `@` comes after the last `/`.
function splitRef(input: string): { base: string; ref?: string } {
  const at = input.lastIndexOf("@");
  const slash = input.lastIndexOf("/");
  if (at > slash) return { base: input.slice(0, at), ref: input.slice(at + 1) };
  return { base: input };
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
// hold precious uncommitted work, so refuse instead of silently clobbering one that
// has any (push or clean it up first, then re-link).
export async function linkRemoteConfigRepo(env: Env, refInput: string): Promise<string> {
  const { url, ref } = parseRemoteRef(refInput);
  const dest = configRepoCacheDir(env);

  if (await pathExists(dest)) {
    if (!isClean(dest, env)) {
      throw new BotuConfigError(
        `${dest} has uncommitted changes — \`botu push\` or clean it up before re-linking`,
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
