// The `launchd` resource end to end, against a fake `launchctl` so the load/unload path is
// covered and not just the plist rendering — which is how "linked and loaded" could stand in for
// "working" without anything noticing. Sandboxed $HOME + repo, driving reconcile() directly.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { reconcile } from "../src/engine/reconcile.ts";
import { pathExists } from "../src/lib/fs.ts";
import { makeSandbox, type Sandbox } from "./support/sandbox.ts";

const PLIST = "<plist><dict><key>Label</key><string>com.x.agent</string></dict></plist>\n";

async function sandbox(os: string): Promise<Sandbox> {
  const sb = await makeSandbox(`[[section]]\nname = "l"\nlaunchd = [{ src = "agent.plist" }]\n`, {
    prefix: "launchd",
    env: { BOOM_OS: os },
  });
  await sb.write("agent.plist", PLIST);
  return sb;
}

test("launchd: darwin dry-run plans the plist link without invoking launchctl", async () => {
  const sb = await sandbox("darwin");
  expect(await reconcile("sync", sb.ctx, { dryRun: true })).toBe(0);
  expect(sb.out()).toContain("would be linked");
  // Nothing was written, and no launchctl was touched.
  expect(await pathExists(join(sb.home, "Library", "LaunchAgents", "agent.plist"))).toBe(false);
});

test("launchd: non-darwin verify reports macOS-only rather than failing", async () => {
  const sb = await sandbox("linux");
  expect(await reconcile("verify", sb.ctx, { verbose: true })).toBe(0);
  expect(sb.out()).toContain("macOS-only"); // verbose: off-platform no-ops are quiet by default
});

// `list <label>` prints the plist-ish dict launchctl actually emits, with LastExitStatus taken
// from `lastExit` so a test can choose the outcome; `list` with no label and `load`/`unload`
// succeed quietly.
async function launchdSandbox(lastExit: string): Promise<Sandbox> {
  const sb = await sandbox("darwin");
  await sb.fakeBin(
    "launchctl",
    `case "$1" in
  list)
    if [ -n "\${2:-}" ]; then
      printf '{\\n\\t"Label" = "%s";\\n\\t"LastExitStatus" = ${lastExit};\\n};\\n' "$2"
    fi
    ;;
esac
exit 0
`,
  );
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
