// Code-workspace discovery: resolve the code dir (BOTU_CODE → breadcrumb → ~/Code)
// and crawl it for git repos using the leaf rule (a repo is a leaf; don't descend
// into it or into worktrees). Ports engine/commands/code's _resolve_code + _repos.
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
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
    for (const e of entries) if (e.isDirectory()) await walk(join(dir, e.name), depth + 1);
  };
  await walk(root, 1);
  return out.sort();
}
