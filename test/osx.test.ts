// The `osx_default` resource. Value normalization (the `defaults read` output space verify
// compares against — numeric int/float matching so a stored `0.50000` matches a declared `0.5`)
// as unit tests, then the uninstall arm end to end against a stateful fake `defaults`, plus a
// `killall` stub so finalizeOsx can't touch the runner's real Dock/Finder.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pruneRuns, readRun } from "../src/engine/journal.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { osxMatches, osxWanted } from "../src/engine/resources/osx.ts";
import { pathExists } from "../src/lib/fs.ts";
import { makeSandbox, type Sandbox } from "./support/sandbox.ts";

// ---------------------------------------------------------------- normalization

test("osxWanted normalizes booleans to 1/0", () => {
  expect(osxWanted("bool", true)).toBe("1");
  expect(osxWanted("bool", false)).toBe("0");
  expect(osxWanted("bool", "true")).toBe("1");
  expect(osxWanted("bool", "YES")).toBe("1");
});

test("osxWanted truncates ints and stringifies floats/strings", () => {
  expect(osxWanted("int", 3)).toBe("3");
  expect(osxWanted("float", 0.5)).toBe("0.5");
  expect(osxWanted("string", "hello")).toBe("hello");
});

test("osxMatches compares int/float numerically (tolerates defaults formatting)", () => {
  expect(osxMatches("float", "0.50000", 0.5)).toBe(true);
  expect(osxMatches("int", "2", 2)).toBe(true);
  expect(osxMatches("float", "0.5", 0.6)).toBe(false);
});

test("osxMatches compares bool/string as text", () => {
  expect(osxMatches("bool", "1", true)).toBe(true);
  expect(osxMatches("bool", "0", true)).toBe(false);
  expect(osxMatches("string", "  hi  ", "hi")).toBe(true);
});

// ---------------------------------------------------------------- uninstall

// `argvLog` records EVERY invocation (not just writes), which is what lets the off-platform
// test assert the resource never shelled out.
interface OsxRig {
  readonly sb: Sandbox;
  readonly store: string;
  /** The stored value for a key, or "" when unset. */
  value(domain: string, key: string): Promise<string>;
  /** Every `defaults …` argv line recorded so far. */
  calls(): Promise<string>;
}

async function osxRig(boomfile: string, extraEnv: Record<string, string> = {}): Promise<OsxRig> {
  const sb = await makeSandbox(boomfile, { prefix: "osx", env: { BOOM_OS: "darwin", ...extraEnv } });
  const store = join(sb.base, "defaults.store");
  const argvLog = join(sb.base, "defaults-argv.log");
  await Bun.write(store, "");
  await sb.fakeBin(
    "defaults",
    // `delete` of an absent key exits 1, as the real tool does.
    `STORE="${store}"; LOG="${argvLog}"; touch "$STORE"; echo "$@" >> "$LOG"
case "$1" in
  read) line=$(grep "^$2|$3=" "$STORE" | tail -1); [ -n "$line" ] || exit 1; echo "\${line#*=}";;
  write) grep -v "^$2|$3=" "$STORE" > "$STORE.tmp" 2>/dev/null; mv "$STORE.tmp" "$STORE"; echo "$2|$3=$5" >> "$STORE";;
  delete) grep -q "^$2|$3=" "$STORE" || exit 1; grep -v "^$2|$3=" "$STORE" > "$STORE.tmp" 2>/dev/null; mv "$STORE.tmp" "$STORE";;
esac
exit 0
`,
  );
  await sb.fakeBin("killall", "exit 0\n");
  const value = async (domain: string, key: string): Promise<string> => {
    const line = (await readFile(store, "utf8"))
      .split("\n")
      .filter((l) => l.startsWith(`${domain}|${key}=`))
      .at(-1);
    return line ? (line.split("=")[1] ?? "") : "";
  };
  const calls = async (): Promise<string> => ((await pathExists(argvLog)) ? readFile(argvLog, "utf8") : "");
  return { sb, store, value, calls };
}

const TILESIZE = (value: number): string =>
  `[[section]]\nname = "O"\nosx_default = [{ domain = "com.test.dock", key = "tilesize", value = ${value} }]\n`;

const DOCK_TWO =
  `[[section]]\nname = "O"\nosx_default = [` +
  `{ domain = "com.test.dock", key = "tilesize", value = 48 },` +
  `{ domain = "com.test.finder", key = "ShowPathbar", value = 1 }]\n`;

test("osx_default: uninstall restores the prior value and deletes a key boom introduced", async () => {
  const rig = await osxRig(DOCK_TWO);
  await Bun.write(rig.store, "com.test.dock|tilesize=64\n"); // tilesize pre-existed; ShowPathbar did not

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
  const rig = await osxRig(TILESIZE(48));
  await Bun.write(rig.store, "com.test.dock|tilesize=64\n");
  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);
  // The declared value changes: run 2's journaled `prior` is 48 — boom's OWN v1, not the user's 64.
  await rig.sb.write("boomfile.toml", TILESIZE(36));
  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);
  expect(await rig.value("com.test.dock", "tilesize")).toBe("36");

  expect(await reconcile("uninstall", rig.sb.ctx, {})).toBe(0);
  expect(await rig.value("com.test.dock", "tilesize")).toBe("64"); // 48 would mean the latest row won
});

test("osx_default: uninstall restores the true prior even after the first run was pruned", async () => {
  const rig = await osxRig(TILESIZE(48));
  await Bun.write(rig.store, "com.test.dock|tilesize=64\n");
  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);
  await rig.sb.write("boomfile.toml", TILESIZE(36));
  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);

  // Drop everything but the newest run: the only surviving `ops` row carries prior=48 (boom's
  // own v1). Only the durable `meta` stash still knows the machine's pre-boom 64.
  await pruneRuns(rig.sb.env, 1);
  expect(await reconcile("uninstall", rig.sb.ctx, {})).toBe(0);
  expect(await rig.value("com.test.dock", "tilesize")).toBe("64");
});

// The stash that makes `firstOsxUndo` durable is never invalidated by an uninstall, so the
// delete is re-attempted on every later run — and real `defaults delete` exits 1 on a key that
// is already gone. Teardown is idempotent everywhere else in the engine; it has to be here too,
// or the ordinary `uninstall` → `uninstall` sequence exits 1.
test("osx_default: uninstall is idempotent — a re-deleted key is already-unset, not a failure", async () => {
  const rig = await osxRig(DOCK_TWO);
  await Bun.write(rig.store, "com.test.dock|tilesize=64\n"); // ShowPathbar is boom's own

  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);
  expect(await reconcile("uninstall", rig.sb.ctx, {})).toBe(0);
  expect(await rig.value("com.test.finder", "ShowPathbar")).toBe("");

  expect(await reconcile("uninstall", rig.sb.ctx, { verbose: true })).toBe(0);
  expect(rig.sb.out()).toContain("com.test.finder ShowPathbar already unset");
  expect(await rig.value("com.test.dock", "tilesize")).toBe("64"); // and the restore still holds
});

test("osx_default: uninstall journals its own restore, under an op the pre-boom lookup ignores", async () => {
  const rig = await osxRig(DOCK_TWO);
  await Bun.write(rig.store, "com.test.dock|tilesize=64\n");
  expect(await reconcile("sync", rig.sb.ctx, {})).toBe(0);
  expect(await reconcile("uninstall", rig.sb.ctx, {})).toBe(0);
  const done = (await readRun(rig.sb.env))?.done ?? [];
  const ops = done.filter((r) => r.op === "osx-restore").map((r) => r.dst);
  expect(ops).toContain("com.test.dock tilesize");
  expect(ops).toContain("com.test.finder ShowPathbar");
  expect(done.some((r) => r.op === "osx")).toBe(false); // never the sync arm's op
});

test("osx_default: uninstall with no journal record leaves the key alone", async () => {
  const rig = await osxRig(TILESIZE(48));
  await Bun.write(rig.store, "com.test.dock|tilesize=64\n"); // never synced → boom has no record

  expect(await reconcile("uninstall", rig.sb.ctx, { verbose: true })).toBe(0);
  expect(rig.sb.out()).toContain("no journaled prior");
  expect(await rig.value("com.test.dock", "tilesize")).toBe("64"); // untouched, not deleted
  expect(await rig.calls()).toBe(""); // and boom never shelled out at all
});

test("osx_default: uninstall --dry-run changes nothing and says what it would do", async () => {
  const rig = await osxRig(DOCK_TWO);
  await Bun.write(rig.store, "com.test.dock|tilesize=64\n");
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
