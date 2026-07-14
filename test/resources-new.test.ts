// End-to-end reconcile tests for the resources/behaviors added for the dotFiles cleanup
// sweep: `dir` (#54), `check` (#53), and the `[boom]` table's skill refresh (#55) + timer
// scheduling (#57/#58). Sandboxed $HOME + repo, driving reconcile() directly (the same
// oracle style as engine.test.ts). launchctl itself is never invoked here — the timer paths
// are exercised via dry-run/off-platform, and the effectful primitives are darwin-only.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoomContext } from "../src/context.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { pathExists } from "../src/lib/fs.ts";

interface Sandbox {
  readonly home: string;
  readonly repo: string;
  readonly ctx: BoomContext;
  out(): string;
}

async function sandbox(boomfile: string, extraEnv: Record<string, string> = {}): Promise<Sandbox> {
  const base = await mkdtemp(join(tmpdir(), "boom-new-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "boomfile.toml"), boomfile);
  const env: Record<string, string | undefined> = {
    HOME: home,
    XDG_STATE_HOME: join(base, "state"),
    BOOM_CONFIG: repo,
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    ...extraEnv,
  };
  const buf = { out: "" };
  const write = (s: string) => {
    buf.out += s;
  };
  const proc = { stdout: { write }, stderr: { write }, env, exitCode: 0 };
  const ctx = { process: proc, env, cwd: repo } as unknown as BoomContext;
  return { home, repo, ctx, out: () => buf.out };
}

const mode = async (p: string): Promise<string> => ((await stat(p)).mode & 0o777).toString(8);

// ---------------------------------------------------------------------------- dir (#54)

test("dir: sync creates the directory with mode, verify ok, uninstall(manage) removes it", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "d"\ndir = [{ path = "~/.ssh/cm", mode = "700", manage = true }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const cm = join(sb.home, ".ssh", "cm");
  expect((await stat(cm)).isDirectory()).toBe(true);
  expect(await mode(cm)).toBe("700");
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(cm)).toBe(false);
});

test("dir: unmanaged dir is left on uninstall; a non-empty managed dir is kept", async () => {
  const sb = await sandbox(`[[section]]\nname = "d"\ndir = [{ path = "~/Screenshots", manage = true }]\n`);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const dir = join(sb.home, "Screenshots");
  await writeFile(join(dir, "shot.png"), "x"); // user data lands in it
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(dir)).toBe(true); // not empty → kept
  expect(sb.out()).toContain("not removed — not empty");
});

test("dir: verify fails when the directory is missing", async () => {
  const sb = await sandbox(`[[section]]\nname = "d"\ndir = [{ path = "~/nope" }]\n`);
  expect(await reconcile("verify", sb.ctx, {})).toBe(1);
  expect(sb.out()).toContain("missing");
});

test("dir: a non-directory at the path is skipped, never clobbered", async () => {
  const sb = await sandbox(`[[section]]\nname = "d"\ndir = [{ path = "~/thing" }]\n`);
  await writeFile(join(sb.home, "thing"), "i am a file\n");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect((await stat(join(sb.home, "thing"))).isFile()).toBe(true);
  expect(sb.out()).toContain("not a directory");
});

// -------------------------------------------------------------------------- check (#53)

test("check: verify passes when present matches and absent is clear; no-op on sync", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "c"\ncheck = [{ file = "~/.conf", present = ["op-agent"], absent = ["osxkeychain"] }]\n`,
  );
  await writeFile(join(sb.home, ".conf"), "helper = op-agent git-credential\n");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0); // check is verify-only
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(sb.out()).toContain("content ok");
});

test("check: a forbidden pattern fails verify with the message", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "c"\ncheck = [{ file = "~/.conf", absent = ["osxkeychain"], message = "cached PAT regression" }]\n`,
  );
  await writeFile(join(sb.home, ".conf"), "helper = osxkeychain\n");
  expect(await reconcile("verify", sb.ctx, {})).toBe(1);
  expect(sb.out()).toContain("cached PAT regression");
  expect(sb.out()).toContain("forbidden");
});

test("check: a missing required pattern fails verify", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "c"\ncheck = [{ file = "~/.conf", present = ["op-agent"] }]\n`,
  );
  await writeFile(join(sb.home, ".conf"), "nothing relevant\n");
  expect(await reconcile("verify", sb.ctx, {})).toBe(1);
  expect(sb.out()).toContain("missing required");
});

test("check: missing_file policy — skip (default), fail, pass", async () => {
  const skip = await sandbox(`[[section]]\nname = "c"\ncheck = [{ file = "~/gone", present = ["x"] }]\n`);
  expect(await reconcile("verify", skip.ctx, {})).toBe(0);
  expect(skip.out()).toContain("check skipped");

  const fail = await sandbox(
    `[[section]]\nname = "c"\ncheck = [{ file = "~/gone", present = ["x"], missing_file = "fail" }]\n`,
  );
  expect(await reconcile("verify", fail.ctx, {})).toBe(1);

  const pass = await sandbox(
    `[[section]]\nname = "c"\ncheck = [{ file = "~/gone", absent = ["x"], missing_file = "pass" }]\n`,
  );
  expect(await reconcile("verify", pass.ctx, {})).toBe(0);
});

// ----------------------------------------------------------------- launchd (#52)

test("launchd: darwin dry-run plans the plist link without invoking launchctl", async () => {
  const sb = await sandbox(`[[section]]\nname = "l"\nlaunchd = [{ src = "agent.plist" }]\n`, {
    BOOM_OS: "darwin",
  });
  await writeFile(
    join(sb.repo, "agent.plist"),
    "<plist><dict><key>Label</key><string>com.x.agent</string></dict></plist>\n",
  );
  expect(await reconcile("sync", sb.ctx, { dryRun: true })).toBe(0);
  expect(sb.out()).toContain("would be linked");
  // Nothing was written, and no launchctl was touched.
  expect(await pathExists(join(sb.home, "Library", "LaunchAgents", "agent.plist"))).toBe(false);
});

test("launchd: non-darwin verify reports macOS-only rather than failing", async () => {
  const sb = await sandbox(`[[section]]\nname = "l"\nlaunchd = [{ src = "agent.plist" }]\n`, {
    BOOM_OS: "linux",
  });
  await writeFile(join(sb.repo, "agent.plist"), "<plist></plist>\n");
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(sb.out()).toContain("macOS-only");
});

// ------------------------------------------------------------------- [boom] table

test("[boom] skill_on_sync: sync installs the skill; verify reports it current", async () => {
  const sb = await sandbox(`[boom]\nskill_on_sync = true\n\n[[section]]\nname = "s"\n`);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const skill = join(sb.home, ".claude", "skills", "boom", "SKILL.md");
  expect(await pathExists(skill)).toBe(true);
  expect(await Bun.file(skill).text()).toContain("name: boom");
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(sb.out()).toContain("skill current");
});

test("[boom] verify_schedule: dry-run plans it; off-platform reports macOS-only", async () => {
  const darwin = await sandbox(`[boom]\nverify_schedule = "15m"\n\n[[section]]\nname = "s"\n`, {
    BOOM_OS: "darwin",
  });
  expect(await reconcile("sync", darwin.ctx, { dryRun: true })).toBe(0);
  expect(darwin.out()).toContain("would schedule scheduled verify every 15m");

  const linux = await sandbox(`[boom]\ncode_fetch_schedule = "15m"\n\n[[section]]\nname = "s"\n`, {
    BOOM_OS: "linux",
  });
  expect(await reconcile("sync", linux.ctx, {})).toBe(0);
  expect(linux.out()).toContain("macOS-only");
});

test("[boom] an absent table changes nothing (no self-wiring header)", async () => {
  const sb = await sandbox(`[[section]]\nname = "s"\n`);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(sb.out()).not.toContain("self-wiring");
});
