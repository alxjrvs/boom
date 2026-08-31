// launchd helpers — the one place the "manage a macOS LaunchAgent" incantation lives, used by
// the `launchd` resource to link and drive the lifecycle of a USER-AUTHORED plist. boom no
// longer generates plists of its own: `[boom] schedule` was removed, and with it the renderer,
// the interval parser and the PATH-snapshot comparison that only a generated plist needed.
// Every launchctl call is darwin-only; callers OS-gate before reaching here.
import { join } from "node:path";
import type { Env } from "./paths.ts";
import { captureArgv } from "./proc.ts";

// ~/Library/LaunchAgents — where per-user LaunchAgents live (loaded at login). Undefined
// without HOME, so a caller can refuse rather than write to a relative path.
export function launchAgentsDir(env: Env): string | undefined {
  return env.HOME ? join(env.HOME, "Library", "LaunchAgents") : undefined;
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
// This exists because "loaded" and "working" are different questions, and boom only ever asked
// the first. An agent can be installed, loaded, firing and failing every single time, reporting
// only into its own log — which is exactly what a since-removed fetch timer did for a month.
//
// Worth stating plainly now that `schedule` is gone: this is a weaker check than it was. It
// covers whatever hand-authored agents a boomfile links, and those are typically RunAtLoad
// rather than timers, so "last exit" says much less about them than it did about a job firing
// on an interval with nobody watching. Kept because it costs one launchctl call and still
// answers the question for any agent that does fail.
export function agentLastExit(label: string, env: Env): number | undefined {
  const r = captureArgv(["launchctl", "list", label], env);
  if (r.code !== 0) return undefined;
  // `launchctl list <label>` prints a plist-ish dict: 	"LastExitStatus" = 0;
  const m = r.stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
  if (!m?.[1]) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}
