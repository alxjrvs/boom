// The apply transaction journal: an append-only NDJSON log per run. Each mutation
// writes an `intent` then a `done` (with an undo token); a clean run ends `committed`.
// rollback replays `done` records in reverse; --resume skips destinations already done.
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Env, journalDir } from "./state.ts";

// How to reverse one mutation: remove what we created, or restore a backed-up file.
export type UndoToken = { kind: "remove" } | { kind: "restore"; from: string };

export interface DoneRecord {
  t: "done";
  op: string;
  dst: string;
  undo: UndoToken;
}

export function newRunId(): string {
  // ISO timestamp (lexically sortable = chronological) + pid for intra-machine uniqueness.
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

export class Journal {
  private readonly file: string;
  readonly runId: string;

  constructor(env: Env, runId: string) {
    this.runId = runId;
    this.file = join(journalDir(env), `${runId}.ndjson`);
  }

  private async append(obj: unknown): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(obj)}\n`);
  }

  intent(op: string, dst: string): Promise<void> {
    return this.append({ t: "intent", op, dst });
  }
  done(op: string, dst: string, undo: UndoToken): Promise<void> {
    return this.append({ t: "done", op, dst, undo });
  }
  commit(): Promise<void> {
    return this.append({ t: "committed" });
  }
}

// Read a run's `done` records (the most recent run if `runId` is omitted).
export async function readRun(
  env: Env,
  runId?: string,
): Promise<{ runId: string; done: DoneRecord[] } | undefined> {
  const dir = journalDir(env);
  let id = runId;
  if (!id) {
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith(".ndjson")).sort();
      id = files.at(-1)?.replace(/\.ndjson$/, "");
    } catch {
      return undefined;
    }
  }
  if (!id) return undefined;
  let text: string;
  try {
    text = await readFile(join(dir, `${id}.ndjson`), "utf8");
  } catch {
    return undefined;
  }
  const done: DoneRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const rec = JSON.parse(line) as { t: string };
    if (rec.t === "done") done.push(rec as DoneRecord);
  }
  return { runId: id, done };
}
