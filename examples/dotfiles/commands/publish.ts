// `boom publish` — a discovered user command (drop it in your config repo at
// `commands/publish.ts`; boom resolves `boom <name>` to `<config>/commands/<name>.ts`).
// It turns the local edits in the managed clone into a branch + pull request on your dotfiles
// remote, without ever checking that branch out, and realigns the clone after the PR lands.
//
// Why a user command and not a boom verb: `boom source push` was a built-in until 0.33 and was
// removed for wrapping git in a weaker spelling of commands you already have. Publishing policy —
// branch naming, commit message, whether a PR is opened at all — is *yours*, so it lives in your
// config repo, where changing it is a dotfiles commit rather than a boom release.
//
// The gotcha it exists for: the clone IS your live config. Every symlink boom made points into its
// working tree, so `git checkout -b …` in there swaps ~/.zshrc, ~/.config/… and everything else
// under you. This pushes a *refspec* (`HEAD:refs/heads/<branch>`) instead — the branch is created
// on the remote from the commit just made, while the working tree stays put on the tracking branch
// and every symlink keeps resolving to the same bytes.

// Structural, not imported: a user command is loaded by the compiled `boom` binary at runtime and
// has no module path back to boom's internals. Only the fields used are declared.
interface Ctx {
  readonly process: {
    readonly stdout: { write(s: string): void };
    readonly stderr: { write(s: string): void };
  };
  readonly env: Record<string, string | undefined>;
}

interface Git {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function git(dir: string, ...args: string[]): Git {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  const dec = new TextDecoder();
  return { code: r.exitCode, out: dec.decode(r.stdout).trim(), err: dec.decode(r.stderr).trim() };
}

// boom's own resolution order, minus the cwd fallback: $BOOM_CONFIG, else the breadcrumb
// `boom source set` wrote next to the clone. The cwd fallback is deliberately dropped — publishing
// must act on the clone this machine is reconciled from, never on whatever repo you're standing in.
async function configRepo(env: Record<string, string | undefined>): Promise<string | undefined> {
  if (env.BOOM_CONFIG) return env.BOOM_CONFIG;
  const state = env.XDG_STATE_HOME ?? (env.HOME ? `${env.HOME}/.local/state` : undefined);
  if (!state) return undefined;
  try {
    const crumb = (await Bun.file(`${state}/boom/config`).json()) as { path?: string };
    return typeof crumb.path === "string" ? crumb.path : undefined;
  } catch {
    return undefined;
  }
}

// Realign the clone after a published PR lands. Merging a PR usually REWRITES the commit (squash,
// or "rebase and merge"), so the landed commit has a different sha — and a different patch id when
// it squashed more than one commit. `git pull --rebase` then tries to replay commits whose content
// is already upstream and stops on a conflict, which is `boom source` failing on every sync until
// someone resolves it by hand. That is the actual sharp edge in this workflow, so publish removes
// it: if the tree is clean and, for every file the local-only commits touched, upstream's content
// already equals HEAD's, then dropping those commits cannot lose a byte — reset onto upstream.
// The check is per-file rather than whole-tree so it still fires when main moved on underneath.
// Anything that fails it is left alone for a human: boom will report the conflict as it does today.
function realignIfLanded(dir: string, report: (s: string) => void): void {
  if (git(dir, "status", "--porcelain").out.length > 0) return; // dirty: nothing to realign onto
  const upstream = git(dir, "rev-parse", "--abbrev-ref", "@{u}");
  if (upstream.code !== 0) return; // detached/pinned, or no tracking branch
  const ref = upstream.out;
  if (git(dir, "rev-parse", "HEAD").out === git(dir, "rev-parse", ref).out) return;
  const base = git(dir, "merge-base", "HEAD", ref);
  if (base.code !== 0) return;
  const touched = git(dir, "diff", "--name-only", base.out, "HEAD");
  if (touched.code !== 0 || touched.out.length === 0) return; // nothing local-only to drop
  const paths = touched.out.split("\n");
  if (git(dir, "diff", "--quiet", ref, "HEAD", "--", ...paths).code !== 0) return; // genuinely ahead
  if (git(dir, "reset", "--hard", ref).code === 0) report(`realigned onto ${ref} — published work has landed`);
}

interface Flags {
  readonly message?: string;
  readonly branch?: string;
  readonly pr: boolean;
}

function parse(args: string[]): Flags | Error {
  let message: string | undefined;
  let branch: string | undefined;
  let pr = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-m" || a === "--message" || a === "--branch") {
      const value = args[++i];
      if (value === undefined) return new Error(`${a} needs a value`);
      if (a === "--branch") branch = value;
      else message = value;
    } else if (a === "--no-pr") pr = false;
    else return new Error(`unknown argument: ${a}`);
  }
  return { message, branch, pr };
}

// A branch name git will accept from any hostname: everything outside [a-z0-9._-] folded to a dash.
// The sha suffix keeps two publishes from the same machine distinct.
function branchFor(host: string, sha: string): string {
  const slug = host.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "machine";
  return `boom/${slug}-${sha.slice(0, 7)}`;
}

// The web compare URL for the pushed branch, so a machine without `gh` still gets one click to a
// PR. https and scp-style (`git@host:owner/repo.git`) origins normalize to the same form.
function compareUrl(origin: string, branch: string): string | undefined {
  const m = /^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)[/:](.+?)(?:\.git)?$/.exec(origin);
  return m ? `https://${m[1]}/${m[2]}/compare/${branch}?expand=1` : undefined;
}

export default async function publish(args: string[], ctx: Ctx): Promise<number> {
  const { stdout, stderr } = ctx.process;
  const say = (s: string) => stdout.write(`boom publish: ${s}\n`);
  const flags = parse(args);
  if (flags instanceof Error) {
    stderr.write(`boom publish: ${flags.message}\n`);
    stderr.write("usage: boom publish [-m <message>] [--branch <name>] [--no-pr]\n");
    return 1;
  }

  const dir = await configRepo(ctx.env);
  if (!dir) {
    stderr.write("boom publish: no config repo linked — run `boom source set <owner/repo>`\n");
    return 1;
  }

  // A clone pinned with `@ref` is detached: there is no branch to publish from, and pushing a
  // detached HEAD to a new branch would silently fork the pin. Refuse rather than guess.
  if (git(dir, "symbolic-ref", "--quiet", "HEAD").code !== 0) {
    stderr.write(`boom publish: ${dir} is on a detached HEAD (pinned ref) — nothing to publish from\n`);
    return 1;
  }

  // Best-effort: offline, the realign is simply skipped and the push below reports the real error.
  git(dir, "fetch", "origin");
  realignIfLanded(dir, say);

  if (git(dir, "status", "--porcelain").out.length > 0) {
    if (git(dir, "add", "-A").code !== 0) {
      stderr.write("boom publish: git add failed\n");
      return 1;
    }
    const host = ctx.env.BOOM_HOST ?? Bun.env.HOSTNAME ?? "local";
    const msg = flags.message ?? `boom: ${host} config changes`;
    const commit = git(dir, "commit", "-m", msg);
    if (commit.code !== 0) {
      stderr.write(`boom publish: git commit failed — ${commit.err || "unknown error"}\n`);
      return 1;
    }
    say(`committed local changes (${msg})`);
  }

  // `HEAD --not --remotes` — the same question `boom verify` asks. Deliberately not `@{u}`-based:
  // work already pushed to an open publish branch counts as published, even though HEAD stays
  // ahead of the tracking branch until that PR merges.
  const count = git(dir, "rev-list", "--count", "HEAD", "--not", "--remotes").out;
  const unpublished = Number.parseInt(count, 10) || 0;
  if (unpublished === 0) {
    say("nothing to publish — every local commit is already on the remote");
    return 0;
  }

  const host = ctx.env.BOOM_HOST ?? Bun.env.HOSTNAME ?? "machine";
  const branch = flags.branch ?? branchFor(host, git(dir, "rev-parse", "HEAD").out);

  // The whole point: a refspec push. HEAD never moves, no branch is checked out, so the working
  // tree every boom symlink points at is byte-identical before and after this line.
  const push = git(dir, "push", "origin", `HEAD:refs/heads/${branch}`);
  if (push.code !== 0) {
    stderr.write(`boom publish: git push failed — ${push.err || "unknown error"}\n`);
    return 1;
  }
  say(`pushed ${unpublished} commit(s) → ${branch}`);
  if (!flags.pr) return 0;

  // `gh` is optional and its absence is not a failure: the push already happened, so fall back to
  // printing the compare URL rather than erroring out on work that succeeded.
  if (Bun.which("gh")) {
    const pr = Bun.spawnSync(["gh", "pr", "create", "--head", branch, "--fill"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const dec = new TextDecoder();
    if (pr.exitCode === 0) {
      say(dec.decode(pr.stdout).trim());
      return 0;
    }
    stderr.write(`boom publish: gh pr create failed — ${dec.decode(pr.stderr).trim()}\n`);
  }
  const url = compareUrl(git(dir, "remote", "get-url", "origin").out, branch);
  say(url ? `open a PR — ${url}` : `branch pushed — open a PR for ${branch}`);
  return 0;
}
