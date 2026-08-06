// Desktop notifications — the escape hatch for a *scheduled* `boom verify` finding drift, so the
// signal reaches you instead of dying as an exit code in a launchd timer log. macOS uses
// osascript's `display notification`; Linux uses `notify-send`. Best-effort by design: no
// notifier on PATH (or a headless session where osascript fails) is a silent no-op, never an error.
import { detectOs, type OsKind } from "../config/profile.ts";
import type { Env } from "./paths.ts";
import { cleanEnv, hasCommand } from "./proc.ts";

// AppleScript string literal: double-quoted with `\` and `"` escaped. boom's own copy is the only
// input, but escaping keeps a hostname with a quote from breaking the -e expression regardless.
function asAppleScript(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// The notifier argv for an OS (or undefined where boom has none) — a pure function, split from the
// spawn so the command construction is unit-testable without a real notifier on PATH.
export function notifyArgv(os: OsKind, title: string, message: string): string[] | undefined {
  if (os === "darwin")
    return [
      "osascript",
      "-e",
      `display notification ${asAppleScript(message)} with title ${asAppleScript(title)}`,
    ];
  if (os === "linux") return ["notify-send", title, message];
  return undefined;
}

// Fire a desktop notification, returning whether one was actually dispatched. Falls back to false
// when the platform has no notifier or its tool isn't installed — the caller reports the drift
// either way; the notification is a courtesy, not the source of truth.
export function notify(env: Env, title: string, message: string): boolean {
  const argv = notifyArgv(detectOs(env), title, message);
  if (!argv || !hasCommand(argv[0] as string, env)) return false;
  Bun.spawnSync(argv, { env: cleanEnv(env), stdout: "ignore", stderr: "ignore" });
  return true;
}
