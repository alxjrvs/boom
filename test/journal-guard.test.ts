// The journal is a crash-recovery log: rollback and --resume read it precisely after an
// interrupted run. A crash mid-append can leave a torn final line — parsing it must skip
// that record, not throw out of the recovery path. Guards journal.ts's `records()`.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns, readRun } from "../src/engine/journal.ts";
import { journalDir } from "../src/engine/state.ts";

test("readRun / listRuns survive a torn trailing line", async () => {
  const env = { XDG_STATE_HOME: await mkdtemp(join(tmpdir(), "boom-jrn-")) };
  const dir = journalDir(env);
  await mkdir(dir, { recursive: true });
  const id = "2020-01-01T00-00-00-000Z-1-0000";
  const good = JSON.stringify({ t: "done", op: "link", dst: "/x", undo: { kind: "remove" } });
  // one good record, a committed marker, then a half-written final record (crash mid-write)
  await writeFile(join(dir, `${id}.ndjson`), `${good}\n${JSON.stringify({ t: "committed" })}\n{"t":"do`);

  const run = await readRun(env);
  expect(run?.done).toHaveLength(1);
  expect(run?.done[0]?.dst).toBe("/x");

  const runs = await listRuns(env);
  expect(runs[0]?.ops).toBe(1);
  expect(runs[0]?.committed).toBe(true);
});
