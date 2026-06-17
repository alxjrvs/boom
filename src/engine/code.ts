// Code-workspace discovery: resolve the code dir (BOTU_CODE → breadcrumb → ~/Code)
// and crawl it for git repos using the leaf rule (a repo is a leaf; don't descend
// into it or into worktrees). Ports engine/commands/code's _resolve_code + _repos.
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { botuStateDir, type Env } from "./state.ts";

export function codeBreadcrumbPath(env: Env): string {
  return join(botuStateDir(env), "code");
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function resolveCodeDir(env: Env): Promise<string | undefined> {
  let recorded: string | undefined;
  try {
    recorded = (await readFile(codeBreadcrumbPath(env), "utf8")).trim() || undefined;
  } catch {
    recorded = undefined;
  }
  for (const c of [env.BOTU_CODE, recorded, join(env.HOME ?? "", "Code")]) {
    if (c && (await isDir(c))) return c;
  }
  return undefined;
}

// Grouping folders to never crawl into: `Legacy` archives retired projects (often
// with stray `git init` shells), so its contents shouldn't surface in the agent
// picker. Matched case-insensitively against a directory's basename.
const SKIP_DIRS = new Set(["legacy"]);

export async function findRepos(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === ".git")) {
      if (!dir.includes("/.claude/worktrees") && !dir.includes("/.worktrees/")) out.push(dir);
      return; // leaf rule: never descend into a repo
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name.toLowerCase())) await walk(join(dir, e.name), depth + 1);
    }
  };
  await walk(root, 1);
  return out.sort();
}

// The "agents farm": one flat dir of symlinks (basename → repo) at ~/.local/code.
// Claude Code's agent view (`claude agents`) builds its `@<repo>` picker from a
// single non-recursive scan of the launch cwd's immediate children (symlinks are
// followed), so flattening the org-nested ~/Code into this dir makes every repo
// @-taggable for dispatch — independent of any running background agent. It lives
// outside botu's state dir (a short, memorable path you can cd into by hand) and is
// rebuilt from scratch each run, so nothing else should be kept there.
export interface FarmLink {
  readonly name: string;
  readonly target: string;
}
export interface FarmPlan {
  readonly links: FarmLink[];
  readonly collisions: FarmLink[];
}

export function agentsFarmDir(env: Env): string {
  return join(env.HOME ?? "", ".local", "code");
}

// Map each repo to its basename; the `@<repo>` key is the basename, so two repos
// that share one (across orgs) collide. findRepos() returns sorted paths, so
// first-wins is deterministic; the loser is reported, not silently dropped.
export async function planAgentsFarm(root: string): Promise<FarmPlan> {
  const repos = await findRepos(root);
  const links: FarmLink[] = [];
  const collisions: FarmLink[] = [];
  const taken = new Set<string>();
  for (const target of repos) {
    const name = basename(target);
    if (taken.has(name)) collisions.push({ name, target });
    else {
      taken.add(name);
      links.push({ name, target });
    }
  }
  return { links, collisions };
}

// Rebuild the farm from scratch (so removed repos don't leave orphan links) and
// symlink each repo in. Returns the farm path to launch `claude agents` from.
export async function materializeAgentsFarm(env: Env, links: readonly FarmLink[]): Promise<string> {
  const farm = agentsFarmDir(env);
  await rm(farm, { recursive: true, force: true });
  await mkdir(farm, { recursive: true });
  for (const { name, target } of links) await symlink(target, join(farm, name));
  return farm;
}
