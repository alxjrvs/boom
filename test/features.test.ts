// v0.17 feature surface: the secret resource, `use` modules, fleet awareness, named
// checkpoints, boom.lock, drift notifications, adopt, and doctor --fix. Each is exercised
// against a fully sandboxed $HOME + state dir (never the real machine), like engine.test.ts.
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@stricli/core";
import { app } from "../src/cli.ts";
import { loadConfig, readConfigBreadcrumb } from "../src/config/load.ts";
import { resolveModule } from "../src/config/modules.ts";
import { insertUseRef, searchRegistry } from "../src/config/registry.ts";
import type { BoomContext } from "../src/context.ts";
import { adopt } from "../src/engine/adopt.ts";
import { doctor } from "../src/engine/doctor.ts";
import {
  boomFleet,
  fleetDiff,
  fleetDrift,
  machineSummary,
  readMachines,
  writeMachineSummary,
} from "../src/engine/fleet.ts";
import { boomInit } from "../src/engine/init.ts";
import {
  findRunByLabel,
  Journal,
  listRuns,
  newRunId,
  pruneRuns,
  setRunLabel,
} from "../src/engine/journal.ts";
import { boomLock, readLock, writeLock } from "../src/engine/lock.ts";
import { boomStatus } from "../src/engine/overview.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { checkpoint, rollbackTo } from "../src/engine/rollback.ts";
import { pathExists } from "../src/lib/fs.ts";
import { headSha } from "../src/lib/git.ts";
import { notifyArgv } from "../src/lib/notify.ts";

interface Sandbox {
  readonly home: string;
  readonly repo: string;
  readonly base: string;
  readonly env: Record<string, string | undefined>;
  readonly ctx: BoomContext;
  out(): string;
}

// A sandbox like engine.test's, plus an `emptyPath` switch: point PATH at a dir with no tools so
// `hasCommand` deterministically reports brew/op/mise absent (for the secret + adopt paths).
async function sandbox(boomfile: string, opts: { emptyPath?: boolean } = {}): Promise<Sandbox> {
  const base = await mkdtemp(join(tmpdir(), "boom-feat-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  const emptyBin = join(base, "empty-bin");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await mkdir(emptyBin, { recursive: true });
  await writeFile(join(repo, "boomfile.toml"), boomfile);
  const env: Record<string, string | undefined> = {
    HOME: home,
    XDG_STATE_HOME: join(base, "state"),
    BOOM_CONFIG: repo,
    BOOM_HOST: "testhost",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: opts.emptyPath ? emptyBin : process.env.PATH,
  };
  const buf = { out: "" };
  const write = (s: string): void => {
    buf.out += s;
  };
  const proc = { stdout: { write }, stderr: { write }, env, exitCode: 0 };
  const ctx = { process: proc, env, cwd: repo } as unknown as BoomContext;
  return { home, repo, base, env, ctx, out: () => buf.out };
}

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
  expect(sb.out()).toContain("op (1Password CLI) not on PATH");
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

// --- use modules --------------------------------------------------------------------------

test("modules: reconcile composes a local module's sections before the repo's own", async () => {
  const sb = await sandbox('use = ["./mod"]\n[[section]]\nname = "local"\n');
  const mod = join(sb.repo, "mod");
  await mkdir(mod, { recursive: true });
  await writeFile(
    join(mod, "boomfile.toml"),
    '[[section]]\nname = "shared"\ndir = [{ path = "~/.config/shared" }]\n',
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".config", "shared"))).toBe(true);
});

test("modules: an unresolvable module warns and is skipped, never sinking the reconcile", async () => {
  const sb = await sandbox('use = ["./missing"]\n[[section]]\nname = "local"\n');
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(sb.out()).toContain("module ./missing");
});

test("resolveModule: a local path without a boomfile is an error, not a throw", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  const m = await resolveModule(sb.env, sb.repo, "./nope");
  expect(m.dir).toBeUndefined();
  expect(m.error).toContain("no boomfile.toml");
});

// --- nested modules + cycle detection -----------------------------------------------------

test("modules: a nested module (A uses B) resolves both, composing B's sections too", async () => {
  const sb = await sandbox('use = ["./mod-a"]\n[[section]]\nname = "local"\n');
  const modA = join(sb.repo, "mod-a");
  const modB = join(modA, "mod-b");
  await mkdir(modB, { recursive: true });
  // mod-a itself `use`s mod-b (one level deeper than the old cap allowed).
  await writeFile(
    join(modA, "boomfile.toml"),
    'use = ["./mod-b"]\n[[section]]\nname = "shared-a"\ndir = [{ path = "~/.config/shared-a" }]\n',
  );
  await writeFile(
    join(modB, "boomfile.toml"),
    '[[section]]\nname = "shared-b"\ndir = [{ path = "~/.config/shared-b" }]\n',
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  // Both the nested (B) and intermediate (A) module sections applied.
  expect(await pathExists(join(sb.home, ".config", "shared-b"))).toBe(true);
  expect(await pathExists(join(sb.home, ".config", "shared-a"))).toBe(true);
});

test("modules: a cycle (A uses B, B uses A) terminates and warns instead of hanging", async () => {
  const sb = await sandbox('use = ["./mod-a"]\n[[section]]\nname = "local"\n');
  const modA = join(sb.repo, "mod-a");
  const modB = join(sb.repo, "mod-b");
  await mkdir(modA, { recursive: true });
  await mkdir(modB, { recursive: true });
  await writeFile(join(modA, "boomfile.toml"), 'use = ["../mod-b"]\n[[section]]\nname = "a"\n');
  await writeFile(join(modB, "boomfile.toml"), 'use = ["../mod-a"]\n[[section]]\nname = "b"\n');
  // If cycle detection failed this would recurse forever; a bounded resolve returns cleanly.
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(sb.out()).toContain("cycle detected");
});

// --- module registry (search / add) -------------------------------------------------------

test("registry: search matches a pack by a substring of its name or tag", () => {
  expect(searchRegistry("node").some((p) => p.name === "node-dev")).toBe(true);
  // tag match: cli-essentials carries the "terminal" tag, not the literal in its name.
  expect(searchRegistry("terminal").some((p) => p.name === "cli-essentials")).toBe(true);
  // an empty term lists everything; a nonsense term nothing.
  expect(searchRegistry("").length).toBeGreaterThan(0);
  expect(searchRegistry("zzznope")).toHaveLength(0);
});

test("insertUseRef: idempotent + least-destructive across the three shapes", () => {
  // no `use` yet → prepend a fresh line.
  const created = insertUseRef('[[section]]\nname = "x"\n', {}, "github:o/r");
  expect(created.added).toBe(true);
  expect(created.text).toContain('use = ["github:o/r"]');
  // already present → no change.
  const same = insertUseRef(created.text, { use: ["github:o/r"] }, "github:o/r");
  expect(same.added).toBe(false);
  expect(same.text).toBe(created.text);
  // existing single-line array → splice in, preserving the comment after it.
  const spliced = insertUseRef('use = ["a"] # keep\n[[section]]\nname="x"\n', { use: ["a"] }, "b");
  expect(spliced.text).toContain("# keep");
  expect(spliced.text).toContain('"b"');
});

test("module search: reports a matching pack via the reporter", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  await run(app, ["module", "search", "rust"], sb.ctx);
  expect(sb.ctx.process.exitCode).toBe(0);
  expect(sb.out()).toContain("rust");
});

test("module add: appends the ref to `use`, is idempotent, and loadConfig sees it", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  await run(app, ["module", "add", "node-dev"], sb.ctx);
  expect(sb.ctx.process.exitCode).toBe(0);
  const ref = "github:alxjrvs/boom-mod-node-dev";
  expect((await loadConfig(sb.repo)).use).toContain(ref);
  expect(sb.out()).toContain(ref);

  // second add → skip, not a duplicate.
  sb.ctx.process.exitCode = 0;
  await run(app, ["module", "add", "node-dev"], sb.ctx);
  expect(sb.ctx.process.exitCode).toBe(0);
  const use = (await loadConfig(sb.repo)).use ?? [];
  expect(use.filter((r) => r === ref)).toHaveLength(1);
  expect(sb.out()).toContain("already");
});

test("module add: an unknown pack fails with a hint to search", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  await run(app, ["module", "add", "no-such-pack"], sb.ctx);
  expect(sb.ctx.process.exitCode).toBe(1);
  expect(sb.out()).toContain("module search");
});

// --- fleet awareness ----------------------------------------------------------------------

test("fleet: summary write is idempotent and round-trips through readMachines", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  const summary = machineSummary(sb.env, "ok");
  expect(await writeMachineSummary(sb.repo, summary)).toBe(true); // first write
  expect(await writeMachineSummary(sb.repo, summary)).toBe(false); // unchanged → no rewrite (low churn)
  const machines = await readMachines(sb.repo);
  expect(machines).toHaveLength(1);
  expect(machines[0]?.host).toBe("testhost");
});

test("fleet: an enabled sync records a summary; boom fleet reports it", async () => {
  const sb = await sandbox('[boom]\nfleet = true\n[[section]]\nname = "x"\n');
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.repo, ".boom", "machines", "testhost.json"))).toBe(true);
  expect(await boomFleet(sb.ctx)).toBe(0);
  expect(sb.out()).toContain("testhost (this machine)");
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

// --- drift notifications ------------------------------------------------------------------

test("notifyArgv: platform-correct commands, undefined where boom has no notifier", () => {
  expect(notifyArgv("darwin", "boom", "drift")?.[0]).toBe("osascript");
  expect(notifyArgv("linux", "boom", "drift")).toEqual(["notify-send", "boom", "drift"]);
  expect(notifyArgv("unknown", "boom", "drift")).toBeUndefined();
});

// --- adopt --------------------------------------------------------------------------------

test("adopt: writes a reviewable proposal even on a bare machine (no managers)", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n', { emptyPath: true });
  const out = join(sb.base, "proposal");
  expect(await adopt(sb.ctx, { out })).toBe(0);
  const file = join(out, "boomfile.toml");
  expect(await pathExists(file)).toBe(true);
  const text = await Bun.file(file).text();
  expect(text).toContain("generated by `boom adopt`");
  expect(text).toContain("Not auto-detected"); // the scaffold for what boom can't infer
});

test("adopt: refuses to overwrite an existing proposal without --force", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n', { emptyPath: true });
  const out = join(sb.base, "proposal");
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "boomfile.toml"), "# existing\n");
  expect(await adopt(sb.ctx, { out })).toBe(1);
  expect(sb.out()).toContain("already exists");
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

// --- fleet drift / diff -------------------------------------------------------------------

test("fleet drift: flags only machines behind on version or with an unclean last sync", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  await writeMachineSummary(sb.repo, {
    host: "alpha",
    os: "darwin",
    boom: "0.17.0",
    verdict: "ok",
    date: "2026-07-10",
  });
  await writeMachineSummary(sb.repo, {
    host: "bravo",
    os: "linux",
    boom: "0.16.0",
    verdict: "ok",
    date: "2026-07-09",
  }); // behind newest
  await writeMachineSummary(sb.repo, {
    host: "charlie",
    os: "linux",
    boom: "0.17.0",
    verdict: "warn",
    date: "2026-07-11",
  }); // not clean
  const rc = await fleetDrift(sb.ctx);
  const out = sb.out();
  expect(out).toContain("bravo");
  expect(out).toContain("behind v0.17.0");
  expect(out).toContain("charlie");
  expect(out).not.toContain("alpha"); // current + clean → not flagged
  expect(rc).toBe(2); // warning tier
});

test("fleet drift: a fleet that's all-current is a clean pass", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  await writeMachineSummary(sb.repo, {
    host: "alpha",
    os: "darwin",
    boom: "0.17.0",
    verdict: "ok",
    date: "2026-07-10",
  });
  await writeMachineSummary(sb.repo, {
    host: "bravo",
    os: "linux",
    boom: "0.17.0",
    verdict: "ok",
    date: "2026-07-10",
  });
  const rc = await fleetDrift(sb.ctx);
  expect(sb.out()).toContain("all 2 machine(s) current + clean");
  expect(rc).toBe(0);
});

test("fleet diff: surfaces the fields where two machines differ", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  await writeMachineSummary(sb.repo, {
    host: "alpha",
    os: "darwin",
    boom: "0.17.0",
    verdict: "ok",
    date: "2026-07-10",
  });
  await writeMachineSummary(sb.repo, {
    host: "bravo",
    os: "linux",
    boom: "0.16.0",
    verdict: "ok",
    date: "2026-07-10",
  });
  const rc = await fleetDiff(sb.ctx, "alpha", "bravo");
  const out = sb.out();
  expect(out).toContain("boom: alpha=v0.17.0 · bravo=v0.16.0");
  expect(out).toContain("os: alpha=darwin · bravo=linux");
  expect(out).toContain("2 field(s) differ"); // verdict + date match → held back as skips
  expect(rc).toBe(0); // informational
});

test("fleet diff: an unrecorded host is a hard failure", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  await writeMachineSummary(sb.repo, {
    host: "alpha",
    os: "darwin",
    boom: "0.17.0",
    verdict: "ok",
    date: "2026-07-10",
  });
  const rc = await fleetDiff(sb.ctx, "alpha", "ghost");
  expect(sb.out()).toContain("no summary for ghost");
  expect(rc).toBe(1);
});

// --- init (cold-start lifecycle) ----------------------------------------------------------

// An init driver over a *git-only* PATH: a bin dir holding just a `git` symlink, so adopt's
// package-manager probes all miss (a hermetic bare proposal) while `git init`/commit still work,
// and `gh` is deliberately absent so the real remote-create path is never exercised. Git identity
// rides on GIT_AUTHOR_*/GIT_COMMITTER_* env vars so a commit needs no ambient git config.
async function initDriver(
  sb: Sandbox,
): Promise<{ ctx: BoomContext; env: Record<string, string | undefined>; out(): string }> {
  const bin = join(sb.base, "git-bin");
  await mkdir(bin, { recursive: true });
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git not found on PATH — required for the init tests");
  await symlink(realGit, join(bin, "git"));
  const env: Record<string, string | undefined> = {
    ...sb.env,
    PATH: bin,
    // Fully hermetic git: no system (NOSYSTEM, inherited) *and* no global config, so a developer's
    // ~/.gitconfig (e.g. a global husky pre-commit hook, or commit signing) can't leak in and
    // break the sandbox commit. Identity rides on the GIT_*_NAME/EMAIL vars below.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "boom test",
    GIT_AUTHOR_EMAIL: "test@boom.dev",
    GIT_COMMITTER_NAME: "boom test",
    GIT_COMMITTER_EMAIL: "test@boom.dev",
  };
  const buf = { out: "" };
  const write = (s: string): void => {
    buf.out += s;
  };
  const proc = { stdout: { write }, stderr: { write }, env, exitCode: 0 };
  const ctx = { process: proc, env, cwd: sb.base } as unknown as BoomContext;
  return { ctx, env, out: () => buf.out };
}

test("init --dry-run reports the planned steps and mutates nothing", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  const drv = await initDriver(sb);
  const target = join(sb.base, "cfg");
  expect(await boomInit(drv.ctx, { dir: target, repo: "me/dots", dryRun: true })).toBe(0);
  // Nothing on disk: no target dir, no breadcrumb.
  expect(await pathExists(target)).toBe(false);
  expect(await readConfigBreadcrumb(drv.env)).toBeUndefined();
  expect(drv.out()).toContain("scaffold a boomfile.toml proposal");
  expect(drv.out()).toContain("git init");
});

test("init --no-push scaffolds, inits + commits a repo, and records the breadcrumb", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  const drv = await initDriver(sb);
  const target = join(sb.base, "cfg");
  expect(await boomInit(drv.ctx, { dir: target, repo: "me/dots", noPush: true })).toBe(0);
  // adopt scaffolded the proposal, git init created the repo, and a commit landed.
  expect(await pathExists(join(target, "boomfile.toml"))).toBe(true);
  expect(await pathExists(join(target, ".git"))).toBe(true);
  expect(headSha(target, drv.env)).toBeDefined();
  // The breadcrumb points boom at the new repo, with the derived remote URL.
  const crumb = await readConfigBreadcrumb(drv.env);
  expect(crumb?.path).toBe(target);
  expect(crumb?.remote.url).toBe("https://github.com/me/dots.git");
});

test("init into an existing non-empty repo without --force fails cleanly", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n');
  const drv = await initDriver(sb);
  const target = join(sb.base, "existing");
  await mkdir(target, { recursive: true });
  // Seed an established repo (a commit) with git so the guard has history to refuse over. Reuse the
  // driver's hermetic env (git-only PATH, no system/global config) so the seed commit reliably
  // lands — otherwise the guard has no HEAD to detect and the test wouldn't exercise it.
  const git = (...a: string[]): void => {
    Bun.spawnSync(["git", "-C", target, ...a], { stdout: "ignore", stderr: "ignore", env: drv.env });
  };
  git("init", "-q", "-b", "main");
  await writeFile(join(target, "keep.txt"), "precious\n");
  git("-c", "user.email=t@t.com", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "seed");

  expect(await boomInit(drv.ctx, { dir: target, repo: "me/dots", noPush: true })).toBe(1);
  expect(drv.out()).toContain("already a git repo with commits");
  // The guard fired before adopt — the existing content is untouched.
  expect(await pathExists(join(target, "keep.txt"))).toBe(true);
  expect(await pathExists(join(target, "boomfile.toml"))).toBe(false);
});
