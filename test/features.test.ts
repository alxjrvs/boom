// v0.17 feature surface: the secret resource, named
// checkpoints, boom.lock, drift notifications, and doctor --fix. Each is exercised
// against a fully sandboxed $HOME + state dir (never the real machine), like engine.test.ts.
import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "@stricli/core";
import { app } from "../src/cli.ts";
import { loadConfig } from "../src/config/load.ts";
import type { BoomContext } from "../src/context.ts";
import { doctor } from "../src/engine/doctor.ts";
import {
  findRunByLabel,
  Journal,
  listRuns,
  newRunId,
  pruneRuns,
  readRun,
  setRunLabel,
} from "../src/engine/journal.ts";
import { boomStatus } from "../src/engine/overview.ts";
import { boomLock, parseBrewFormulae, readLock, writeLock } from "../src/engine/pinning.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { checkpoint, rollback, rollbackTo } from "../src/engine/rollback.ts";
import { linkTarget, pathExists } from "../src/lib/fs.ts";
import { notifyArgv } from "../src/lib/notify.ts";
import { backupsDir } from "../src/lib/paths.ts";
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

// A sandbox like engine.test's, plus an `emptyPath` switch: point PATH at a dir with no tools so
// `hasCommand` deterministically reports brew/op/mise absent (for the secret paths).
// Write an executable fake binary into `dir`; the caller prepends `dir` to PATH so the
// sandboxed code shells out to this instead of the real tool.
async function fakeBin(dir: string, name: string, script: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `#!/bin/sh\n${script}`);
  await chmod(join(dir, name), 0o755);
}

// --- doctor --secrets: audit op:// references ---------------------------------------------

test("doctor --secrets: resolvable ref passes, unresolvable warns (exit 2), no value leaks", async () => {
  const sb = await sandbox(
    '[[section]]\nname = "s"\nsecret = [' +
      '{ dst = "~/.good", ref = "op://vault/good/field" },' +
      '{ dst = "~/.bad", ref = "op://vault/bad/field" }]\n',
  );
  // Fake `op`: exit 0 for the good ref (printing a secret to stdout that must NOT surface in the
  // report), non-zero + stderr for the bad one. $3 is the ref (op read --no-newline <ref>).
  const bin = join(sb.base, "bin");
  await fakeBin(
    bin,
    "op",
    'case "$3" in\n' +
      "  op://vault/good/field) printf SUPERSECRETVALUE; exit 0;;\n" +
      '  *) echo "item not found" >&2; exit 1;;\n' +
      "esac\n",
  );
  sb.env.PATH = `${bin}:${sb.env.PATH}`;

  // secretsOnly → doctor(ctx, json, configOnly, fix, secretsOnly)
  expect(await doctor(sb.ctx, false, false, false, true)).toBe(2);
  const out = sb.out();
  expect(out).toContain("op://vault/good/field resolves");
  expect(out).toContain("op://vault/bad/field — unresolvable");
  expect(out).toContain("item not found");
  // The plaintext op printed to stdout must never reach the report.
  expect(out).not.toContain("SUPERSECRETVALUE");
});

test("doctor --secrets: warns cleanly when op is not on PATH", async () => {
  const sb = await sandbox('[[section]]\nname = "s"\nsecret = [{ dst = "~/.k", ref = "op://v/i/f" }]\n', {
    emptyPath: true,
  });
  expect(await doctor(sb.ctx, false, false, false, true)).toBe(2);
  // Now reported per-ref rather than as one early return, so the warning names WHICH ref could
  // not be audited — and the audit continues to any other backend's refs instead of stopping.
  expect(sb.out()).toContain("op://v/i/f — op (1Password CLI) not installed");
});

// The audit used to shell `op read <ref>` at every declared ref regardless of scheme, and to
// return early when `op` was missing. Both are wrong once backends exist: `op read env:TOKEN`
// exits non-zero, so a perfectly good env secret was reported "unresolvable", and a machine
// using only env/pass/age audited nothing while printing a 1Password warning. This drives the
// whole thing with NO `op` on PATH at all — under the old code the run could not audit anything.
test("doctor --secrets: audits non-op backends, and does not need op to do it", async () => {
  const sb = await sandbox(
    '[[section]]\nname = "s"\nsecret = [' +
      '{ dst = "~/.set", ref = "env:BOOM_TEST_TOKEN" },' +
      '{ dst = "~/.unset", ref = "env:BOOM_TEST_MISSING" }]\n',
    { emptyPath: true },
  );
  sb.env.BOOM_TEST_TOKEN = "SUPERSECRETVALUE";

  expect(await doctor(sb.ctx, false, false, false, true)).toBe(2);
  const out = sb.out();
  expect(out).toContain("env:BOOM_TEST_TOKEN resolves (env)");
  expect(out).toContain("env:BOOM_TEST_MISSING — unresolvable");
  expect(out).toContain("$BOOM_TEST_MISSING not set");
  // The old failure mode, asserted directly: a good env ref must never be called unresolvable.
  expect(out).not.toContain("env:BOOM_TEST_TOKEN — unresolvable");
  // And the resolved plaintext still never reaches the report, on this path too.
  expect(out).not.toContain("SUPERSECRETVALUE");
});

// --- secret resource schema ---------------------------------------------------------------

test("secret schema: accepts exactly one of ref / template, rejects neither or both", async () => {
  const ok = await sandbox('[[section]]\nname = "s"\nsecret = [{ dst = "~/.k", ref = "op://v/i/f" }]\n');
  expect((await loadConfig(ok.repo)).section[0]?.secret?.[0]?.ref).toBe("op://v/i/f");

  const both = await sandbox(
    '[[section]]\nname = "s"\nsecret = [{ dst = "~/.k", ref = "op://v/i/f", template = "t" }]\n',
  );
  await expect(loadConfig(both.repo)).rejects.toThrow();

  const neither = await sandbox('[[section]]\nname = "s"\nsecret = [{ dst = "~/.k" }]\n');
  await expect(loadConfig(neither.repo)).rejects.toThrow();
});

test("secret: dry-run plans without needing op; sync fails cleanly when op is absent", async () => {
  const sb = await sandbox('[[section]]\nname = "s"\nsecret = [{ dst = "~/.token", ref = "op://v/i/f" }]\n', {
    emptyPath: true,
  });
  // dry run states intent, never touches 1Password → clean exit even with no `op`.
  expect(await reconcile("sync", sb.ctx, { dryRun: true, verbose: true })).toBe(0);
  expect(sb.out()).toContain("would be rendered");
  // real sync with no op on PATH is a reported failure, not a crash.
  expect(await reconcile("sync", sb.ctx, {})).toBe(1);
  expect(sb.out()).toContain("op (1Password CLI) not installed");
});

test("secret verify: a missing rendered file warns", async () => {
  const sb = await sandbox('[[section]]\nname = "s"\nsecret = [{ dst = "~/.token", ref = "op://v/i/f" }]\n', {
    emptyPath: true,
  });
  expect(await reconcile("verify", sb.ctx, {})).toBe(2);
  expect(sb.out()).toContain("secret not rendered");
});

// --- pluggable secret backends ------------------------------------------------------------

// Write an executable fake tool into the sandbox's empty-bin dir (the dir emptyPath points PATH
// at), so a backend that shells out resolves to this instead of the real tool.
async function fakeBinEmpty(base: string, name: string, script: string): Promise<void> {
  const p = join(base, "empty-bin", name);
  await writeFile(p, `#!/bin/sh\n${script}`);
  await chmod(p, 0o755);
}

test("secret env backend: needs no tool — sync writes the env value at 0600 even under emptyPath", async () => {
  const sb = await sandbox(
    '[[section]]\nname = "s"\nsecret = [{ dst = "~/.tok", ref = "env:MY_SECRET", backend = "env" }]\n',
    { emptyPath: true },
  );
  sb.env.MY_SECRET = "s3cr3t-value";
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const tok = join(sb.home, ".tok");
  expect(await Bun.file(tok).text()).toBe("s3cr3t-value");
  expect(((await stat(tok)).mode & 0o777).toString(8)).toBe("600");
  // The plaintext must never leak into the reconcile's own output — only file content carries it.
  expect(sb.out()).not.toContain("s3cr3t-value");
  // Rotation is now deliberately gated. With a file already at dst, boom cannot tell its own
  // earlier render from something the user put there, so a plain `boom source` leaves it alone
  // and only `--fix` rewrites it. Pinning the behavior change: scheduled syncs stop rotating.
  sb.env.MY_SECRET = "rotated-value";
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await Bun.file(tok).text()).toBe("s3cr3t-value");
  expect(await reconcile("sync", sb.ctx, { linkMode: "overwrite" })).toBe(0);
  expect(await Bun.file(tok).text()).toBe("rotated-value");
});

// --- secret: never destroy a file boom doesn't own -----------------------------------------

const SECRET_BOOMFILE =
  '[[section]]\nname = "s"\nsecret = [{ dst = "~/.tok", ref = "env:MY_SECRET", backend = "env" }]\n';

test("secret: a pre-existing foreign file survives the default (skip) sync", async () => {
  const sb = await sandbox(SECRET_BOOMFILE, { emptyPath: true });
  sb.env.MY_SECRET = "s3cr3t-value";
  const tok = join(sb.home, ".tok");
  await writeFile(tok, "USER-OWNED");
  // verbose: report.skip is quiet-suppressed by default, so the new line only shows here.
  expect(await reconcile("sync", sb.ctx, { verbose: true })).toBe(0);
  expect(await readFile(tok, "utf8")).toBe("USER-OWNED");
  expect(sb.out()).toContain("boom source --fix");
  expect(sb.out()).not.toContain("s3cr3t-value");
  // Nothing was journalled for that destination: boom did not touch it, so there is no undo.
  expect((await readRun(sb.env))?.done.some((r) => r.dst === tok)).toBe(false);
});

test("secret: --fix replaces a foreign file and rollback puts it back", async () => {
  const sb = await sandbox(SECRET_BOOMFILE, { emptyPath: true });
  sb.env.MY_SECRET = "s3cr3t-value";
  const tok = join(sb.home, ".tok");
  await writeFile(tok, "USER-OWNED");
  expect(await reconcile("sync", sb.ctx, { linkMode: "overwrite" })).toBe(0);
  expect(await readFile(tok, "utf8")).toBe("s3cr3t-value");
  expect(((await stat(tok)).mode & 0o777).toString(8)).toBe("600");
  const row = (await readRun(sb.env))?.done.find((r) => r.dst === tok);
  expect(row?.undo.kind).toBe("restore");
  const from = row?.undo.kind === "restore" ? row.undo.from : "";
  expect(await readFile(from, "utf8")).toBe("USER-OWNED");
  expect(await rollback(sb.ctx)).toBe(0);
  expect(await readFile(tok, "utf8")).toBe("USER-OWNED");
});

test("secret: a foreign file whose bytes match the secret is not chmod'ed under the default", async () => {
  const sb = await sandbox(SECRET_BOOMFILE, { emptyPath: true });
  sb.env.MY_SECRET = "s3cr3t-value";
  const tok = join(sb.home, ".tok");
  // Bytes identical to the resolved secret by coincidence — the file is still the user's, so
  // the mode-tightening branch must not reach it and re-permission it to 0600.
  await writeFile(tok, "s3cr3t-value");
  await chmod(tok, 0o644);
  expect(await reconcile("sync", sb.ctx, { verbose: true })).toBe(0);
  expect(((await stat(tok)).mode & 0o777).toString(8)).toBe("644");
  expect(sb.out()).toContain("--fix");
});

test("secret: `--fix` over an already-current secret writes nothing and backs up nothing", async () => {
  const sb = await sandbox(SECRET_BOOMFILE, { emptyPath: true });
  sb.env.MY_SECRET = "s3cr3t-value";
  const tok = join(sb.home, ".tok");
  // Boom renders it itself first — so the file at dst on the second run is boom's own render.
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  // The steady state a converged machine is routinely told to run. It must be a pure no-op:
  // if the conflict gate carried its own overwrite arm, this run would displace the unchanged
  // secret into the backup tree and re-render it — a fresh plaintext copy, every single run.
  expect(await reconcile("sync", sb.ctx, { linkMode: "overwrite", verbose: true })).toBe(0);
  const run = await readRun(sb.env);
  expect(run?.done.some((r) => r.dst === tok)).toBe(false);
  expect(await pathExists(join(backupsDir(sb.env), run?.runId ?? "MISSING"))).toBe(false);
});

test("secret env backend: a missing env var is a clean reported failure, not a crash", async () => {
  const sb = await sandbox(
    '[[section]]\nname = "s"\nsecret = [{ dst = "~/.tok", ref = "env:ABSENT_VAR", backend = "env" }]\n',
    { emptyPath: true },
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(1);
  expect(sb.out()).toContain("$ABSENT_VAR not set");
});

test("secret backend inference: a bare op:// ref still routes to op (fails cleanly with no op)", async () => {
  const sb = await sandbox('[[section]]\nname = "s"\nsecret = [{ dst = "~/.token", ref = "op://v/i/f" }]\n', {
    emptyPath: true,
  });
  // No `backend =`: inferred as op from the `op://` scheme → same op-not-installed failure.
  expect(await reconcile("sync", sb.ctx, {})).toBe(1);
  expect(sb.out()).toContain("op (1Password CLI) not installed");
});

test("secret pass backend: sync writes the value `pass show` returns", async () => {
  const sb = await sandbox(
    '[[section]]\nname = "s"\nsecret = [{ dst = "~/.tok", ref = "pass:svc/token", backend = "pass" }]\n',
    { emptyPath: true },
  );
  // Fake `pass show svc/token` → the secret (with a trailing newline the resolver strips).
  await fakeBinEmpty(sb.base, "pass", 'echo "pass-provided-secret"\n');
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const tok = join(sb.home, ".tok");
  expect(await Bun.file(tok).text()).toBe("pass-provided-secret");
  expect(((await stat(tok)).mode & 0o777).toString(8)).toBe("600");
  expect(sb.out()).not.toContain("pass-provided-secret");
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

test("checkpoints: a labelled run survives pruning and resolves by name", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = newRunId();
    ids.push(id);
    new Journal(sb.env, id).close();
  }
  const keep = ids[0] as string; // label the OLDEST — it would otherwise be pruned first
  await setRunLabel(sb.env, keep, "known-good");
  await pruneRuns(sb.env, 2); // keep 2 unlabelled + all labelled
  const runs = await listRuns(sb.env);
  const surviving = runs.map((r) => r.runId);
  expect(surviving).toContain(keep); // the checkpoint is exempt from the count bound
  expect(runs.find((r) => r.runId === keep)?.label).toBe("known-good");
  expect(await findRunByLabel(sb.env, "known-good")).toBe(keep);
  expect(surviving.length).toBe(3); // 2 newest unlabelled + the 1 labelled
});

test("rollback --to <checkpoint> reverses runs made AFTER it, keeping the checkpoint state", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\nlink = [{ src = "a", dst = "~/.a" }]\n');
  await writeFile(join(sb.repo, "a"), "A\n");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0); // run 1: creates ~/.a
  expect(await pathExists(join(sb.home, ".a"))).toBe(true);
  expect(await checkpoint(sb.ctx, "good")).toBe(0); // labels run 1

  // run 2 adds ~/.b on top of the checkpoint
  await writeFile(
    join(sb.repo, "boomfile.toml"),
    '[[section]]\nname = "x"\nlink = [{ src = "a", dst = "~/.a" }, { src = "b", dst = "~/.b" }]\n',
  );
  await writeFile(join(sb.repo, "b"), "B\n");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".b"))).toBe(true);

  // Returning to the checkpoint undoes run 2 (~/.b) but leaves the checkpoint's own ~/.a.
  expect(await rollbackTo(sb.ctx, "good")).toBe(0);
  expect(await pathExists(join(sb.home, ".b"))).toBe(false);
  expect(await pathExists(join(sb.home, ".a"))).toBe(true);
});

test("rollback --to an unknown checkpoint fails cleanly", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  expect(await rollbackTo(sb.ctx, "nope")).toBe(1);
  expect(sb.out()).toContain("no checkpoint named 'nope'");
});

test("rollback --to warns and exits 2 when history was pruned past the checkpoint", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = newRunId();
    ids.push(id);
    new Journal(sb.env, id).close();
  }
  await setRunLabel(sb.env, ids[0] as string, "good"); // the checkpoint, exempt from the count bound
  await pruneRuns(sb.env, 1); // keeps only the newest unlabelled run — two post-checkpoint runs are gone

  // Reaching the checkpoint is now impossible: the deleted runs' undo records went with them.
  // Exiting 0 here would tell the operator they are back at 'good' when they are not.
  expect(await rollbackTo(sb.ctx, "good")).toBe(2);
  expect(sb.out()).toContain("history was pruned");
});

test("rollback reports a failed defaults restore instead of ok", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n', { emptyPath: true });
  sb.env.BOOM_OS = "darwin";
  await fakeBinEmpty(sb.base, "defaults", "exit 1\n"); // every `defaults` invocation fails
  const j = new Journal(sb.env, newRunId());
  await j.done("osx", "NSGlobalDomain AppleShowAllExtensions", {
    kind: "osx",
    domain: "NSGlobalDomain",
    key: "AppleShowAllExtensions",
    type: "bool",
    prior: "1",
  });
  j.close();

  // The spawn's exit code used to go unread, so a machine left un-restored reported `restored …`
  // and exit 0 — the worst lie a rollback can tell.
  expect(await rollback(sb.ctx)).toBe(1);
  expect(sb.out()).toContain("defaults exit 1");
});

// --- boom.lock ----------------------------------------------------------------------------

test("lock: write + read round-trips, quoting keys that carry @", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  await writeLock(sb.repo, { brew: { ripgrep: "14.1.0" }, mise: { "node@20": "20.11.0" } });
  const back = await readLock(sb.repo);
  expect(back?.brew.ripgrep).toBe("14.1.0");
  expect(back?.mise["node@20"]).toBe("20.11.0");
});

test("lock --check warns when there is no boom.lock yet", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n', { emptyPath: true });
  expect(await boomLock(sb.ctx, true)).toBe(2);
  expect(sb.out()).toContain("no boom.lock yet");
});

test("lock reads single-quoted Brewfile entries, not just double-quoted", () => {
  // A Brewfile is Ruby, so `brew 'x'` is as valid as `brew "x"`. Matching only double quotes
  // yielded an EMPTY formula list — which wrote an empty lockfile and made `--check` green
  // forever, the one failure a drift check must never have.
  expect(parseBrewFormulae(`brew 'ripgrep'\nbrew "fd"\ntap 'x/y'\ncask "vlc"\n# brew "nope"\n`)).toEqual([
    "ripgrep",
    "fd",
  ]);
});

test("verify folds boom.lock drift into its own warning tier", async () => {
  // boom.lock had no reader: its only consumer was a `boom status` line saying the file existed,
  // so a machine that had drifted off its pins verified clean and you had to remember to run
  // `boom lock --check` by hand.
  const sb = await sandbox('[[section]]\nname = "x"\n', { emptyPath: true });

  // No lockfile → verify is silent about pinning and stays clean.
  expect(await reconcile("verify", sb.ctx, {})).toBe(0);
  expect(sb.out()).not.toContain("locked");

  // A lockfile naming something that isn't installed is drift verify must surface.
  await writeLock(sb.repo, { brew: { "definitely-not-installed": "9.9.9" }, mise: {} });
  expect(await reconcile("verify", sb.ctx, {})).toBe(2);
  expect(sb.out()).toContain("definitely-not-installed");
});

// --- drift notifications ------------------------------------------------------------------

test("notifyArgv: platform-correct commands, undefined where boom has no notifier", () => {
  expect(notifyArgv("darwin", "boom", "drift")?.[0]).toBe("osascript");
  expect(notifyArgv("linux", "boom", "drift")).toEqual(["notify-send", "boom", "drift"]);
  expect(notifyArgv("unknown", "boom", "drift")).toBeUndefined();
});

// --- boom status (the machine dashboard) --------------------------------------------------

test("status: composes config, last-sync, lock and secret health into one report", async () => {
  // A boomfile that declares packages + a secret, on an empty PATH so op is absent and no
  // sync has run yet — the dashboard should surface each as its own line without touching the
  // real machine, and warn (exit 2) on the un-synced + op-missing signals.
  const sb = await sandbox(
    '[[section]]\nname = "dev"\npkg = [{ manager = "brew" }]\nsecret = [{ dst = "~/.tok", ref = "op://v/i/f" }]\n',
    { emptyPath: true },
  );
  const rc = await boomStatus(sb.ctx);
  const out = sb.out();
  expect(out).toContain("Config");
  expect(out).toContain("1 section(s)");
  expect(out).toContain("no sync recorded yet");
  expect(out).toContain("no boom.lock");
  expect(out).toContain("secret(s) declared but op"); // op absent under emptyPath
  expect(rc).toBe(2); // warning tier: un-synced + op missing
});

test("status: reports a clean last sync and lists checkpoints from the journal", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  // Simulate a committed run + a named checkpoint directly through the journal the dashboard
  // reads — no resource walk needed to exercise the composition.
  const j = new Journal(sb.env, newRunId());
  await j.done("link", join(sb.home, ".x"), { kind: "remove" });
  j.markCommitted();
  j.close();
  await setRunLabel(sb.env, j.runId, "green");

  const rc = await boomStatus(sb.ctx);
  const out = sb.out();
  expect(out).toContain("last sync clean");
  expect(out).toContain("checkpoint(s): green");
  expect(rc).toBe(0); // nothing needs attention
});

test("status: --json emits the shared report envelope", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  const rc = await boomStatus(sb.ctx, true);
  const env = JSON.parse(sb.out()) as { schemaVersion: number; records: { msg: string }[] };
  expect(env.schemaVersion).toBeGreaterThanOrEqual(2);
  expect(env.records.some((r) => r.msg.includes("section(s)"))).toBe(true);
  // no config-repo/fleet/lock/secrets declared → un-synced is the only warning
  expect(rc).toBe(2);
});

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

// The second way a winner can fail to own what it wins: a `secret` is deliberately kept out of the
// owned-destinations manifest, so a secret that evicted the `copy` declaring the same path would
// leave it declared by nobody — while the prior manifest still lists it, and reaping deletes that.
// (Worse with the backend unavailable: the render fails AND the file goes.) Keyed per kind now, so
// the two are independent declarations and the secret's own skip arm leaves the file alone.
test("precedence: a secret never evicts the copy that owns the same dst", async () => {
  const sb = await twoLayerSandbox(
    `[[section]]\nname = "Mod"\ncopy = [{ src = "dotfile", dst = "~/.netrc" }]\n`,
    `[[section]]\nname = "Base"\n`,
  );
  const dst = join(sb.home, ".netrc");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(dst)).toBe(true); // run 1 places it and takes ownership

  // The user then adds the documented cross-kind override to the STRONGER layer — the overlay,
  // which composes after the base and so is where an override belongs.
  sb.env.MY_NETRC = "rendered\n";
  await writeFile(
    join(sb.repo, "boomfile.linux.toml"),
    `[[section]]\nname = "Base"\nsecret = [{ dst = "~/.netrc", ref = "env:MY_NETRC" }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(dst)).toBe(true);
  expect(sb.out()).not.toContain("reaped orphan");
});
