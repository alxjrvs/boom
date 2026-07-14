// launchd helpers — the one place the "manage a macOS LaunchAgent" incantation lives, shared
// by the `launchd` resource (link + lifecycle a user-authored plist) and the boom-owned
// schedulers (`verify_schedule`/`code_fetch_schedule`, which generate their own plist). Every
// launchctl call is darwin-only; callers OS-gate before reaching here. Pure builders
// (parseInterval/renderAgentPlist/plistLabel) are unit-tested without touching launchctl.
import { join } from "node:path";
import type { Env } from "./proc.ts";
import { captureArgv } from "./proc.ts";

// ~/Library/LaunchAgents — where per-user LaunchAgents live (loaded at login). Undefined
// without HOME, so a caller can refuse rather than write to a relative path.
export function launchAgentsDir(env: Env): string | undefined {
  return env.HOME ? join(env.HOME, "Library", "LaunchAgents") : undefined;
}

// Normalize a schedule interval ("15m", "1h", "30s", or bare seconds) into whole seconds for
// launchd's StartInterval. The regex in schema.ts (IntervalSchema) already constrains the
// shape, so a malformed value fails at config load, not here.
export function parseInterval(spec: string): number {
  const m = spec.match(/^(\d+)([smh]?)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  switch (m[2]) {
    case "h":
      return n * 3600;
    case "m":
      return n * 60;
    default:
      return n; // "s" or bare seconds
  }
}

// XML-escape a value going into a plist <string>. Paths and argv can contain & or <.
function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface AgentPlist {
  readonly label: string;
  readonly programArgs: readonly string[];
  readonly startInterval: number;
  // Run once immediately when the agent is (re)loaded, in addition to the interval. Default
  // false — a scheduled check shouldn't fire a heavy pass at every login/sync.
  readonly runAtLoad?: boolean;
  // Where the agent's stdout/stderr go (a log under the state dir), so a failing scheduled
  // run leaves a trace instead of vanishing.
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
}

// Render a minimal, well-formed LaunchAgent plist. Deterministic (no timestamps) so an
// unchanged config re-renders byte-identical and the sync is a no-op.
export function renderAgentPlist(opts: AgentPlist): string {
  const args = opts.programArgs.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(opts.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>StartInterval</key>",
    `  <integer>${Math.max(1, Math.trunc(opts.startInterval))}</integer>`,
    "  <key>RunAtLoad</key>",
    `  <${opts.runAtLoad ? "true" : "false"}/>`,
  ];
  if (opts.stdoutPath)
    lines.push("  <key>StandardOutPath</key>", `  <string>${xml(opts.stdoutPath)}</string>`);
  if (opts.stderrPath)
    lines.push("  <key>StandardErrorPath</key>", `  <string>${xml(opts.stderrPath)}</string>`);
  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
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
