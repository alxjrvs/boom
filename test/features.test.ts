// v0.17 feature surface: the secret resource, `use` modules, fleet awareness, named
// checkpoints, boom.lock, drift notifications, adopt, and doctor --fix. Each is exercised
// against a fully sandboxed $HOME + state dir (never the real machine), like engine.test.ts.
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
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
  readRun,
  setRunLabel,
} from "../src/engine/journal.ts";
import { boomStatus } from "../src/engine/overview.ts";
import { boomLock, readLock, writeLock } from "../src/engine/pinning.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { checkpoint, rollback, rollbackTo } from "../src/engine/rollback.ts";
import { linkTarget, pathExists } from "../src/lib/fs.ts";
import { headSha } from "../src/lib/git.ts";
import { acquireLock } from "../src/lib/lock.ts";
import { notifyArgv } from "../src/lib/notify.ts";
import { backupsDir } from "../src/lib/paths.ts";

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

// --- module-shipped files (section origin) ------------------------------------------------

test("modules: a module ships a file beside its own boomfile", async () => {
  // The audit's exact reproduction: before sections carried an origin, `src = "vimrc"` resolved
  // against the BASE repo and the module's own file reported "source missing — not linked".
  const sb = await sandbox('use = ["./mod"]\n[[section]]\nname = "local"\n');
  const mod = join(sb.repo, "mod");
  await mkdir(mod, { recursive: true });
  await writeFile(join(mod, "vimrc"), 'set nocompatible"\n');
  await writeFile(
    join(mod, "boomfile.toml"),
    '[[section]]\nname = "vim"\nlink = [{ src = "vimrc", dst = "~/.vimrc" }]\n',
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await linkTarget(join(sb.home, ".vimrc"))).toBe(join(mod, "vimrc"));
});

test("modules: a NESTED module's file resolves against the NESTED module's dir", async () => {
  const sb = await sandbox('use = ["./mod-a"]\n[[section]]\nname = "local"\n');
  const modA = join(sb.repo, "mod-a");
  const modB = join(modA, "mod-b");
  await mkdir(modB, { recursive: true });
  await writeFile(join(modA, "boomfile.toml"), 'use = ["./mod-b"]\n[[section]]\nname = "a"\n');
  await writeFile(join(modB, "gitconfig"), "[user]\n");
  await writeFile(
    join(modB, "boomfile.toml"),
    '[[section]]\nname = "b"\nlink = [{ src = "gitconfig", dst = "~/.gitconfig" }]\n',
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  // Not mod-a: the recursion stamps each level with its OWN dir.
  expect(await linkTarget(join(sb.home, ".gitconfig"))).toBe(join(modB, "gitconfig"));
});

test("modules: a module-shipped link is reaped once the module leaves `use`", async () => {
  // The module lives OUTSIDE the config repo, so reaping cannot fall back on "the target starts
  // with the repo path" — it has to match the src the manifest recorded.
  const mod = await mkdtemp(join(tmpdir(), "boom-mod-"));
  const sb = await sandbox(`use = ["${mod}"]\n[[section]]\nname = "local"\n`);
  await writeFile(join(mod, "vimrc"), "set nocompatible\n");
  await writeFile(
    join(mod, "boomfile.toml"),
    '[[section]]\nname = "vim"\nlink = [{ src = "vimrc", dst = "~/.vimrc" }]\n',
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await linkTarget(join(sb.home, ".vimrc"))).toBe(join(mod, "vimrc"));

  await writeFile(join(sb.repo, "boomfile.toml"), '[[section]]\nname = "local"\n');
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".vimrc"))).toBe(false);
  expect(sb.out()).toContain("reaped orphan");
});

test("modules: a module section whose dst resolves into the module dir is refused", async () => {
  // Pins that Layer 1's repo-self-link guard follows the origin swap: `~/.config/nvim` is a
  // symlink INTO the module, so the module's own link would land inside the module's sources.
  const sb = await sandbox('use = ["./mod"]\n[[section]]\nname = "local"\n');
  const mod = join(sb.repo, "mod");
  await mkdir(join(mod, "nvim"), { recursive: true });
  await writeFile(join(mod, "nvim", "init.lua"), "-- init\n");
  await writeFile(
    join(mod, "boomfile.toml"),
    '[[section]]\nname = "nvim"\nlink = [{ src = "nvim/init.lua", dst = "~/.config/nvim/init.lua" }]\n',
  );
  await mkdir(join(sb.home, ".config"), { recursive: true });
  await symlink(join(mod, "nvim"), join(sb.home, ".config", "nvim"));
  expect(await reconcile("sync", sb.ctx, { linkMode: "overwrite" })).toBe(1);
  expect(sb.out()).toContain("refusing to link the repo into itself");
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

// --- adopt --from <manager> (migration importers) -----------------------------------------

test("adopt --from stow: mirrors a package's files into link entries under ~", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n', { emptyPath: true });
  await mkdir(join(sb.home, ".dotfiles", "vim"), { recursive: true });
  await writeFile(join(sb.home, ".dotfiles", "vim", ".vimrc"), "set nocompatible\n");
  await mkdir(join(sb.home, ".dotfiles", "git", ".config", "git"), { recursive: true });
  await writeFile(join(sb.home, ".dotfiles", "git", ".config", "git", "config"), "[user]\n");
  const out = join(sb.base, "proposal");
  expect(await adopt(sb.ctx, { out, from: "stow" })).toBe(0);
  const text = await Bun.file(join(out, "boomfile.toml")).text();
  expect(text).toContain("Imported from stow");
  expect(text).toContain("[[section.link]]");
  expect(text).toContain('dst = "~/.vimrc"');
  expect(text).toContain('dst = "~/.config/git/config"');
});

test("adopt --from chezmoi: translates dot_/attribute prefixes to ~ targets", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n', { emptyPath: true });
  const src = join(sb.home, ".local", "share", "chezmoi");
  await mkdir(join(src, "private_dot_config", "nvim"), { recursive: true });
  await writeFile(join(src, "dot_zshrc"), "export A=1\n");
  await writeFile(join(src, "private_dot_config", "nvim", "init.lua"), "-- nvim\n");
  await writeFile(join(src, "dot_gitconfig.tmpl"), "[user]\n  name = {{ .name }}\n");
  const out = join(sb.base, "proposal");
  expect(await adopt(sb.ctx, { out, from: "chezmoi" })).toBe(0);
  const text = await Bun.file(join(out, "boomfile.toml")).text();
  expect(text).toContain('dst = "~/.zshrc"');
  expect(text).toContain('dst = "~/.config/nvim/init.lua"');
  // the .tmpl becomes a scaffold note, not a bogus copy entry
  expect(text).toContain("chezmoi template");
  expect(text).not.toContain('dst = "~/.gitconfig"');
});

test("adopt --from dotbot: parses the link: map into link entries", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n', { emptyPath: true });
  await mkdir(join(sb.home, ".dotfiles"), { recursive: true });
  await writeFile(
    join(sb.home, ".dotfiles", "install.conf.yaml"),
    "- link:\n    ~/.vimrc: vim/vimrc\n    ~/.zshrc:\n      path: zsh/zshrc\n      create: true\n",
  );
  const out = join(sb.base, "proposal");
  expect(await adopt(sb.ctx, { out, from: "dotbot" })).toBe(0);
  const text = await Bun.file(join(out, "boomfile.toml")).text();
  expect(text).toContain('dst = "~/.vimrc"');
  expect(text).toContain('dst = "~/.zshrc"');
  expect(text).toContain('src = "~/.dotfiles/vim/vimrc"');
  expect(text).toContain('src = "~/.dotfiles/zsh/zshrc"');
});

test("adopt --from foo: fails and lists the supported managers", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n', { emptyPath: true });
  const out = join(sb.base, "proposal");
  expect(await adopt(sb.ctx, { out, from: "foo" })).toBe(1);
  expect(sb.out()).toContain("unknown --from");
  expect(sb.out()).toContain("stow");
  expect(sb.out()).toContain("chezmoi");
  expect(sb.out()).toContain("dotbot");
});

test("adopt --from stow with no source dir: warns, writes an empty proposal", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\n', { emptyPath: true });
  const out = join(sb.base, "proposal");
  expect(await adopt(sb.ctx, { out, from: "stow" })).toBe(0);
  expect(sb.out()).toContain("no stow config found");
  expect(await pathExists(join(out, "boomfile.toml"))).toBe(true);
});

// ------------------------------------------------------- the run lock covers every writer

// The lock is keyed on pid and this suite runs in one process, so holding it here is exactly
// what a concurrent `boom source` looks like to the command under test.
const LINKED = `[[section]]\nname = "S"\nlink = [{ src = ".a", dst = "~/.a" }]\n`;

async function syncedSandbox(): Promise<Sandbox> {
  const sb = await sandbox(LINKED);
  await writeFile(join(sb.repo, ".a"), "a");
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  return sb;
}

test("uninstall refuses while another run holds the lock", async () => {
  const sb = await syncedSandbox();
  const release = acquireLock(sb.env);
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(1);
  expect(sb.out()).toContain("another boom run is in progress");
  expect(await pathExists(join(sb.home, ".a"))).toBe(true); // refused outright, not half torn down
  release();
  expect(await reconcile("uninstall", sb.ctx, {})).toBe(0);
  expect(await pathExists(join(sb.home, ".a"))).toBe(false);
});

test("rollback refuses while another run holds the lock", async () => {
  const sb = await syncedSandbox();
  const release = acquireLock(sb.env);
  expect(await rollback(sb.ctx)).toBe(1);
  expect(sb.out()).toContain("another boom run is in progress");
  expect(await pathExists(join(sb.home, ".a"))).toBe(true); // nothing was reversed
  release();
  expect(await rollback(sb.ctx)).toBe(0);
  expect(await pathExists(join(sb.home, ".a"))).toBe(false);
});

test("rollback --dry-run reads through a held lock", async () => {
  const sb = await syncedSandbox();
  const release = acquireLock(sb.env);
  // Deliberately unlocked: a read-only preview has to stay available for the length of a long
  // sync, even at the cost of the plan going stale.
  expect(await rollback(sb.ctx, undefined, true)).toBe(0);
  expect(sb.out()).toContain("would remove");
  expect(await pathExists(join(sb.home, ".a"))).toBe(true);
  release();
});

test("checkpoint refuses while another run holds the lock", async () => {
  const sb = await syncedSandbox();
  const release = acquireLock(sb.env);
  expect(await checkpoint(sb.ctx, "good")).toBe(1);
  expect(sb.out()).toContain("another boom run is in progress");
  expect(await findRunByLabel(sb.env, "good")).toBeUndefined(); // the label was never written
  release();
  expect(await checkpoint(sb.ctx, "good")).toBe(0);
});

// --- precedence: duplicate destinations resolve last-wins, end to end -----------------------

// A sandbox whose repo `use`s a local module, with both layers' link source files on disk.
// `modSection` / `baseSection` are the two `[[section]]` bodies that will fight over a dst.
async function twoLayerSandbox(modSection: string, baseSection: string): Promise<Sandbox> {
  const sb = await sandbox(`use = ["./mod"]\n${baseSection}`);
  await mkdir(join(sb.repo, "mod"), { recursive: true });
  await writeFile(join(sb.repo, "mod", "boomfile.toml"), modSection);
  await writeFile(join(sb.repo, "mod", "dotfile"), "from the module\n");
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
  expect(quiet.out()).toContain("~/.zshrc — link from ./mod overridden by link in boomfile.toml");

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

  // The user then adds the documented cross-kind override to their own boomfile.
  sb.env.MY_NETRC = "rendered\n";
  await writeFile(
    join(sb.repo, "boomfile.toml"),
    `use = ["./mod"]\n[[section]]\nname = "Base"\nsecret = [{ dst = "~/.netrc", ref = "env:MY_NETRC" }]\n`,
  );
  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  expect(await pathExists(dst)).toBe(true);
  expect(sb.out()).not.toContain("reaped orphan");
});
