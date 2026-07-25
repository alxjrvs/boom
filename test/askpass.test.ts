// `[boom].sudo_askpass` — answering a spawned tool's sudo prompt from the vault.
//
// The bug these guard: a tool boom spawns can invoke `sudo` itself (Homebrew does, for any cask
// carrying a launchctl/pkgutil stanza), and boom runs it with stdout silenced under a spinner that
// redraws the terminal line 11×/second. sudo's prompt goes to /dev/tty, gets erased by the next
// frame, and the run looks hung forever. Verified in the wild: `boom source --update` parked ten
// minutes on `sudo -u root -E -- /bin/launchctl list app.<cask>.app-LaunchAtLoginHelper`.
//
// The fix is `SUDO_ASKPASS` (sudo's own hook; a documented Homebrew env var that makes it pass
// `-A`), which needs an *executable* — hence a generated shim. Sandboxed $HOME + $XDG_STATE_HOME
// throughout: nothing here writes outside a temp dir, and no test resolves a real vault (the
// `env:` backend stands in, which is the whole point of the pluggable backend seam). That leaves
// one thing these tests can't reach — whether real sudo accepts the shim — checked by hand
// against `sudo -A` with a deliberately wrong password: three rejections, no prompt, no hang.
import { expect, test } from "bun:test";
import { chmod as chmodFs, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoomContext } from "../src/context.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { askpassPath, askpassScript, installAskpass } from "../src/engine/secrets/askpass.ts";
import { resolveRef } from "../src/engine/secrets/backends.ts";

async function base(): Promise<string> {
  return mkdtemp(join(tmpdir(), "boom-askpass-"));
}

// ------------------------------------------------------------------ the generated shim's text

test("askpassScript pins PATH and HOME, so the shim doesn't depend on what sudoers forwards", () => {
  const s = askpassScript("op://v/i/f", "/usr/local/bin/boom", {
    PATH: "/opt/homebrew/bin:/usr/bin",
    HOME: "/Users/x",
  });
  expect(s.startsWith("#!/bin/sh\n")).toBe(true);
  expect(s).toContain("PATH='/opt/homebrew/bin:/usr/bin'");
  expect(s).toContain("HOME='/Users/x'");
  expect(s).toContain("export PATH");
  expect(s).toContain("export HOME");
  // `exec` so sudo's child *is* boom — no wrapper shell left holding the password channel.
  expect(s).toContain("exec '/usr/local/bin/boom' askpass 'op://v/i/f'");
});

test("askpassScript single-quotes the ref — a 1Password item title with a space must not word-split", () => {
  // This is the exact failure mode that silently broke a `*_COMMAND` resolver elsewhere: an
  // unquoted `op://vault/Some Item/password` reaches `sh` as three arguments and resolves nothing.
  const s = askpassScript("op://claude-agent/macOS admin/password", "/bin/boom", {});
  expect(s).toContain("askpass 'op://claude-agent/macOS admin/password'");
  // A ref containing a single quote survives too (…'\''…), so the shim can never be broken out of.
  expect(askpassScript("op://v/o'clock/f", "/bin/boom", {})).toContain(`'op://v/o'\\''clock/f'`);
});

test("askpassScript falls back to a usable PATH when the run's env carries none", () => {
  const s = askpassScript("env:PW", "/bin/boom", {});
  expect(s).toContain("PATH='/usr/bin:/bin'");
});

// ---------------------------------------------------------------------- installing the shim

test("installAskpass writes an owner-only executable under the state dir and returns its path", async () => {
  const state = await base();
  const env = { XDG_STATE_HOME: state, PATH: "/usr/bin", HOME: "/Users/x" };
  const p = await installAskpass("env:PW", "/bin/boom", env);
  expect(p).toBe(askpassPath(env));
  expect(p.startsWith(state)).toBe(true);
  // 0700: it is a "print me the admin password" button. No group, no world.
  expect(((await stat(p)).mode & 0o777).toString(8)).toBe("700");
  expect(await readFile(p, "utf8")).toContain("askpass 'env:PW'");
});

test("installAskpass rewrites in place, so an upgraded binary path or changed ref can't go stale", async () => {
  const env = { XDG_STATE_HOME: await base(), PATH: "/usr/bin" };
  await installAskpass("env:OLD", "/old/boom", env);
  const p = await installAskpass("env:NEW", "/new/boom", env);
  const text = await readFile(p, "utf8");
  expect(text).toContain("'/new/boom' askpass 'env:NEW'");
  expect(text).not.toContain("OLD");
});

// ------------------------------------------------------------------- resolving a bare ref

test("resolveRef resolves through the backend the scheme implies, with no destination file", async () => {
  const r = await resolveRef("env:BOOM_TEST_PW", { env: { BOOM_TEST_PW: "hunter2" }, repo: "/tmp" });
  expect(r).toEqual({ ok: true, value: "hunter2" });
});

test("resolveRef reports a failure rather than throwing, so sudo gets a clean 'no password'", async () => {
  const r = await resolveRef("env:NOT_SET_ANYWHERE", { env: {}, repo: "/tmp" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.err).toContain("NOT_SET_ANYWHERE");
});

test("resolveRef reports an unavailable backend by the tool to install", async () => {
  // An op:// ref on a machine with no `op` on PATH: a named failure, not a crash.
  const r = await resolveRef("op://v/i/f", { env: { PATH: "/nonexistent" }, repo: "/tmp" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.err).toContain("1Password");
});

// -------------------------------------------------------------- end-to-end through reconcile

interface Sandbox {
  readonly repo: string;
  readonly ctx: BoomContext;
  out(): string;
}

async function sandbox(boomfile: string, extraEnv: Record<string, string> = {}): Promise<Sandbox> {
  const root = await base();
  const home = join(root, "home");
  const repo = join(root, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "boomfile.toml"), boomfile);
  const env: Record<string, string | undefined> = {
    HOME: home,
    XDG_STATE_HOME: join(root, "state"),
    BOOM_CONFIG: repo,
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    ...extraEnv,
  };
  const buf = { out: "" };
  const write = (s: string): void => {
    buf.out += s;
  };
  const proc = { stdout: { write }, stderr: { write }, env, exitCode: 0 };
  return { repo, ctx: { process: proc, env, cwd: repo } as unknown as BoomContext, out: () => buf.out };
}

async function fakeBin(dir: string, name: string, script: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `#!/bin/sh\n${script}`);
  await chmodFs(join(dir, name), 0o755);
}

// A `run` step is the cheapest observer of the environment reconcile hands its children — the same
// env brew is spawned with. Asserting on it proves the seam without needing Homebrew present.
// `echo` (not printenv) because the sandbox deliberately carries no PATH: a shell builtin needs none.
const ECHO_ASKPASS = (log: string) =>
  `[[section]]\nname = "S"\nrun = [{ on = "sync", cmd = "echo \\"$SUDO_ASKPASS\\" > ${log}" }]\n`;

test("sync exports SUDO_ASKPASS to spawned tools when [boom].sudo_askpass is set", async () => {
  const root = await base();
  const log = join(root, "seen");
  const sb = await sandbox(`[boom]\nsudo_askpass = "env:MACHINE_PW"\n\n${ECHO_ASKPASS(log)}`);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const seen = (await readFile(log, "utf8")).trim();
  expect(seen).toBe(askpassPath(sb.ctx.env));
  // …and the shim it points at actually resolves the configured ref.
  expect(await readFile(seen, "utf8")).toContain("askpass 'env:MACHINE_PW'");
});

test("no [boom].sudo_askpass means no SUDO_ASKPASS — the default stays a plain interactive sudo", async () => {
  const root = await base();
  const log = join(root, "seen");
  const sb = await sandbox(ECHO_ASKPASS(log));
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect((await readFile(log, "utf8")).trim()).toBe("");
});

test("a dry run installs no shim (it writes nothing) and verify doesn't either (nothing escalates)", async () => {
  const sb = await sandbox(`[boom]\nsudo_askpass = "env:MACHINE_PW"\n\n[[section]]\nname = "S"\n`);
  expect(await reconcile("sync", sb.ctx, { dryRun: true })).toBe(0);
  expect(await Bun.file(askpassPath(sb.ctx.env)).exists()).toBe(false);
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(await Bun.file(askpassPath(sb.ctx.env)).exists()).toBe(false);
});

test("pkg apt: sudo gets -A when an askpass shim is configured, and not otherwise", async () => {
  for (const withRef of [true, false]) {
    const sb = await sandbox(
      `${withRef ? '[boom]\nsudo_askpass = "env:MACHINE_PW"\n\n' : ""}[[section]]\nname = "P"\npkg = [{ manager = "apt", file = "packages.txt" }]\n`,
      { BOOM_OS: "linux" },
    );
    await writeFile(join(sb.repo, "packages.txt"), "ripgrep\n");
    const bin = join(sb.repo, ".fakebin");
    const log = join(sb.repo, "sudo-argv.log");
    await fakeBin(bin, "sudo", `echo "$@" >> "${log}"\nexit 0\n`);
    await fakeBin(bin, "apt-get", "exit 0\n");
    await fakeBin(bin, "dpkg", "exit 1\n"); // nothing installed → sync installs
    const env = sb.ctx.env as Record<string, string | undefined>;
    env.PATH = `${bin}:${process.env.PATH ?? ""}`;

    expect(await reconcile("sync", sb.ctx, {})).toBe(0);
    const argv = (await readFile(log, "utf8")).trim();
    expect(argv.startsWith(withRef ? "-A apt-get" : "apt-get")).toBe(true);
  }
});

// ---------------------------------------------------------------- review findings (self-review)

test("askpassScript omits HOME entirely when unknown — an empty HOME breaks op rather than freeing it", () => {
  const s = askpassScript("op://v/i/f", "/bin/boom", { PATH: "/usr/bin" });
  // `HOME=''` would point op at /.config/op and guarantee failure; absent means "inherit".
  expect(s).not.toContain("HOME=");
  expect(s).toContain("export PATH");
  expect(s).not.toContain("export HOME");
});

test("askpassScript pins HOME when it is known", () => {
  const s = askpassScript("op://v/i/f", "/bin/boom", { PATH: "/usr/bin", HOME: "/Users/x" });
  expect(s).toContain("HOME='/Users/x'");
  expect(s).toContain("export HOME");
});

test("installAskpass never leaves the shim at umask permissions, even mid-write", async () => {
  // Created with the mode rather than chmod-ed after, so there's no window at 0644. Re-installing
  // over a deliberately loosened file must tighten it back.
  const env = { XDG_STATE_HOME: await base(), PATH: "/usr/bin" };
  const p = await installAskpass("env:PW", "/bin/boom", env);
  await chmodFs(p, 0o666);
  await installAskpass("env:PW", "/bin/boom", env);
  expect(((await stat(p)).mode & 0o777).toString(8)).toBe("700");
});
