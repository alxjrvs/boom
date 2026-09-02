// Duplicate destinations across composition layers resolve last-wins, end to end: the winner
// converges instead of failing verify forever, the override is reported, and — the destructive
// case Layer 5's gate exists for — a winner that declares nothing never gets the loser's file
// reaped. Sandboxed $HOME + state dir, driving reconcile() directly.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { reconcile } from "../src/engine/reconcile.ts";
import { linkTarget, pathExists } from "../src/lib/fs.ts";
import { makeSandbox, type Sandbox } from "./support/sandbox.ts";

// Two composition layers fighting over one destination, weakest first: the base boomfile, then
// an OS overlay, which composes AFTER the base — so the second argument is the winner.
async function twoLayerSandbox(weakSection: string, strongSection: string): Promise<Sandbox> {
  const sb = await makeSandbox(weakSection, {
    prefix: "prec",
    env: { BOOM_OS: "linux", BOOM_HOST: "testhost" },
  });
  await sb.write("boomfile.linux.toml", strongSection);
  await sb.write("dotfile", "from the base repo\n");
  return sb;
}

test("precedence: a two-layer link override converges instead of failing verify forever", async () => {
  const sb = await twoLayerSandbox(
    `[[section]]\nname = "Mod"\nlink = [{ src = "dotfile", dst = "~/.zshrc" }]\n`,
    `[[section]]\nname = "Shell"\nlink = [{ src = "dotfile", dst = "~/.zshrc" }]\n`,
  );
  // Before last-wins, the module linked first and the base's placement then found a foreign file
  // at dst — skipped under the default linkMode, so verify failed permanently and no `boom
  // source` could ever converge it.
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await linkTarget(join(sb.home, ".zshrc"))).toBe(join(sb.repo, "dotfile"));
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
});

test("precedence: a duplicate dst completes with a verdict band, not a UNIQUE-constraint stack trace", async () => {
  const sb = await twoLayerSandbox(
    `[[section]]\nname = "Mod"\nlink = [{ src = "dotfile", dst = "~/.zshrc" }]\n`,
    `[[section]]\nname = "Shell"\ncopy = [{ src = "dotfile", dst = "~/.zshrc" }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, { command: "source" })).toBe(0);
  expect(sb.out()).toContain("COMPLETE");
  expect(sb.out()).not.toContain("UNIQUE constraint");
});

// composeConfig runs before the section loop, so its notes land under CONFIG. A note is held back
// from the *live* stream when quiet, but the category summary replays every buffered non-skip
// record — so an override surfaces in the dense default too, and always in --json.
test("precedence: an override is reported as a CONFIG note and rides in the JSON report", async () => {
  const twoLayers = (): Promise<Sandbox> =>
    twoLayerSandbox(
      `[[section]]\nname = "Mod"\nlink = [{ src = "dotfile", dst = "~/.zshrc" }]\n`,
      `[[section]]\nname = "Shell"\nlink = [{ src = "dotfile", dst = "~/.zshrc" }]\n`,
    );

  const quiet = await twoLayers();
  expect(await reconcile("sync", quiet.ctx, {})).toBe(0);
  expect(quiet.out()).toContain("CONFIG");
  expect(quiet.out()).toContain(
    "~/.zshrc — link from boomfile.toml overridden by link in boomfile.linux.toml",
  );

  const structured = await twoLayers();
  expect(await reconcile("sync", structured.ctx, { json: true })).toBe(0);
  const report = JSON.parse(structured.out()) as { records: { level: string; msg: string }[] };
  expect(report.records.some((r) => r.level === "note" && r.msg.includes("overridden by"))).toBe(true);
});

// The destructive path Layer 5's gate exists for: keying over sections that never run would let a
// `when`-gated winner take the destination away from the module that still declares it — the file
// would be declared by nobody and reapOrphans would delete it on a plain `boom source`.
test("precedence: a `when`-gated winner never causes the loser's file to be reaped", async () => {
  const sb = await twoLayerSandbox(
    `[[section]]\nname = "Mod"\nlink = [{ src = "dotfile", dst = "~/.npmrc" }]\n`,
    `[[section]]\nname = "Work"\nwhen = { profile = "work" }\nlink = [{ src = "dotfile", dst = "~/.npmrc" }]\n`,
  );
  const dst = join(sb.home, ".npmrc");

  // With the profile: the base wins, and the manifest records the destination as boom's.
  expect(await reconcile("sync", sb.ctx, { profiles: ["work"] })).toBe(0);
  expect(await linkTarget(dst)).toBe(join(sb.repo, "dotfile"));

  // Without it: the base section is gated out, so the module's declaration is the only live one
  // and the destination stays declared. (The default skip linkMode leaves the base's symlink
  // alone — the point is ownership, not which source wins.) Key the winner over gated-out
  // sections instead and this run declares the destination nowhere, and reaps the file.
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(dst)).toBe(true);
  expect(sb.out()).not.toContain("reaped orphan");
});

// THE SECOND WAY a winner can fail to own what it wins, and the reason `declaresOwnership`
// still exists as a predicate rather than a constant. A `launchd` entry does not push its
// destination to `ctx.declared` off darwin — the resource returns before that push — so a
// launchd entry that EVICTED the `copy` declaring the same path would leave it declared by
// nobody, while the prior manifest still lists it, and reaping deletes exactly that.
//
// Ported from `secret`, which was the other such kind until 0.37. The rule is unchanged and so
// is this test's shape; only the kind exercising it moved. Deleting it with the resource would
// have left the predicate — and the NUL-partitioned keyspace under it — with no coverage at all,
// which is how a subtle correctness rule quietly becomes decorative.
test("precedence: an off-darwin launchd never evicts the copy that owns the same dst", async () => {
  const sb = await twoLayerSandbox(
    `[[section]]\nname = "Mod"\ncopy = [{ src = "agent.plist", dst = "~/Library/LaunchAgents/agent.plist" }]\n`,
    `[[section]]\nname = "Base"\n`,
  );
  await sb.write("agent.plist", "<plist/>\n");
  const dst = join(sb.home, "Library", "LaunchAgents", "agent.plist");

  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(dst)).toBe(true); // run 1 places it and takes ownership

  // The stronger layer then declares a `launchd` resolving to the SAME destination — its `dst`
  // defaults to the LaunchAgents dir plus basename(src). BOOM_OS is linux in this sandbox, so
  // the launchd entry wins the key but declares nothing.
  await sb.write("boomfile.linux.toml", `[[section]]\nname = "Base"\nlaunchd = [{ src = "agent.plist" }]\n`);
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(dst)).toBe(true);
  expect(sb.out()).not.toContain("reaped orphan");
});
