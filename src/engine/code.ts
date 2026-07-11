// Code-workspace discovery: resolve the code dir (BOOM_CODE → breadcrumb → ~/Code)
// and crawl it for git repos using the leaf rule (a repo is a leaf; don't descend
// into it or into worktrees). Ports engine/commands/code's _resolve_code + _repos.
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { boomStateDir, type Env } from "./state.ts";

export function codeBreadcrumbPath(env: Env): string {
  return join(boomStateDir(env), "code");
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
  for (const c of [env.BOOM_CODE, recorded, join(env.HOME ?? "", "Code")]) {
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
// outside boom's state dir (a short, memorable path you can cd into by hand) and is
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

// `claude agents` records the cwd it launched in as a project under `projects` in
// ~/.claude.json, so opening the agent view from the farm leaves a ghost
// `~/.local/code` entry that clutters Claude's project/agent-view list. The farm is
// a generated, disposable index — never a workspace you'd want remembered — so prune
// that one key after the view exits. Best-effort and surgical: the file is shared
// with live Claude processes (background agents keep writing it), so we re-read
// immediately before writing, delete only the farm key, write via temp+rename so a
// reader never sees a half-written file, and swallow every error rather than surface
// a write race. Returns whether a key was actually removed (for the caller's log).
export function claudeConfigPath(env: Env): string {
  return join(env.HOME ?? "", ".claude.json");
}

export async function pruneFarmProject(env: Env, farm: string): Promise<boolean> {
  if (!env.HOME) return false;
  const path = claudeConfigPath(env);
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as { projects?: Record<string, unknown> };
    if (!data.projects || !(farm in data.projects)) return false;
    delete data.projects[farm];
    // 2-space indent, no trailing newline — matches how Claude itself writes the file.
    const tmp = `${path}.boom.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
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
  // Without HOME, agentsFarmDir resolves to a *relative* `.local/code`, and the
  // rm -rf below would blow away whatever sits at that path under the cwd. Refuse.
  if (!env.HOME) throw new Error("HOME is not set — refusing to (re)build the agents farm");
  const farm = agentsFarmDir(env);
  await rm(farm, { recursive: true, force: true });
  await mkdir(farm, { recursive: true });
  for (const { name, target } of links) await symlink(target, join(farm, name));
  return farm;
}
