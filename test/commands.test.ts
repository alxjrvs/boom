// M5: code-dir resolution + repo crawl, and discovered user commands.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotuConfigError, linkConfigRepo, resolveConfigDir } from "../src/config/load.ts";
import type { BotuContext } from "../src/context.ts";
import { findRepos, materializeAgentsFarm, planAgentsFarm, resolveCodeDir } from "../src/engine/code.ts";
import { runUserCommand } from "../src/engine/discovery.ts";

async function base(): Promise<string> {
  return mkdtemp(join(tmpdir(), "botu-cmd-"));
}

function ctxFor(env: Record<string, string | undefined>, cwd: string): { ctx: BotuContext; out(): string } {
  const buf = { out: "" };
  const proc = {
    stdout: {
      write: (s: string) => {
        buf.out += s;
      },
    },
    stderr: {
      write: (s: string) => {
        buf.out += s;
      },
    },
    env,
    exitCode: 0,
  };
  return { ctx: { process: proc, env, cwd } as unknown as BotuContext, out: () => buf.out };
}

test("resolveCodeDir honors BOTU_CODE", async () => {
  const dir = await base();
  expect(await resolveCodeDir({ BOTU_CODE: dir })).toBe(dir);
});

test("resolveCodeDir reads the breadcrumb `botu code init` writes", async () => {
  const stateHome = await base();
  const codeDir = await base();
  const env = { XDG_STATE_HOME: stateHome };
  // Mirror what `botu code init <codeDir>` records.
  await mkdir(join(stateHome, "botu"), { recursive: true });
  await writeFile(join(stateHome, "botu", "code"), `${codeDir}\n`);
  expect(await resolveCodeDir(env)).toBe(codeDir);
});

test("findRepos finds git repos by the leaf rule, skipping worktrees", async () => {
  const root = await base();
  await mkdir(join(root, "alpha/.git"), { recursive: true });
  await mkdir(join(root, "nested/beta/.git"), { recursive: true });
  await mkdir(join(root, "gamma/.claude/worktrees/wt/.git"), { recursive: true });
  await mkdir(join(root, "gamma/.git"), { recursive: true });
  const repos = await findRepos(root);
  expect(repos).toContain(join(root, "alpha"));
  expect(repos).toContain(join(root, "nested/beta"));
  expect(repos).toContain(join(root, "gamma"));
  // the worktree under gamma is never descended into (gamma is a leaf)
  expect(repos.some((r) => r.includes(".claude/worktrees"))).toBe(false);
});

test("findRepos skips Legacy folders entirely", async () => {
  const root = await base();
  await mkdir(join(root, "Active/repo/.git"), { recursive: true });
  // A stray `git init` shell at the grouping level plus the real repo nested beneath:
  // skipping Legacy drops both, rather than linking the empty shell.
  await mkdir(join(root, "Legacy/Navi/.git"), { recursive: true });
  await mkdir(join(root, "Legacy/Navi/real-app/.git"), { recursive: true });
  const repos = await findRepos(root);
  expect(repos).toEqual([join(root, "Active/repo")]);
  expect(repos.some((r) => r.includes("Legacy"))).toBe(false);
});

test("planAgentsFarm flattens nested repos to basenames and flags collisions", async () => {
  const root = await base();
  await mkdir(join(root, "OrgA/widget/.git"), { recursive: true });
  await mkdir(join(root, "OrgA/gadget/.git"), { recursive: true });
  await mkdir(join(root, "OrgB/widget/.git"), { recursive: true }); // basename collides with OrgA/widget
  const { links, collisions } = await planAgentsFarm(root);
  // OrgA sorts before OrgB, so OrgA/widget wins the name; OrgB/widget is the collision.
  expect(links.map((l) => l.name).sort()).toEqual(["gadget", "widget"]);
  expect(links.find((l) => l.name === "widget")?.target).toBe(join(root, "OrgA/widget"));
  expect(collisions.map((c) => c.target)).toEqual([join(root, "OrgB/widget")]);
});

test("materializeAgentsFarm symlinks repos into ~/.local/code, resolving to .git", async () => {
  const root = await base();
  await mkdir(join(root, "OrgA/widget/.git"), { recursive: true });
  const home = await base();
  const farm = await materializeAgentsFarm({ HOME: home }, (await planAgentsFarm(root)).links);
  // The farm is the short, memorable ~/.local/code (not buried in the state dir).
  expect(farm).toBe(join(home, ".local", "code"));
  // stat (not lstat) follows the symlink, mirroring how `claude agents` detects repos.
  expect((await stat(join(farm, "widget", ".git"))).isDirectory()).toBe(true);
});

test("runUserCommand dispatches a config-supplied command", async () => {
  const repo = await base();
  await writeFile(join(repo, "botufile.toml"), `[[section]]\nname = "x"\n`);
  await mkdir(join(repo, "commands"), { recursive: true });
  await writeFile(
    join(repo, "commands", "hello.ts"),
    `export default function (args, ctx) { ctx.process.stdout.write("hi " + args.join(",")); return 0; }\n`,
  );
  const { ctx, out } = ctxFor({ BOTU_CONFIG: repo }, repo);
  const rc = await runUserCommand("hello", ["a", "b"], ctx);
  expect(rc).toBe(0);
  expect(out()).toBe("hi a,b");
});

test("linkConfigRepo records a breadcrumb resolveConfigDir then reads (the `botu link` core)", async () => {
  const repo = await base();
  await writeFile(join(repo, "botufile.toml"), `[[section]]\nname = "x"\n`);
  const env = { XDG_STATE_HOME: await base() };
  const target = await linkConfigRepo(env, repo);
  expect(target).toBe(repo);
  // The breadcrumb is the only resolution signal here (no BOTU_CONFIG, cwd elsewhere).
  expect(await resolveConfigDir(env, await base())).toBe(repo);
});

test("linkConfigRepo rejects a dir with no botufile.toml", async () => {
  const empty = await base();
  const env = { XDG_STATE_HOME: await base() };
  expect(linkConfigRepo(env, empty)).rejects.toBeInstanceOf(BotuConfigError);
});

test("runUserCommand returns undefined for an unknown command", async () => {
  const repo = await base();
  await writeFile(join(repo, "botufile.toml"), `[[section]]\nname = "x"\n`);
  const { ctx } = ctxFor({ BOTU_CONFIG: repo }, repo);
  expect(await runUserCommand("nope", [], ctx)).toBeUndefined();
});
