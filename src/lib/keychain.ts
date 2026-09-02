// The macOS login-keychain item a 1Password service-account token lives in, and the one probe
// boom runs against it (`boom doctor`, engine/doctor.ts). The item name is exported separately
// so the report can name what it found.
import type { Env } from "./paths.ts";
import { cleanEnv } from "./proc.ts";

// The default is one particular machine's item name, so it is a default and not a constant:
// `BOOM_OP_KEYCHAIN_ITEM` overrides it. boom ships to other people, and a hardcoded literal made
// every one of their machines report a missing item they never created.
const DEFAULT_AGENT_KEYCHAIN_ITEM = "op-claude-agent";

export function agentKeychainItem(env: Env): string {
  const v = env.BOOM_OP_KEYCHAIN_ITEM?.trim();
  return v ? v : DEFAULT_AGENT_KEYCHAIN_ITEM;
}

// Whether the service-account token is in the keychain. stdout is ignored deliberately, not
// incidentally: `-w` prints the token itself, and this runs inside a process whose output can end
// up in an agent transcript or a `--json` report. Only presence is ever observable here — there
// is no accessor that returns the value, and there should not be one.
//
// The run's env (not the process's) so a sandboxed test's PATH shim can intercept `security`
// instead of the real keychain answering; a missing `security` is "not present", not a crash.
export function agentTokenPresent(env: Env): boolean {
  try {
    const p = Bun.spawnSync(["security", "find-generic-password", "-s", agentKeychainItem(env), "-w"], {
      env: cleanEnv(env),
      stdout: "ignore",
      stderr: "ignore",
    });
    return p.exitCode === 0;
  } catch {
    return false;
  }
}
