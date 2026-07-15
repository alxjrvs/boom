// End-to-end reconcile tests for the resources/behaviors added for the dotFiles cleanup
// sweep: `dir` (#54), `check` (#53), and the `[boom]` table's skill refresh (#55) + timer
// scheduling (#57/#58). Sandboxed $HOME + repo, driving reconcile() directly (the same
// oracle style as engine.test.ts). launchctl itself is never invoked here — the timer paths
// are exercised via dry-run/off-platform, and the effectful primitives are darwin-only.
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoomContext } from "../src/context.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { rollback } from "../src/engine/rollback.ts";
import { pathExists } from "../src/lib/fs.ts";

// Write an executable fake binary into `dir` and return nothing — the caller prepends `dir`
// to PATH so the sandboxed reconcile shells out to these instead of the real tools.
async function fakeBin(dir: string, name: string, script: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `#!/bin/sh\n${script}`);
  await chmod(join(dir, name), 0o755);
}

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

test("dir: sync creates the directory with mode, verify ok, uninstall removes it (remove_on_uninstall)", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "d"\ndir = [{ path = "~/.ssh/cm", mode = "700", remove_on_uninstall = true }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const cm = join(sb.home, ".ssh", "cm");
  expect((await stat(cm)).isDirectory()).toBe(true);
  expect(await mode(cm)).toBe("700");
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(cm)).toBe(false);
});

test("dir: an un-owned dir is left on uninstall; a non-empty remove_on_uninstall dir is kept", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "d"\ndir = [{ path = "~/Screenshots", remove_on_uninstall = true }]\n`,
  );
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
  expect(await reconcile("sync", sb.ctx, { verbose: true })).toBe(0);
  expect((await stat(join(sb.home, "thing"))).isFile()).toBe(true);
  expect(sb.out()).toContain("not a directory"); // verbose: the "skipped" line is quiet by default
});

test("dir: correcting a drifted mode is shown even in quiet; an already-correct dir is a quiet skip", async () => {
  const sb = await sandbox(`[[section]]\nname = "d"\ndir = [{ path = "~/box", mode = "700" }]\n`);
  await mkdir(join(sb.home, "box"), { recursive: true });
  await chmod(join(sb.home, "box"), 0o755); // pre-existing dir with the wrong mode

  // Quiet default: the chmod that corrects the mode is a real change → shown.
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect((await stat(join(sb.home, "box"))).mode & 0o777).toBe(0o700);
  expect(sb.out()).toContain("~/box (mode 700)");
  expect(sb.out()).not.toContain("- ~/box"); // not the dim skip form

  // Re-sync: the mode is already correct now → a quiet no-op (suppressed by default).
  const before = sb.out().length;
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(sb.out().slice(before)).not.toContain("~/box");
});

// -------------------------------------------------------------------------- check (#53)

test("check: verify passes when present matches and absent is clear; no-op on sync", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "c"\ncheck = [{ path = "~/.conf", present = ["op-agent"], absent = ["osxkeychain"] }]\n`,
  );
  await writeFile(join(sb.home, ".conf"), "helper = op-agent git-credential\n");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0); // check is verify-only
  expect(await reconcile("verify", sb.ctx, { verbose: true })).toBe(0);
  expect(sb.out()).toContain("content ok"); // verbose: a passing check is a quiet skip by default
});

test("check: a forbidden pattern fails verify with the message", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "c"\ncheck = [{ path = "~/.conf", absent = ["osxkeychain"], message = "cached PAT regression" }]\n`,
  );
  await writeFile(join(sb.home, ".conf"), "helper = osxkeychain\n");
  expect(await reconcile("verify", sb.ctx, {})).toBe(1);
  expect(sb.out()).toContain("cached PAT regression");
  expect(sb.out()).toContain("forbidden");
});

test("check: a missing required pattern fails verify", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "c"\ncheck = [{ path = "~/.conf", present = ["op-agent"] }]\n`,
  );
  await writeFile(join(sb.home, ".conf"), "nothing relevant\n");
  expect(await reconcile("verify", sb.ctx, {})).toBe(1);
  expect(sb.out()).toContain("missing required");
});

test("check: missing_file policy — fail (default), skip, pass", async () => {
  // Default is now `fail`: a guardrail whose file vanished must not silently stop guarding.
  const def = await sandbox(`[[section]]\nname = "c"\ncheck = [{ path = "~/gone", present = ["x"] }]\n`);
  expect(await reconcile("verify", def.ctx, {})).toBe(1);
  expect(def.out()).toContain("file missing");

  const skip = await sandbox(
    `[[section]]\nname = "c"\ncheck = [{ path = "~/gone", present = ["x"], missing_file = "skip" }]\n`,
  );
  expect(await reconcile("verify", skip.ctx, { verbose: true })).toBe(0);
  expect(skip.out()).toContain("check skipped"); // verbose: skip-level lines are quiet by default

  const pass = await sandbox(
    `[[section]]\nname = "c"\ncheck = [{ path = "~/gone", absent = ["x"], missing_file = "pass" }]\n`,
  );
  expect(await reconcile("verify", pass.ctx, {})).toBe(0);
});

test("check: repair converges on sync when the assertion fails, and is a no-op once satisfied", async () => {
  const conf = "~/.conf";
  const sb = await sandbox(
    `[[section]]\nname = "c"\ncheck = [{ path = "${conf}", present = ["ok"], repair = "printf ok > ~/.conf" }]\n`,
  );
  // File missing (default missing_file=fail → the assertion is unmet) → repair runs and creates it.
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await Bun.file(join(sb.home, ".conf")).text()).toBe("ok");
  expect(sb.out()).toContain("repaired");
  // Second sync: already satisfied → the repair command does not run again.
  expect(await reconcile("sync", sb.ctx, { verbose: true })).toBe(0);
  expect(sb.out()).toContain("no repair needed");
  // And verify now passes.
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
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
  expect(await reconcile("verify", sb.ctx, { verbose: true })).toBe(0);
  expect(sb.out()).toContain("macOS-only"); // verbose: off-platform no-ops are quiet by default
});

// ------------------------------------------------------------------- [boom] table

test("[boom] skill_on_sync: sync installs the skill; verify reports it current", async () => {
  const sb = await sandbox(`[boom]\nskill_on_sync = true\n\n[[section]]\nname = "s"\n`);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const skill = join(sb.home, ".claude", "skills", "boom", "SKILL.md");
  expect(await pathExists(skill)).toBe(true);
  expect(await Bun.file(skill).text()).toContain("name: boom");
  expect(await reconcile("verify", sb.ctx, { verbose: true })).toBe(0);
  expect(sb.out()).toContain("skill current"); // verbose: "current" is a quiet skip by default
});

test("[boom] schedule: dry-run plans each timer; off-platform reports macOS-only", async () => {
  const darwin = await sandbox(
    `[boom]\nschedule = [{ cmd = "verify", every = "15m" }, { cmd = "code fetch", every = "1h" }]\n\n[[section]]\nname = "s"\n`,
    { BOOM_OS: "darwin" },
  );
  expect(await reconcile("sync", darwin.ctx, { dryRun: true })).toBe(0);
  expect(darwin.out()).toContain("would schedule verify every 15m");
  expect(darwin.out()).toContain("would schedule code fetch every 1h");

  const linux = await sandbox(
    `[boom]\nschedule = [{ cmd = "code fetch", every = "15m" }]\n\n[[section]]\nname = "s"\n`,
    { BOOM_OS: "linux" },
  );
  expect(await reconcile("sync", linux.ctx, { verbose: true })).toBe(0);
  expect(linux.out()).toContain("macOS-only"); // verbose: off-platform no-ops are quiet by default
});

test("[boom] an absent table changes nothing (no self-wiring header)", async () => {
  const sb = await sandbox(`[[section]]\nname = "s"\n`);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(sb.out()).not.toContain("self-wiring");
});

// ------------------------------------------------------------------- pkg apt (Linux)

test("pkg apt: sync installs the listed packages via sudo apt-get; verify keys off dpkg", async () => {
  const sb = await sandbox(`[[section]]\nname = "P"\npkg = [{ manager = "apt", file = "packages.txt" }]\n`, {
    BOOM_OS: "linux",
  });
  await writeFile(join(sb.repo, "packages.txt"), "# tools\nripgrep\nfd-find\n");
  const bin = join(sb.repo, ".fakebin");
  const log = join(sb.repo, "apt-calls.log");
  await fakeBin(bin, "sudo", 'exec "$@"\n'); // run the wrapped argv
  await fakeBin(bin, "apt-get", `echo "$@" >> "${log}"\nexit 0\n`);
  // dpkg -s <pkg> exits 0 iff the pkg is in $DPKG_INSTALLED (space-separated).
  await fakeBin(bin, "dpkg", `case " $DPKG_INSTALLED " in *" $2 "*) exit 0;; *) exit 1;; esac\n`);
  const env = sb.ctx.env as Record<string, string | undefined>;
  env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  env.DPKG_INSTALLED = ""; // nothing installed yet

  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect((await readFile(log, "utf8")).trim()).toContain("install -y ripgrep fd-find");

  // dpkg reports nothing installed → verify warns (exit 2) and names the misses.
  expect(await reconcile("verify", sb.ctx, {})).toBe(2);
  expect(sb.out()).toContain("apt missing: ripgrep, fd-find");

  // Mark them installed → verify passes.
  env.DPKG_INSTALLED = "ripgrep fd-find";
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
});

test("pkg apt: off-platform (darwin) is a no-op, reported on verify", async () => {
  const sb = await sandbox(`[[section]]\nname = "P"\npkg = [{ manager = "apt", file = "packages.txt" }]\n`, {
    BOOM_OS: "darwin",
  });
  await writeFile(join(sb.repo, "packages.txt"), "ripgrep\n");
  expect(await reconcile("verify", sb.ctx, { verbose: true })).toBe(0);
  expect(sb.out()).toContain("Linux-only");
});

// ------------------------------------------------------ osx_default journaling + rollback

test("osx_default: sync journals the prior value (type inferred) and rollback restores it", async () => {
  const sb = await sandbox(
    // No `type` — inferred as int from the TOML number.
    `[[section]]\nname = "O"\nosx_default = [{ domain = "com.test.dock", key = "tilesize", value = 48 }]\n`,
    { BOOM_OS: "darwin" },
  );
  const bin = join(sb.repo, ".fakebin");
  const store = join(sb.repo, "defaults.store");
  const writeLog = join(sb.repo, "defaults-write.log");
  await writeFile(store, "com.test.dock|tilesize=64\n"); // the pre-existing value
  // A tiny stateful fake `defaults`: read/write/delete a `domain|key=value` store.
  await fakeBin(
    bin,
    "defaults",
    `STORE="${store}"; LOG="${writeLog}"; touch "$STORE"
case "$1" in
  read) line=$(grep "^$2|$3=" "$STORE" | tail -1); [ -n "$line" ] || exit 1; echo "\${line#*=}";;
  write) echo "$@" >> "$LOG"; grep -v "^$2|$3=" "$STORE" > "$STORE.tmp" 2>/dev/null; mv "$STORE.tmp" "$STORE"; echo "$2|$3=$5" >> "$STORE";;
  delete) grep -v "^$2|$3=" "$STORE" > "$STORE.tmp" 2>/dev/null; mv "$STORE.tmp" "$STORE";;
esac
exit 0
`,
  );
  await fakeBin(bin, "killall", "exit 0\n"); // don't restart the runner's real Dock/Finder
  const env = sb.ctx.env as Record<string, string | undefined>;
  env.PATH = `${bin}:${process.env.PATH ?? ""}`;

  // sync writes the declared value; `-int` proves the type was inferred, not stated.
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await readFile(store, "utf8")).toContain("tilesize=48");
  expect(await readFile(writeLog, "utf8")).toContain("-int 48");

  // rollback re-applies the prior value from the journaled undo token.
  expect(await rollback(sb.ctx)).toBe(0);
  expect(await readFile(store, "utf8")).toContain("tilesize=64");
});
