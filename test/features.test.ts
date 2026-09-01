// Cross-cutting feature surface: overlay `vars`, drift notifications, `verify --ci`, and
// destination precedence end to end. Each is exercised against a fully sandboxed $HOME +
// state dir (never the real machine), like engine.test.ts.
//
// The `secret` resource's own suite lived here and went with it at 0.37. What stayed is the
// precedence coverage it happened to carry: `secret` was one of two kinds that could win a
// destination without owning it, and those tests are about THAT rule, not about secrets.
// They are ported to `launchd`, the remaining such kind — see the note above them.
import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "@stricli/core";
import { app } from "../src/cli.ts";
import type { BoomContext } from "../src/context.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { linkTarget, pathExists } from "../src/lib/fs.ts";
import { notifyArgv } from "../src/lib/notify.ts";
import { makeSandbox, type Sandbox } from "./support/sandbox.ts";

const sandbox = (
  boomfile: string,
  opts: { emptyPath?: boolean; env?: Record<string, string> } = {},
): Promise<Sandbox> =>
  makeSandbox(boomfile, {
    prefix: "boom-feat-",
    emptyPath: opts.emptyPath ?? false,
    env: { BOOM_HOST: "testhost", ...(opts.env ?? {}) },
  });

// --- overlays carry vars + [boom], not just sections ---------------------------------------

test("overlays: a vars-only overlay loads and its value wins over the base's", async () => {
  const sb = await sandbox(
    '[vars]\nEMAIL = "base"\n[[section]]\nname = "t"\ntmpl = [{ src = "gitconfig.tmpl", dst = "~/.gitconfig" }]\n',
  );
  // Built as a template literal so it reads as data, matching resources-new.test.ts's `ph`.
  await writeFile(join(sb.repo, "gitconfig.tmpl"), `email = \${EMAIL}\n`);
  // No [[section]] at all — a hard schema failure before `section` became optional, and its
  // [vars] were dropped on the floor before overlays merged anything but sections.
  await writeFile(join(sb.repo, "boomfile.testhost.toml"), '[vars]\nEMAIL = "host"\n');
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await readFile(join(sb.home, ".gitconfig"), "utf8")).toContain("email = host");
});

// --- named checkpoints --------------------------------------------------------------------

// --- boom.lock ----------------------------------------------------------------------------

// --- drift notifications ------------------------------------------------------------------

test("notifyArgv: platform-correct commands, undefined where boom has no notifier", () => {
  expect(notifyArgv("darwin", "boom", "drift")?.[0]).toBe("osascript");
  expect(notifyArgv("linux", "boom", "drift")).toEqual(["notify-send", "boom", "drift"]);
  expect(notifyArgv("unknown", "boom", "drift")).toBeUndefined();
});

// --- boom status (the machine dashboard) --------------------------------------------------

// --- verify --ci (config-repo CI gate; wraps `doctor --config`) -----------------------------

test("verify --ci passes (exit 0) on a valid boomfile without walking the machine", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\nlink = [{ src = "a", dst = "~/.a" }]\n');
  await run(app, ["verify", "--ci"], sb.ctx);
  expect(sb.ctx.process.exitCode).toBe(0);
  // A CI gate schema-checks the config; it must not walk the machine. The validator reports
  // one line per config file (the boomfile), never per resource/section drift.
  expect(sb.out()).toContain("boomfile.toml");
  expect(sb.out()).not.toContain("~/.a"); // no link-resource walk happened
});

test("verify --ci fails (exit 1) on a schema-invalid boomfile (unknown key)", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\nbogus = true\n');
  await run(app, ["verify", "--ci"], sb.ctx);
  expect(sb.ctx.process.exitCode).toBe(1);
});

test("verify --ci fails (exit 1) when no config repo resolves (strict gate)", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  // Strip the config pointer and point cwd at an empty dir so nothing resolves.
  const empty = join(sb.base, "empty");
  await mkdir(empty, { recursive: true });
  const env = { ...sb.env, BOOM_CONFIG: undefined };
  const ctx = { process: { ...sb.ctx.process, env, exitCode: 0 }, env, cwd: empty } as unknown as BoomContext;
  await run(app, ["verify", "--ci"], ctx);
  expect(ctx.process.exitCode).toBe(1);
});

// --- precedence: duplicate destinations resolve last-wins, end to end -----------------------

// Two composition layers fighting over one destination, weakest first.
//
// This used to build the weak layer from a local module (`use = ["./mod"]`). With modules gone,
// an OS overlay is the remaining second layer, and it drives the same `resolveDuplicates` path:
// an overlay composes AFTER the base, so the second argument is still the winner and every
// assertion below keeps its meaning.
async function twoLayerSandbox(weakSection: string, strongSection: string): Promise<Sandbox> {
  const sb = await sandbox(weakSection, { env: { BOOM_OS: "linux" } });
  await writeFile(join(sb.repo, "boomfile.linux.toml"), strongSection);
  await writeFile(join(sb.repo, "dotfile"), "from the base repo\n");
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
  await writeFile(join(sb.repo, "agent.plist"), "<plist/>\n");
  const dst = join(sb.home, "Library", "LaunchAgents", "agent.plist");

  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(dst)).toBe(true); // run 1 places it and takes ownership

  // The stronger layer then declares a `launchd` resolving to the SAME destination — its `dst`
  // defaults to the LaunchAgents dir plus basename(src). BOOM_OS is linux in this sandbox, so
  // the launchd entry wins the key but declares nothing.
  await writeFile(
    join(sb.repo, "boomfile.linux.toml"),
    `[[section]]\nname = "Base"\nlaunchd = [{ src = "agent.plist" }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(dst)).toBe(true);
  expect(sb.out()).not.toContain("reaped orphan");
});

// --- `secret` is retired, and an ignored declaration is never silent ------------------------
// The key still parses (a hard schema failure on a formerly-valid key turns an upgrade into an
// outage), so the only thing standing between a stale declaration and a file nobody renders any
// more is this warning. It fires on EVERY verb, including verify: a `verify` reporting all-clear
// while ignoring a declared secret is the more dangerous half.
test("secret: a retired declaration still loads, and warns on both sync and verify", async () => {
  const sb = await sandbox('[[section]]\nname = "s"\nsecret = [{ dst = "~/.token", ref = "op://v/i/f" }]\n');
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(sb.out()).toContain("retired and ignored");
  expect(await pathExists(join(sb.home, ".token"))).toBe(false); // nothing was rendered

  const sb2 = await sandbox('[[section]]\nname = "s"\nsecret = [{ dst = "~/.token", ref = "op://v/i/f" }]\n');
  await reconcile("verify", sb2.ctx, {});
  expect(sb2.out()).toContain("retired and ignored");
});

// The count is reported, never the paths: a `dst` for secret material is exactly what must not
// be echoed into a transcript.
test("secret: the retirement warning counts declarations and never prints their paths", async () => {
  const sb = await sandbox(
    '[[section]]\nname = "s"\nsecret = [\n' +
      '  { dst = "~/.aws-creds-do-not-log", ref = "op://v/i/f" },\n' +
      '  { dst = "~/.npmrc-secret", ref = "op://v/i/g" },\n' +
      "]\n",
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(sb.out()).toContain("2 `secret` declaration(s) are retired");
  expect(sb.out()).not.toContain("aws-creds-do-not-log");
  expect(sb.out()).not.toContain("npmrc-secret");
});
