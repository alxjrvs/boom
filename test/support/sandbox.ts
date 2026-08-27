// The one sandboxed $HOME + $XDG_STATE_HOME + config repo every in-process suite drives
// reconcile() through. Nothing here touches the real machine.
//
// This existed six times before, once per suite, as ~30 near-identical lines apiece. The copies
// had already drifted in a way that mattered: transaction.test.ts omitted GIT_CONFIG_NOSYSTEM, so
// the 700+ lines of journal and rollback coverage ran with git free to read the developer's (or
// CI runner's) system-wide config — a global hook or commit template could change what those
// tests observed, which is precisely what the other five sandboxed against. One definition means
// a hardening applied here is applied everywhere, rather than in five places and forgotten in a
// sixth.
//
// The returned shape is the UNION of what the six suites used (`base`, `env`, `clear`, `write`
// are each needed by some and ignored by the rest), so each suite keeps a one-line adapter with
// its original call signature and not one call site had to change.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoomContext } from "../../src/context.ts";

export interface Sandbox {
  readonly home: string;
  readonly repo: string;
  readonly base: string;
  readonly env: Record<string, string | undefined>;
  readonly ctx: BoomContext;
  out(): string;
  clear(): void;
  write(file: string, body: string): Promise<void>;
}

export interface SandboxOpts {
  // tmpdir label, so a leftover directory says which suite made it.
  readonly prefix?: string;
  // Point PATH at an empty dir so `hasCommand` deterministically reports brew/op/mise absent.
  readonly emptyPath?: boolean;
  // Extra/overriding env (BOOM_OS, BOOM_HOST, …). Merged last, so a suite can override a default.
  readonly env?: Record<string, string | undefined>;
}

export async function makeSandbox(boomfile: string, opts: SandboxOpts = {}): Promise<Sandbox> {
  const base = await mkdtemp(join(tmpdir(), opts.prefix ?? "boom-sb-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  const emptyBin = join(base, "empty-bin");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await mkdir(emptyBin, { recursive: true });
  await writeFile(join(repo, "boomfile.toml"), boomfile);

  const env: Record<string, string | undefined> = {
    HOME: home,
    XDG_STATE_HOME: join(base, "state"),
    BOOM_CONFIG: repo,
    NO_COLOR: "1",
    // Never let a repo's git sync (src/lib/git.ts) see this machine's real system-wide git
    // config (e.g. a global commit hook). HOME is already sandboxed above, which covers
    // ~/.gitconfig but NOT /etc/gitconfig — this is the half that is easy to forget.
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: opts.emptyPath ? emptyBin : process.env.PATH,
    ...opts.env,
  };

  const buf = { out: "" };
  const write = (s: string): void => {
    buf.out += s;
  };
  const proc = { stdout: { write }, stderr: { write }, env, exitCode: 0 };
  const ctx = { process: proc, env, cwd: repo } as unknown as BoomContext;

  return {
    home,
    repo,
    base,
    env,
    ctx,
    out: () => buf.out,
    clear: () => {
      buf.out = "";
    },
    write: (file, body) => writeFile(join(repo, file), body),
  };
}
