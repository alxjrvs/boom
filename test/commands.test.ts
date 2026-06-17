// M5: code-dir resolution + repo crawl, and discovered user commands.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotuContext } from "../src/context.ts";
import { findRepos, resolveCodeDir } from "../src/engine/code.ts";
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

test("runUserCommand returns undefined for an unknown command", async () => {
  const repo = await base();
  await writeFile(join(repo, "botufile.toml"), `[[section]]\nname = "x"\n`);
  const { ctx } = ctxFor({ BOTU_CONFIG: repo }, repo);
  expect(await runUserCommand("nope", [], ctx)).toBeUndefined();
});
