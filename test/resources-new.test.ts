// End-to-end reconcile tests for the resources/behaviors added for the dotFiles cleanup
// sweep: `dir` (#54), `check` (#53), and the `[boom]` table's skill refresh (#55) + timer
// scheduling (#57/#58). Sandboxed $HOME + repo, driving reconcile() directly (the same
// oracle style as engine.test.ts). launchctl itself is never invoked here — the timer paths
// are exercised via dry-run/off-platform, and the effectful primitives are darwin-only.
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  expect(sb.out()).toContain("not removed — not empty"); // shows under its band in the dense default
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

test("dir: a corrected mode shows the change under --verbose; an already-correct dir is a no-op", async () => {
  const sb = await sandbox(`[[section]]\nname = "d"\ndir = [{ path = "~/box", mode = "700" }]\n`);
  await mkdir(join(sb.home, "box"), { recursive: true });
  await chmod(join(sb.home, "box"), 0o755); // pre-existing dir with the wrong mode

  // The chmod that corrects the mode is a real change (an ok line), shown under its band by default.
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect((await stat(join(sb.home, "box"))).mode & 0o777).toBe(0o700);
  expect(sb.out()).toContain("~/box (mode 700)");

  // Re-sync quiet: the mode is already correct → a no-op; nothing about ~/box reappears (the
  // skip is quiet-suppressed, folded under the section band).
  const before = sb.out().length;
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(sb.out().slice(before)).not.toContain("~/box (mode 700)");
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
  expect(await reconcile("sync", sb.ctx, {})).toBe(0); // dense default shows the "repaired" change line
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

// ----------------------------------------------------------------- systemd (Linux)

// A stateful fake `systemctl --user`: enable/disable maintain a set of enabled units in a
// file; is-enabled exits 0 iff the unit is in it; daemon-reload is a no-op. Mirrors the apt
// tests' dpkg fake. `shift` drops the leading `--user`, so $1 is the subcommand thereafter.
const FAKE_SYSTEMCTL = (state: string) => `STATE="${state}"; touch "$STATE"
shift
case "$1" in
  enable) echo "$3" >> "$STATE";;
  disable) grep -v "^$3$" "$STATE" > "$STATE.tmp" 2>/dev/null; mv "$STATE.tmp" "$STATE";;
  is-enabled) grep -q "^$2$" "$STATE" && exit 0 || exit 1;;
esac
exit 0
`;

// A sandbox wired for the systemd resource: Linux, with a fake systemctl on PATH recording
// enabled units into `enabled.log`. Returns the enabled-units reader alongside the sandbox.
async function systemdSandbox(boomfile: string): Promise<Sandbox & { enabled(): Promise<string> }> {
  const sb = await sandbox(boomfile, { BOOM_OS: "linux" });
  const bin = join(sb.repo, ".fakebin");
  const log = join(sb.repo, "enabled.log");
  await fakeBin(bin, "systemctl", FAKE_SYSTEMCTL(log));
  const env = sb.ctx.env as Record<string, string | undefined>;
  env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  return { ...sb, enabled: async () => ((await pathExists(log)) ? readFile(log, "utf8") : "") };
}

test("systemd: sync renders + enables the .service unit; verify passes", async () => {
  const sb = await systemdSandbox(
    `[[section]]\nname = "s"\nsystemd = [{ name = "backup", exec = "/usr/bin/backup --now", description = "Nightly backup", env = { TZ = "UTC" } }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const unit = join(sb.home, ".config", "systemd", "user", "backup.service");
  expect(await pathExists(unit)).toBe(true);
  const text = await readFile(unit, "utf8");
  expect(text).toContain("ExecStart=/usr/bin/backup --now");
  expect(text).toContain("Description=Nightly backup");
  expect(text).toContain("Environment=TZ=UTC");
  expect(text).toContain("WantedBy=default.target");
  expect(await sb.enabled()).toContain("backup.service");
  expect(await reconcile("verify", sb.ctx, { verbose: true })).toBe(0);
  expect(sb.out()).toContain("backup.service (enabled)");
});

test("systemd: a timer stanza writes the .timer unit and enables the timer, not the service", async () => {
  const sb = await systemdSandbox(
    `[[section]]\nname = "s"\nsystemd = [{ name = "backup", exec = "/usr/bin/backup", timer = "daily" }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const dir = join(sb.home, ".config", "systemd", "user");
  expect(await pathExists(join(dir, "backup.service"))).toBe(true);
  const timer = await readFile(join(dir, "backup.timer"), "utf8");
  expect(timer).toContain("OnCalendar=daily");
  expect(timer).toContain("WantedBy=timers.target");
  const enabled = await sb.enabled();
  expect(enabled).toContain("backup.timer");
  expect(enabled).not.toContain("backup.service\n");
});

test("systemd: verify warns when the unit is missing, and when it has been edited", async () => {
  const missing = await systemdSandbox(
    `[[section]]\nname = "s"\nsystemd = [{ name = "svc", exec = "/bin/true" }]\n`,
  );
  expect(await reconcile("verify", missing.ctx, {})).toBe(2);
  expect(missing.out()).toContain("not installed");

  const edited = await systemdSandbox(
    `[[section]]\nname = "s"\nsystemd = [{ name = "svc", exec = "/bin/true" }]\n`,
  );
  expect(await reconcile("sync", edited.ctx, {})).toBe(0);
  const unit = join(edited.home, ".config", "systemd", "user", "svc.service");
  await writeFile(unit, "[Service]\nExecStart=/bin/false\n"); // drift
  expect(await reconcile("verify", edited.ctx, {})).toBe(2);
  expect(edited.out()).toContain("outdated");
});

test("systemd: uninstall disables + removes the unit file", async () => {
  const sb = await systemdSandbox(
    `[[section]]\nname = "s"\nsystemd = [{ name = "svc", exec = "/bin/true" }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const unit = join(sb.home, ".config", "systemd", "user", "svc.service");
  expect(await pathExists(unit)).toBe(true);
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(unit)).toBe(false);
  expect(await sb.enabled()).not.toContain("svc.service");
});

test("systemd: off-platform (darwin) is a clean skip; missing systemctl is a reported failure", async () => {
  const darwin = await sandbox(
    `[[section]]\nname = "s"\nsystemd = [{ name = "svc", exec = "/bin/true" }]\n`,
    {
      BOOM_OS: "darwin",
    },
  );
  expect(await reconcile("verify", darwin.ctx, { verbose: true })).toBe(0);
  expect(darwin.out()).toContain("Linux-only");

  // Linux but no systemctl on PATH → a fail (exit 1), not a crash. Point PATH at an empty dir
  // so the lookup misses regardless of the host CI runner.
  const noTool = await sandbox(
    `[[section]]\nname = "s"\nsystemd = [{ name = "svc", exec = "/bin/true" }]\n`,
    {
      BOOM_OS: "linux",
    },
  );
  const emptyBin = join(noTool.repo, ".emptybin");
  await mkdir(emptyBin, { recursive: true });
  (noTool.ctx.env as Record<string, string | undefined>).PATH = emptyBin;
  expect(await reconcile("sync", noTool.ctx, {})).toBe(1);
  expect(noTool.out()).toContain("systemctl not found");
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

// ------------------------------------------------ pkg user-scoped managers (cargo/npm/pipx/…)

// A stateful fake for a user-scoped manager: an env var ($<VAR>) holds the space-separated set of
// "installed" package names. install appends, uninstall removes, and the query reports membership.
// npm/gem/flatpak probe per-package (exit code); cargo/pipx list (parsed once) — so each fake
// implements whichever discipline USER_MGR uses for it.

test("pkg npm: sync installs missing globals, verify keys off `npm ls -g`, uninstall removes", async () => {
  const sb = await sandbox(`[[section]]\nname = "P"\npkg = [{ manager = "npm", file = "npm.txt" }]\n`);
  await writeFile(join(sb.repo, "npm.txt"), "# clis\nprettier\ntypescript\n");
  const bin = join(sb.repo, ".fakebin");
  const state = join(sb.repo, "npm.state"); // space-separated installed set, persisted across calls
  await writeFile(state, "");
  // npm install -g <p> | rm -g <p> | ls -g --depth=0 <p>  (exit 0 iff installed)
  await fakeBin(
    bin,
    "npm",
    `S="${state}"; touch "$S"; set=$(cat "$S")
case "$1 $2" in
  "install -g") echo "$set $3" | tr ' ' '\\n' | grep -v '^$' | sort -u | tr '\\n' ' ' > "$S";;
  "rm -g") echo " $set " | sed "s/ $3 / /" | xargs > "$S";;
  "ls -g") case " $set " in *" $4 "*) exit 0;; *) exit 1;; esac;;
esac
exit 0
`,
  );
  const env = sb.ctx.env as Record<string, string | undefined>;
  env.PATH = `${bin}:${process.env.PATH ?? ""}`;

  // Nothing installed → verify warns (exit 2) and names the misses.
  expect(await reconcile("verify", sb.ctx, {})).toBe(2);
  expect(sb.out()).toContain("npm missing: prettier, typescript");

  // sync installs both.
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect((await readFile(state, "utf8")).trim().split(/\s+/).sort()).toEqual(["prettier", "typescript"]);

  // Now verify passes, and a re-sync is a no-op (already satisfied).
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);

  // uninstall removes what's declared.
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect((await readFile(state, "utf8")).trim()).toBe("");
});

test("pkg cargo: list-query manager parses `cargo install --list` once; sync installs the missing crate", async () => {
  const sb = await sandbox(`[[section]]\nname = "P"\npkg = [{ manager = "cargo", file = "crates.txt" }]\n`);
  await writeFile(join(sb.repo, "crates.txt"), "ripgrep\nfd-find\n");
  const bin = join(sb.repo, ".fakebin");
  const log = join(sb.repo, "cargo-install.log");
  // `cargo install --list` prints "<crate> vX:" then indented binary lines — ripgrep already there.
  await fakeBin(
    bin,
    "cargo",
    `case "$1" in
  install)
    case "$2" in
      --list) printf 'ripgrep v13.0.0:\\n    rg\\n';;
      *) echo "install $2" >> "${log}";;
    esac;;
esac
exit 0
`,
  );
  const env = sb.ctx.env as Record<string, string | undefined>;
  env.PATH = `${bin}:${process.env.PATH ?? ""}`;

  // ripgrep is present, fd-find is not → verify warns naming only the miss.
  expect(await reconcile("verify", sb.ctx, {})).toBe(2);
  expect(sb.out()).toContain("cargo missing: fd-find");

  // sync installs only the missing crate (ripgrep is skipped — no rebuild).
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const installs = (await readFile(log, "utf8")).trim();
  expect(installs).toBe("install fd-find");
});

test("pkg flatpak: off-platform (darwin) is a no-op reported on verify", async () => {
  const sb = await sandbox(`[[section]]\nname = "P"\npkg = [{ manager = "flatpak", file = "apps.txt" }]\n`, {
    BOOM_OS: "darwin",
  });
  await writeFile(join(sb.repo, "apps.txt"), "org.gimp.GIMP\n");
  expect(await reconcile("verify", sb.ctx, { verbose: true })).toBe(0);
  expect(sb.out()).toContain("Linux-only");
});

test("pkg gem: a manager absent from PATH reports fail, not a crash", async () => {
  const sb = await sandbox(`[[section]]\nname = "P"\npkg = [{ manager = "gem", file = "gems.txt" }]\n`);
  await writeFile(join(sb.repo, "gems.txt"), "rubocop\n");
  // PATH points at an empty dir: `gem` is not resolvable, so the arm must report fail (not throw).
  const bin = join(sb.repo, ".empty");
  await mkdir(bin, { recursive: true });
  const env = sb.ctx.env as Record<string, string | undefined>;
  env.PATH = bin;
  expect(await reconcile("verify", sb.ctx, {})).toBe(1);
  expect(sb.out()).toContain("gem not installed");
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

// ------------------------------------------------------------------------- tmpl ([vars])

// The literal `${NAME}` placeholder the template files carry — built via a template literal
// so it reads as data, not as an accidental un-interpolated string (biome flags a bare
// `"${x}"`; this form is the deliberate placeholder the tmpl resource resolves).
const ph = (name: string): string => `\${${name}}`;

// A boomfile with a top-level [vars] table + a section that renders one template. Written as
// a helper so each tmpl test starts from the same repo (boomfile + conf.tmpl on disk).
async function tmplSandbox(
  vars: string,
  template: string,
  entry = `tmpl = [{ src = "conf.tmpl", dst = "~/.conf" }]`,
): Promise<Sandbox> {
  const sb = await sandbox(`[vars]\n${vars}\n\n[[section]]\nname = "t"\n${entry}\n`);
  await writeFile(join(sb.repo, "conf.tmpl"), template);
  return sb;
}

test("tmpl: sync renders [vars] into dst, verify passes, uninstall removes it", async () => {
  const sb = await tmplSandbox(`greeting = "howdy"`, `hello ${ph("greeting")}\n`);
  const dst = join(sb.home, ".conf");

  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await readFile(dst, "utf8")).toBe("hello howdy\n"); // var substituted, not left verbatim

  expect(await reconcile("verify", sb.ctx, {})).toBe(0); // rendered file matches → clean
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(dst)).toBe(false);
});

test("tmpl: verify warns when the rendered file is edited or missing", async () => {
  const sb = await tmplSandbox(`greeting = "howdy"`, `hello ${ph("greeting")}\n`);
  const dst = join(sb.home, ".conf");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);

  await writeFile(dst, "hand-edited\n"); // drift
  expect(await reconcile("verify", sb.ctx, {})).toBe(2); // stale → warning tier

  await rm(dst);
  expect(await reconcile("verify", sb.ctx, {})).toBe(2); // missing → warning tier
});

test("tmpl: a missing var is reported, not silently emitted", async () => {
  const sb = await tmplSandbox(`greeting = "howdy"`, `hi ${ph("greeting")}, from ${ph("nickname")}\n`);
  const dst = join(sb.home, ".conf");

  expect(await reconcile("sync", sb.ctx, {})).toBe(1); // undefined ${nickname} → failure
  expect(await pathExists(dst)).toBe(false); // nothing written with a dangling placeholder
  expect(sb.out()).toContain(ph("nickname"));
});

test("tmpl: mode is applied and dryRun writes nothing", async () => {
  const sb = await tmplSandbox(
    `token = "abc"`,
    `k=${ph("token")}\n`,
    `tmpl = [{ src = "conf.tmpl", dst = "~/.conf", mode = "600" }]`,
  );
  const dst = join(sb.home, ".conf");

  expect(await reconcile("sync", sb.ctx, { dryRun: true })).toBe(0);
  expect(await pathExists(dst)).toBe(false); // dry-run plans, never writes

  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await readFile(dst, "utf8")).toBe("k=abc\n");
  expect(await mode(dst)).toBe("600");
});
