// The sqlite-backed journal (db.ts/journal.ts): ops/sides round-trip, and — the crash-
// recovery property that used to need a torn-line guard on the NDJSON log — an interrupted
// run (never committed, its connection never closed) is still fully readable by a fresh
// connection, because each row is committed atomically as it's written.
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, listRuns, readRun } from "../src/engine/journal.ts";

async function stateEnv(): Promise<{ XDG_STATE_HOME: string }> {
  return { XDG_STATE_HOME: await mkdtemp(join(tmpdir(), "boom-jrn-")) };
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
