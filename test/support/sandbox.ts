// The one sandboxed $HOME + $XDG_STATE_HOME + config repo the in-process suites drive
// reconcile() through. Nothing here touches the real machine. One definition means a hardening
// applied here (the git sandbox, a private PATH) is applied everywhere — a per-suite copy is how
// one of them quietly loses a variable and runs against the developer's real git config.
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type FakeCtx, fakeCtx } from "./ctx.ts";
import { gitEnv } from "./git.ts";
import { tmp } from "./tmp.ts";

export interface Sandbox extends FakeCtx {
  readonly home: string;
  readonly repo: string;
  readonly base: string;
  readonly env: Record<string, string | undefined>;
  // Drop a file into the config repo.
  write(file: string, body: string): Promise<void>;
  // Put an executable `name` on the sandbox's PATH ahead of the real one, so a resource that
  // shells out (brew, gh, defaults, launchctl, killall) hits the script — a `sh` body — instead
  // of the machine.
  fakeBin(name: string, script: string): Promise<void>;
}

export interface SandboxOpts {
  // tmpdir label, so a leftover directory says which suite made it.
  readonly prefix?: string;
  // Point PATH at an empty dir so `hasCommand` deterministically reports brew/mise/gh absent.
  readonly emptyPath?: boolean;
  // Extra/overriding env (BOOM_OS, BOOM_HOST, …). Merged last, so a suite can override a default.
  readonly env?: Record<string, string | undefined>;
}

export async function makeSandbox(boomfile: string, opts: SandboxOpts = {}): Promise<Sandbox> {
  const base = await tmp(opts.prefix ?? "sb");
  const home = join(base, "home");
  const repo = join(base, "repo");
  const emptyBin = join(base, "empty-bin");
  const fakeBin = join(base, "fakebin");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await mkdir(emptyBin, { recursive: true });
  await writeFile(join(repo, "boomfile.toml"), boomfile);

  const env: Record<string, string | undefined> = {
    HOME: home,
    XDG_STATE_HOME: join(base, "state"),
    BOOM_CONFIG: repo,
    NO_COLOR: "1",
    // A sandboxed HOME covers ~/.gitconfig but NOT /etc/gitconfig; gitEnv covers both, and gives
    // a repo's git sync (src/lib/git.ts) an identity to commit under.
    ...gitEnv,
    PATH: opts.emptyPath ? emptyBin : process.env.PATH,
    ...opts.env,
  };

  return {
    ...fakeCtx(env, repo),
    home,
    repo,
    base,
    env,
    write: (file, body) => writeFile(join(repo, file), body),
    fakeBin: async (name, script) => {
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(fakeBin, name), `#!/bin/sh\n${script}`);
      await chmod(join(fakeBin, name), 0o755);
      if (!env.PATH?.startsWith(`${fakeBin}:`)) env.PATH = `${fakeBin}:${env.PATH ?? ""}`;
    },
  };
}

// The permission bits of a path as the octal string a boomfile declares them in ("600").
export async function octalMode(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8);
}
