// launchd helpers — the one place the "manage a macOS LaunchAgent" incantation lives, used by
// the `launchd` resource to link and drive the lifecycle of a USER-AUTHORED plist. boom
// generates no plists of its own. Every launchctl call is darwin-only; callers OS-gate before
// reaching here.
import { basename, join } from "node:path";
import type { Env } from "./paths.ts";
import { captureArgv } from "./proc.ts";

// ~/Library/LaunchAgents — where per-user LaunchAgents live (loaded at login). Undefined
// without HOME, so a caller can refuse rather than write to a relative path.
export function launchAgentsDir(env: Env): string | undefined {
  return env.HOME ? join(env.HOME, "Library", "LaunchAgents") : undefined;
}

// Where a `launchd` entry with no `dst` lands: `~/Library/LaunchAgents/<basename(src)>`. Shared
// by the resource and the composer, which keys duplicate destinations on the same answer.
export function defaultPlistDst(src: string, env: Env): string | undefined {
  const agents = launchAgentsDir(env);
  return agents ? join(agents, basename(src)) : undefined;
}

// Pull the <key>Label</key><string>…</string> value out of a plist's text, so verify can ask
// launchctl whether *that* agent is loaded. Undefined if the plist has no Label.
export function plistLabel(contents: string): string | undefined {
  const m = contents.match(/<key>\s*Label\s*<\/key>\s*<string>([^<]*)<\/string>/);
  return m?.[1]?.trim() || undefined;
}

// captureArgv (not runArgv) throughout: it maps a missing `launchctl` (a non-darwin box, a
// stripped test env) onto a failed result instead of throwing — so these degrade to "not
// loaded / load failed" rather than crashing the reconcile that called them.

// The idempotent reload dance every LaunchAgent needs: unload first (ignored if not loaded),
// then load -w. Returns whether the final load succeeded.
export function reloadAgent(plistPath: string, env: Env): boolean {
  captureArgv(["launchctl", "unload", plistPath], env); // best-effort
  return captureArgv(["launchctl", "load", "-w", plistPath], env).code === 0;
}

// Unload an agent (best-effort — a not-loaded agent is already in the desired state).
export function unloadAgent(plistPath: string, env: Env): void {
  captureArgv(["launchctl", "unload", plistPath], env);
}

// Is the named agent currently loaded? `launchctl list <label>` exits 0 iff it is.
export function agentLoaded(label: string, env: Env): boolean {
  return captureArgv(["launchctl", "list", label], env).code === 0;
}

// The exit status of the agent's last completed run, or undefined if it is not loaded, has
// never run, or launchctl said something we don't recognize.
//
// This exists because "loaded" and "working" are different questions. An agent can be installed,
// loaded, firing and failing every single time, reporting only into its own log — which nobody
// watches, by definition of the job being scheduled. One launchctl call answers it.
export function agentLastExit(label: string, env: Env): number | undefined {
  const r = captureArgv(["launchctl", "list", label], env);
  if (r.code !== 0) return undefined;
  // `launchctl list <label>` prints a plist-ish dict: 	"LastExitStatus" = 0;
  const m = r.stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
  if (!m?.[1]) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}
