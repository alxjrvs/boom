// The sqlite-backed journal (db.ts/journal.ts): ops/sides round-trip, and — the crash-
// recovery property that used to need a torn-line guard on the NDJSON log — an interrupted
// run (never committed, its connection never closed) is still fully readable by a fresh
// connection, because each row is committed atomically as it's written. Plus the transaction
// contract itself: the undo record lands before the write, and `committed` lands after the
// last phase that can fail.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileContext } from "../src/config/profile.ts";
import { withDb } from "../src/engine/db.ts";
import { Journal, journalWrite, listRuns, readRun } from "../src/engine/journal.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import type { ReconcileCtx } from "../src/engine/types.ts";
import { pathExists } from "../src/lib/fs.ts";
import type { Env } from "../src/lib/paths.ts";
import { Reporter } from "../src/lib/reporter.ts";
import { makeSandbox, type Sandbox } from "./support/sandbox.ts";

const sandbox = (boomfile: string): Promise<Sandbox> => makeSandbox(boomfile, { prefix: "boom-jrng-" });

async function stateEnv(): Promise<{ XDG_STATE_HOME: string }> {
  return { XDG_STATE_HOME: await mkdtemp(join(tmpdir(), "boom-jrn-")) };
}

// Sandboxed $HOME + $XDG_STATE_HOME + config repo, driving reconcile() in-process (the shape
// resources-new.test.ts uses). Nothing here touches the real machine.
// The ONE place this file constructs a ReconcileCtx. Every field but `journal`/`backupRoot` is
// required, so a bare literal per test would mean editing N of them the next time the interface
// grows a field — and a `as unknown as ReconcileCtx` cast would erase the very type the
// no-journal test exists to exercise. Add new required fields here, once.
function ctxFor(env: Env, over: Partial<ReconcileCtx> = {}): ReconcileCtx {
  const sink = { write: (_: string): void => {} };
  return {
    repo: "/nonexistent-repo",
    verb: "sync",
    dryRun: false,
    json: false,
    linkMode: "skip",
    update: false,
    verbose: false,
    env,
    vars: {},
    profile: profileContext(env, []),
    report: new Reporter({ out: sink, err: sink }, { color: false }),
    declared: [],
    ownershipIncomplete: false,
    dirty: new Set<string>(),
    ...over,
  };
}

test("journal round-trips done ops + side effects and marks the run committed", async () => {
  const env = await stateEnv();
  const j = new Journal(env, "run-a");
  await j.intent("link", "/x");
  await j.done("link", "/x", { kind: "remove" });
  await j.side("run", "echo hi");
  j.markCommitted();
  j.close();

  const run = await readRun(env);
  expect(run?.runId).toBe("run-a");
  expect(run?.done).toHaveLength(1);
  expect(run?.done[0]?.dst).toBe("/x");
  expect(run?.done[0]?.undo).toEqual({ kind: "remove" });
  expect(run?.sides[0]?.label).toBe("echo hi");

  const runs = await listRuns(env);
  expect(runs[0]?.ops).toBe(1);
  expect(runs[0]?.sides).toBe(1);
  expect(runs[0]?.committed).toBe(true);
});

test("an interrupted (uncommitted) run is still readable by a fresh connection", async () => {
  const env = await stateEnv();
  const j = new Journal(env, "run-b");
  await j.done("link", "/y", { kind: "remove" });
  // no commit() and no close() — simulates a crash mid-run; the row is already durable.
  const runs = await listRuns(env);
  expect(runs[0]?.committed).toBe(false);
  expect(runs[0]?.ops).toBe(1);
  expect((await readRun(env))?.done[0]?.dst).toBe("/y");
});

// ---------------------------------------------------------- undo-before-write (the invariant)

// A boomfile that exercises the write paths which journal: a link over a conflicting file, a
// copy, and a rendered template — the three that hand-inlined intent/displace/done.
const WRITERS = `[[section]]
name = "W"

[[section.link]]
src = "src.txt"
dst = "~/linked.txt"

[[section.copy]]
src = "src.txt"
dst = "~/copied.txt"

[[section.tmpl]]
src = "t.tmpl"
dst = "~/rendered.txt"
`;

// The structural guard behind this whole invariant. `intent(op, dst, plan)` takes the undo token
// the mutation is ABOUT to become, and BOTH orphan readers filter `AND undo IS NOT NULL` — so an
// intent row without one is invisible to `rollback` and counts as 0 in `rollback --list`. Seven
// sites used to hand-inline intent→displace→done and omit the token, leaving exactly that hole
// for any crash between the displace and the `done`.
//
// Asserted over the whole ops table rather than per-site on purpose: this fails for a NEW writer
// that inlines the sequence too, which is the failure mode that produced the original seven.
test("every intent row names its own undo (rollback cannot see one that does not)", async () => {
  const sb = await sandbox(WRITERS);
  await writeFile(join(sb.repo, "src.txt"), "hello");
  await writeFile(join(sb.repo, "t.tmpl"), "value={{ host }}\n");
  // A conflicting file at the link destination forces the overwrite arm (the one that displaces).
  await writeFile(join(sb.home, "linked.txt"), "in the way");

  expect(await reconcile("sync", sb.ctx, { linkMode: "overwrite" })).toBe(0);

  const nullPlans = withDb(
    sb.env,
    (db) =>
      db.query("SELECT op, dst FROM ops WHERE t = 'intent' AND undo IS NULL").all() as {
        op: string;
        dst: string;
      }[],
  );
  expect(nullPlans).toEqual([]);
  // Guard the guard: if the sync journaled nothing, the assertion above is vacuously true.
  const intents = withDb(
    sb.env,
    (db) => (db.query("SELECT COUNT(*) AS n FROM ops WHERE t = 'intent'").get() as { n: number }).n,
  );
  expect(intents).toBeGreaterThan(0);
});

// `<home>/.claude/skills/boom` as a regular FILE makes applySkill's `mkdir(dirname(SKILL.md))`
// throw ENOTDIR — a failure sited exactly between the journal write and the file write, which
// is the window the old "write `done` after the write succeeds" ordering left unrecoverable.
const BOOM_SKILL = `[boom]\nskill_on_sync = true\n\n[[section]]\nname = "S"\n`;

async function blockSkillWrite(home: string): Promise<void> {
  await mkdir(join(home, ".claude", "skills"), { recursive: true });
  await writeFile(join(home, ".claude", "skills", "boom"), "not a directory");
}

test("the [boom] skill write journals its undo BEFORE the write", async () => {
  const sb = await sandbox(BOOM_SKILL);
  await blockSkillWrite(sb.home);

  expect(await reconcile("sync", sb.ctx, {})).toBe(1);
  // The discriminating assertion: under the old ordering the write threw before `done` was
  // ever called, so the run held no record of a mutation it had already begun.
  expect((await readRun(sb.env))?.done.some((r) => r.op === "skill")).toBe(true);
});

test("a run whose self-wiring failed is not marked committed", async () => {
  const sb = await sandbox(BOOM_SKILL);
  await blockSkillWrite(sb.home);

  expect(await reconcile("sync", sb.ctx, {})).toBe(1);
  // markCommitted used to be decided before applyBoomSettings ran, so this returned true and
  // `rollback --list` called a half-applied run clean.
  expect((await listRuns(sb.env))[0]?.committed).toBe(false);
});

test("the skill write displaces the prior file into the backup tree the journal names", async () => {
  const sb = await sandbox(BOOM_SKILL);
  const file = join(sb.home, ".claude", "skills", "boom", "SKILL.md");
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "OLD");

  expect(await reconcile("sync", sb.ctx, {})).toBe(0);
  const rec = (await readRun(sb.env))?.done.find((r) => r.op === "skill");
  expect(rec?.undo.kind).toBe("restore");
  const from = rec?.undo.kind === "restore" ? rec.undo.from : "";
  expect(await pathExists(from)).toBe(true);
  expect(await Bun.file(from).text()).toBe("OLD");
});

test("journalWrite is a no-op with no journal", async () => {
  const env = await stateEnv();
  const dir = await mkdtemp(join(tmpdir(), "boom-nojrn-"));
  const file = join(dir, "keepme");
  await writeFile(file, "MINE");

  // No journal and no backupRoot — a verify or dry run. `displace` would fall through to
  // `rm(file, { force: true })` here, so the guard has to be inside the helper, not at the
  // call site: this is the unit-level proof that it is.
  await journalWrite("x", file, ctxFor(env, { verb: "verify" }));
  expect(await Bun.file(file).text()).toBe("MINE");
});
