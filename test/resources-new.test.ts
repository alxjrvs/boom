// End-to-end reconcile tests for `dir`, `launchd`, the `[boom]` table, the `gh` package
// manager, `osx_default` uninstall, `tmpl`, and `copy` modes. Sandboxed $HOME + repo, driving
// reconcile() directly (the same oracle style as engine.test.ts).
import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pruneRuns, readRun } from "../src/engine/journal.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { pathExists } from "../src/lib/fs.ts";
import type { Env } from "../src/lib/paths.ts";
import { makeSandbox, type Sandbox } from "./support/sandbox.ts";

const sandbox = (boomfile: string, extraEnv: Record<string, string> = {}): Promise<Sandbox> =>
  makeSandbox(boomfile, { prefix: "boom-new-", env: extraEnv });

// Write an executable fake binary into `dir` and return nothing — the caller prepends `dir`
// to PATH so the sandboxed reconcile shells out to these instead of the real tools.
async function fakeBin(dir: string, name: string, script: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `#!/bin/sh\n${script}`);
  await chmod(join(dir, name), 0o755);
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

// The mkdir undo is `rmdir`, not `rm -rf` — reversing a directory boom created must never take
// data boom never touched with it. These three pin the arm's whole ladder: kept, removed, gone.

test("dir: uninstall previews with `plan`, then journals the rmdir with a mkdir undo", async () => {
  const sb = await sandbox(
    `[[section]]\nname = "d"\ndir = [{ path = "~/empty", remove_on_uninstall = true }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const dir = join(sb.home, "empty");
  expect(await reconcile("uninstall", sb.ctx, { dryRun: true })).toBe(0);
  expect(sb.out()).toContain("would remove ~/empty"); // the plan tier, shown in the default output
  expect(await pathExists(dir)).toBe(true);
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(dir)).toBe(false);
  expect((await readRun(sb.env))?.done).toContainEqual({ op: "rmdir", dst: dir, undo: { kind: "mkdir" } });
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

// ----------------------------------------------------------------- launchd

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

// A fake `launchctl`. Until now the launchd resource had no effect-level test at all — the
// plist RENDERING was covered in launchd.test.ts and the load/unload path was not, which is how
// "linked and loaded" could stand in for "working" without anything noticing.
//
// `list <label>` prints the plist-ish dict launchctl actually emits, with LastExitStatus taken
// from LAST_EXIT so a test can choose the outcome; `list` with no label and `load`/`unload`
// succeed quietly.
const FAKE_LAUNCHCTL = (lastExit: string) => `case "$1" in
  list)
    if [ -n "\${2:-}" ]; then
      printf '{\\n\\t"Label" = "%s";\\n\\t"LastExitStatus" = ${lastExit};\\n};\\n' "$2"
    fi
    ;;
esac
exit 0
`;

async function launchdSandbox(lastExit: string): Promise<Sandbox> {
  const sb = await sandbox(`[[section]]\nname = "l"\nlaunchd = [{ src = "agent.plist" }]\n`, {
    BOOM_OS: "darwin",
  });
  await writeFile(
    join(sb.repo, "agent.plist"),
    "<plist><dict><key>Label</key><string>com.x.agent</string></dict></plist>\n",
  );
  const bin = join(sb.repo, ".fakebin");
  await fakeBin(bin, "launchctl", FAKE_LAUNCHCTL(lastExit));
  const env = sb.ctx.env as Record<string, string | undefined>;
  env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  return sb;
}

test("launchd: sync links + loads the agent, and verify reports it loaded", async () => {
  const sb = await launchdSandbox("0");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, "Library", "LaunchAgents", "agent.plist"))).toBe(true);
  expect(await reconcile("verify", sb.ctx, { verbose: true })).toBe(0);
  expect(sb.out()).toContain("agent com.x.agent loaded");
});

test("launchd: verify reports an agent that is loaded but whose last run FAILED", async () => {
  // The gap this closes. A nightly `boom verify` agent sat dead for 28 days behind a `~` launchd
  // never expands: it was linked, it was loaded, verify said so and was right about both, and
  // every guardrail it carried went unrun. Loaded is not working.
  const sb = await launchdSandbox("78"); // EX_CONFIG — the exact code that outage produced
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await reconcile("verify", sb.ctx, { verbose: true })).toBe(2); // the warn tier, so it is visible
  expect(sb.out()).toContain("last run FAILED (exit 78)");
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

// `schedule` is retired: parsed, ignored, no longer generating launchd timers. Two things have
// to hold, and neither is the absence of a test — a deleted case would assert nothing.
//
//   1. A boomfile still carrying it PARSES. BoomSettingsSchema is a strictObject, so the only
//      alternative to accepting the key is failing the entire config on it.
//   2. It DOES NOTHING. No timer is planned, and with no other field set the self-wiring header
//      does not appear at all.
test("[boom] schedule: a retired key parses and is inert", async () => {
  const sb = await sandbox(
    `[boom]\nschedule = [{ cmd = "verify", every = "15m" }]\n\n[[section]]\nname = "s"\n`,
    { BOOM_OS: "darwin" },
  );
  expect(await reconcile("sync", sb.ctx, { dryRun: true })).toBe(0);
  expect(sb.out()).not.toContain("schedule");
  expect(sb.out()).not.toContain("timer");
  expect(sb.out()).not.toContain("self-wiring");
});

test("[boom] an absent table changes nothing (no self-wiring header)", async () => {
  const sb = await sandbox(`[[section]]\nname = "s"\n`);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(sb.out()).not.toContain("self-wiring");
});

// ---------------------------------------------------------------- pkg gh (CLI extensions)

// A stateful fake `gh`: the state file holds one installed `owner/repo` per line, and
// `extension list` renders it the way real gh does when piped — a TSV row per extension whose
// *second* column is the repo ("gh stack\tgithub/gh-stack\tv0"). That shape is the regression
// guard for parsing by shape (the token containing a `/`) rather than by column index. With
// nothing installed real gh prints nothing and exits 1, so the fake does too.
async function fakeGh(bin: string, state: string, log: string): Promise<void> {
  await fakeBin(
    bin,
    "gh",
    `S="${state}"; L="${log}"; touch "$S"; touch "$L"
case "$2" in
  list)
    [ -s "$S" ] || exit 1
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      n=$(basename "$r" | sed 's/^gh-//')
      printf 'gh %s\\t%s\\tv0\\n' "$n" "$r"
    done < "$S";;
  install) echo "install $3" >> "$L"; echo "$3" >> "$S";;
  remove) echo "remove $3" >> "$L"; grep -iv "/gh-$3$" "$S" > "$S.tmp"; mv "$S.tmp" "$S";;
esac
exit 0
`,
  );
}

test("pkg gh: sync installs a missing extension, verify diffs `gh extension list`, uninstall removes it", async () => {
  const sb = await sandbox(`[[section]]\nname = "P"\npkg = [{ manager = "gh", file = "gh-ext.txt" }]\n`);
  await writeFile(join(sb.repo, "gh-ext.txt"), "# extensions\ngithub/gh-stack\n");
  const bin = join(sb.repo, ".fakebin");
  const state = join(sb.repo, "gh.state");
  const log = join(sb.repo, "gh-calls.log");
  await writeFile(state, "");
  await fakeGh(bin, state, log);
  const env = sb.ctx.env as Record<string, string | undefined>;
  env.PATH = `${bin}:${process.env.PATH ?? ""}`;

  // Nothing installed → verify warns (exit 2) and names the miss owner-qualified.
  expect(await reconcile("verify", sb.ctx, {})).toBe(2);
  expect(sb.out()).toContain("gh missing: github/gh-stack");

  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect((await readFile(state, "utf8")).trim()).toBe("github/gh-stack");
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);

  // uninstall reverses the declared set, leaving the extension list empty.
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect((await readFile(state, "utf8")).trim()).toBe("");
});

test("pkg gh: a second sync installs nothing", async () => {
  const sb = await sandbox(`[[section]]\nname = "P"\npkg = [{ manager = "gh", file = "gh-ext.txt" }]\n`);
  await writeFile(join(sb.repo, "gh-ext.txt"), "github/gh-stack\n");
  const bin = join(sb.repo, ".fakebin");
  const state = join(sb.repo, "gh.state");
  const log = join(sb.repo, "gh-calls.log");
  await writeFile(state, "");
  await fakeGh(bin, state, log);
  const env = sb.ctx.env as Record<string, string | undefined>;
  env.PATH = `${bin}:${process.env.PATH ?? ""}`;

  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect((await readFile(log, "utf8")).trim()).toBe("install github/gh-stack");
});

test("pkg gh: a differently-cased declaration still matches an installed extension", async () => {
  const sb = await sandbox(`[[section]]\nname = "P"\npkg = [{ manager = "gh", file = "gh-ext.txt" }]\n`);
  // GitHub treats owner/repo case-insensitively; without the `key` hook this reinstalls forever.
  await writeFile(join(sb.repo, "gh-ext.txt"), "GitHub/gh-Stack\n");
  const bin = join(sb.repo, ".fakebin");
  const state = join(sb.repo, "gh.state");
  const log = join(sb.repo, "gh-calls.log");
  await writeFile(state, "github/gh-stack\n");
  await fakeGh(bin, state, log);
  const env = sb.ctx.env as Record<string, string | undefined>;
  env.PATH = `${bin}:${process.env.PATH ?? ""}`;

  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect((await readFile(log, "utf8")).trim()).toBe("");
});

test("pkg gh: uninstall calls `gh extension remove <name>`, not the owner/repo", async () => {
  const sb = await sandbox(`[[section]]\nname = "P"\npkg = [{ manager = "gh", file = "gh-ext.txt" }]\n`);
  await writeFile(join(sb.repo, "gh-ext.txt"), "github/gh-stack\n");
  const bin = join(sb.repo, ".fakebin");
  const state = join(sb.repo, "gh.state");
  const log = join(sb.repo, "gh-calls.log");
  await writeFile(state, "github/gh-stack\n");
  await fakeGh(bin, state, log);
  const env = sb.ctx.env as Record<string, string | undefined>;
  env.PATH = `${bin}:${process.env.PATH ?? ""}`;

  // --dry-run must print the argv that would really run, not the owner/repo near miss.
  expect(await reconcile("uninstall", sb.ctx, { dryRun: true })).toBe(0);
  expect(sb.out()).toContain("gh extension remove stack");

  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect((await readFile(log, "utf8")).trim()).toBe("remove stack");
});

test("pkg gh: gh absent from PATH is a reported failure, not a crash", async () => {
  const sb = await sandbox(`[[section]]\nname = "P"\npkg = [{ manager = "gh", file = "gh-ext.txt" }]\n`);
  await writeFile(join(sb.repo, "gh-ext.txt"), "github/gh-stack\n");
  const bin = join(sb.repo, ".empty");
  await mkdir(bin, { recursive: true });
  const env = sb.ctx.env as Record<string, string | undefined>;
  env.PATH = bin;
  expect(await reconcile("verify", sb.ctx, {})).toBe(1);
  expect(sb.out()).toContain("gh not installed");
});

// ----------------------------------------------------------------- osx_default uninstall

// The stateful fake `defaults` the uninstall tests drive, plus a `killall` stub so finalizeOsx
// can't touch the runner's real Dock/Finder. `argvLog` records EVERY invocation (not just
// writes), which is what lets the off-platform test assert the resource never shelled out.
interface OsxRig {
  readonly sb: Sandbox;
  readonly store: string;
  readonly argvLog: string;
  /** The stored value for a key, or "" when unset. */
  value(domain: string, key: string): Promise<string>;
  /** Every `defaults …` argv line recorded so far. */
  calls(): Promise<string>;
}

async function osxRig(boomfile: string, extraEnv: Record<string, string> = {}): Promise<OsxRig> {
  const sb = await sandbox(boomfile, { BOOM_OS: "darwin", ...extraEnv });
  const bin = join(sb.repo, ".fakebin");
  const store = join(sb.repo, "defaults.store");
  const argvLog = join(sb.repo, "defaults-argv.log");
  await writeFile(store, "");
  await fakeBin(
    bin,
    "defaults",
    // See the fake above: `delete` of an absent key exits 1, as the real tool does.
    `STORE="${store}"; LOG="${argvLog}"; touch "$STORE"; echo "$@" >> "$LOG"
case "$1" in
  read) line=$(grep "^$2|$3=" "$STORE" | tail -1); [ -n "$line" ] || exit 1; echo "\${line#*=}";;
  write) grep -v "^$2|$3=" "$STORE" > "$STORE.tmp" 2>/dev/null; mv "$STORE.tmp" "$STORE"; echo "$2|$3=$5" >> "$STORE";;
  delete) grep -q "^$2|$3=" "$STORE" || exit 1; grep -v "^$2|$3=" "$STORE" > "$STORE.tmp" 2>/dev/null; mv "$STORE.tmp" "$STORE";;
esac
exit 0
`,
  );
  await fakeBin(bin, "killall", "exit 0\n");
  const env = sb.ctx.env as Record<string, string | undefined>;
  env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  const value = async (domain: string, key: string): Promise<string> => {
    const line = (await readFile(store, "utf8"))
      .split("\n")
      .filter((l) => l.startsWith(`${domain}|${key}=`))
      .at(-1);
    return line ? (line.split("=")[1] ?? "") : "";
  };
  const calls = async (): Promise<string> => ((await pathExists(argvLog)) ? readFile(argvLog, "utf8") : "");
  return { sb, store, argvLog, value, calls };
}

const DOCK_TWO =
  `[[section]]\nname = "O"\nosx_default = [` +
  `{ domain = "com.test.dock", key = "tilesize", value = 48 },` +
  `{ domain = "com.test.finder", key = "ShowPathbar", value = 1 }]\n`;

test("osx_default: uninstall restores the prior value and deletes a key boom introduced", async () => {
  const rig = await osxRig(DOCK_TWO);
  await writeFile(rig.store, "com.test.dock|tilesize=64\n"); // tilesize pre-existed; ShowPathbar did not

  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);
  expect(await rig.value("com.test.dock", "tilesize")).toBe("48");
  expect(await rig.value("com.test.finder", "ShowPathbar")).toBe("1");

  // Uninstall must leave macOS as it found it: the user's 64 back, and the key boom introduced gone.
  expect(await reconcile("uninstall", rig.sb.ctx, {})).toBe(0);
  expect(await rig.value("com.test.dock", "tilesize")).toBe("64");
  expect(await rig.value("com.test.finder", "ShowPathbar")).toBe("");
  expect(await rig.calls()).toContain("delete com.test.finder ShowPathbar");
});

test("osx_default: uninstall restores the FIRST prior, not boom's own last value", async () => {
  const rig = await osxRig(
    `[[section]]\nname = "O"\nosx_default = [{ domain = "com.test.dock", key = "tilesize", value = 48 }]\n`,
  );
  await writeFile(rig.store, "com.test.dock|tilesize=64\n");
  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);
  // The declared value changes: run 2's journaled `prior` is 48 — boom's OWN v1, not the user's 64.
  await writeFile(
    join(rig.sb.repo, "boomfile.toml"),
    `[[section]]\nname = "O"\nosx_default = [{ domain = "com.test.dock", key = "tilesize", value = 36 }]\n`,
  );
  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);
  expect(await rig.value("com.test.dock", "tilesize")).toBe("36");

  expect(await reconcile("uninstall", rig.sb.ctx, {})).toBe(0);
  expect(await rig.value("com.test.dock", "tilesize")).toBe("64"); // 48 would mean the latest row won
});

test("osx_default: uninstall restores the true prior even after the first run was pruned", async () => {
  const rig = await osxRig(
    `[[section]]\nname = "O"\nosx_default = [{ domain = "com.test.dock", key = "tilesize", value = 48 }]\n`,
  );
  await writeFile(rig.store, "com.test.dock|tilesize=64\n");
  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);
  await writeFile(
    join(rig.sb.repo, "boomfile.toml"),
    `[[section]]\nname = "O"\nosx_default = [{ domain = "com.test.dock", key = "tilesize", value = 36 }]\n`,
  );
  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);

  // Drop everything but the newest run: the only surviving `ops` row carries prior=48 (boom's
  // own v1). Only the durable `meta` stash still knows the machine's pre-boom 64.
  await pruneRuns(rig.sb.ctx.env as Env, 1);
  expect(await reconcile("uninstall", rig.sb.ctx, {})).toBe(0);
  expect(await rig.value("com.test.dock", "tilesize")).toBe("64");
});

// The stash that makes `firstOsxUndo` durable is never invalidated by an uninstall, so the
// delete is re-attempted on every later run — and real `defaults delete` exits 1 on a key that
// is already gone. Teardown is idempotent everywhere else in the engine; it has to be here too,
// or the ordinary `uninstall` → `uninstall` sequence exits 1.
test("osx_default: uninstall is idempotent — a re-deleted key is already-unset, not a failure", async () => {
  const rig = await osxRig(DOCK_TWO);
  await writeFile(rig.store, "com.test.dock|tilesize=64\n"); // ShowPathbar is boom's own

  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);
  expect(await reconcile("uninstall", rig.sb.ctx, {})).toBe(0);
  expect(await rig.value("com.test.finder", "ShowPathbar")).toBe("");

  expect(await reconcile("uninstall", rig.sb.ctx, { verbose: true })).toBe(0);
  expect(rig.sb.out()).toContain("com.test.finder ShowPathbar already unset");
  expect(await rig.value("com.test.dock", "tilesize")).toBe("64"); // and the restore still holds
});

test("osx_default: uninstall journals its own restore, under an op the pre-boom lookup ignores", async () => {
  const rig = await osxRig(DOCK_TWO);
  await writeFile(rig.store, "com.test.dock|tilesize=64\n");
  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);
  expect(await reconcile("uninstall", rig.sb.ctx, {})).toBe(0);
  const done = (await readRun(rig.sb.env))?.done ?? [];
  const ops = done.filter((r) => r.op === "osx-restore").map((r) => r.dst);
  expect(ops).toContain("com.test.dock tilesize");
  expect(ops).toContain("com.test.finder ShowPathbar");
  expect(done.some((r) => r.op === "osx")).toBe(false); // never the sync arm's op
});

test("osx_default: uninstall with no journal record leaves the key alone", async () => {
  const rig = await osxRig(
    `[[section]]\nname = "O"\nosx_default = [{ domain = "com.test.dock", key = "tilesize", value = 48 }]\n`,
  );
  await writeFile(rig.store, "com.test.dock|tilesize=64\n"); // never synced → boom has no record

  expect(await reconcile("uninstall", rig.sb.ctx, { verbose: true })).toBe(0);
  expect(rig.sb.out()).toContain("no journaled prior");
  expect(await rig.value("com.test.dock", "tilesize")).toBe("64"); // untouched, not deleted
  expect(await rig.calls()).toBe(""); // and boom never shelled out at all
});

test("osx_default: uninstall --dry-run changes nothing and says what it would do", async () => {
  const rig = await osxRig(DOCK_TWO);
  await writeFile(rig.store, "com.test.dock|tilesize=64\n");
  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);
  const before = await readFile(rig.store, "utf8");

  expect(await reconcile("uninstall", rig.sb.ctx, { dryRun: true })).toBe(0);
  expect(await readFile(rig.store, "utf8")).toBe(before);
  expect(rig.sb.out()).toContain("would restore com.test.dock tilesize");
  expect(rig.sb.out()).toContain("would delete com.test.finder ShowPathbar");
});

test("osx_default: uninstall is a no-op off darwin", async () => {
  const rig = await osxRig(DOCK_TWO, { BOOM_OS: "linux" });
  expect(await reconcile("uninstall", rig.sb.ctx, { verbose: true })).toBe(0);
  expect(await rig.calls()).toBe(""); // OS gate short-circuits before any `defaults` invocation
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

test("tmpl: a prototype-chain name is an undefined var, not Object.prototype's member", async () => {
  // `${toString}` resolved through `name in ctx.vars`, which walks the prototype chain, so it
  // rendered "function toString() { [native code] }" into the destination and reported success —
  // silently defeating this resource's "an unknown ${NAME} is a hard failure" guarantee.
  const sb = await tmplSandbox(`greeting = "howdy"`, `hi ${ph("greeting")} ${ph("toString")}\n`);
  const dst = join(sb.home, ".conf");

  expect(await reconcile("sync", sb.ctx, {})).toBe(1); // undefined var → failure, as for any other name
  expect(await pathExists(dst)).toBe(false); // and nothing is written
  expect(sb.out()).toContain(ph("toString"));
  expect(sb.out()).not.toContain("native code");
});

test("tmpl: mode drift on an unchanged render is seen by verify and repaired by sync", async () => {
  const sb = await tmplSandbox(
    `token = "abc"`,
    `k=${ph("token")}\n`,
    `tmpl = [{ src = "conf.tmpl", dst = "~/.conf", mode = "600" }]`,
  );
  const dst = join(sb.home, ".conf");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await mode(dst)).toBe("600");

  await chmod(dst, 0o777); // content still current; only the mode drifted
  expect(await reconcile("verify", sb.ctx, {})).toBe(2); // warning tier — was silently 0
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await mode(dst)).toBe("600"); // repaired — the change-gate used to return first
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
});

test("copy: mode drift on an unchanged file is seen by verify and repaired by sync", async () => {
  // link's verify has always checked mode; copy compared content only, so a copied
  // ~/.ssh/config left world-writable stayed that way and `--fix` could not repair it.
  const sb = await sandbox(
    `[[section]]\nname = "S"\ncopy = [{ src = "cfg", dst = "~/.cfg", mode = "600" }]\n`,
  );
  await writeFile(join(sb.repo, "cfg"), "k=v\n");
  const dst = join(sb.home, ".cfg");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await mode(dst)).toBe("600");

  await chmod(dst, 0o777);
  expect(await reconcile("verify", sb.ctx, {})).toBe(2);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await mode(dst)).toBe("600");
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
});
