// Where boom's own state lives on disk, and the one alias for a process environment.
// Pure `join()` — nothing here touches the filesystem, so every layer (`lib/`, `config/`)
// can depend on it without importing *upward* into the engine just to spell a path. Layout:
//   ${XDG_STATE_HOME:-~/.local/state}/boom/
//     state.db          bun:sqlite store (manifest + journal) — see engine/db.ts
//     backups/<run-id>/ files displaced by an overwrite — recovered by hand, not by a verb
//     lock              the run mutex — see lib/lock.ts
import { join } from "node:path";

// A process environment. Declared here rather than in `lib/proc.ts` so a module can name
// an env without importing the process-spawning surface.
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
