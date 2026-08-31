// Where boom's own state lives on disk, and the one alias for a process environment.
// Pure `join()` — nothing here touches the filesystem, so every layer can depend on it
// without depending on the engine. That is the point: these helpers used to live in
// `engine/state.ts`, which made `lib/lock.ts` and four `config/` modules import *upward*
// into the engine just to spell a path. Layout:
//   ${XDG_STATE_HOME:-~/.local/state}/boom/
//     state.db          bun:sqlite store (manifest + journal) — see engine/db.ts
//     backups/<run-id>/ files displaced by an overwrite, so uninstall can restore
//     lock              the run mutex — see lib/lock.ts
import { join } from "node:path";

// A process environment. Declared here rather than in `lib/proc.ts` so a module can name
// an env without importing the process-spawning surface (four duplicate local aliases had
// grown up around exactly that).
export type Env = Record<string, string | undefined>;

export function stateHome(env: Env): string {
  return env.XDG_STATE_HOME ?? join(env.HOME ?? "", ".local", "state");
}
export function boomStateDir(env: Env): string {
  return join(stateHome(env), "boom");
}
export function backupsDir(env: Env): string {
  return join(boomStateDir(env), "backups");
}
