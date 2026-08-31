// The macOS login-keychain item the 1Password service-account path resolves secrets through, and
// the one probe boom runs against it. Several call sites used to declare this same literal
// independently, so a rename had to find every one of them; it lives here instead. `boom doctor`
// is the only reader left (engine/doctor.ts).
//
// Both halves are exported on purpose. A caller that needs to *know* whether the token is there
// calls agentTokenPresent(); a caller that needs the item NAME — to bake a
// `security find-generic-password …` invocation into text some other process will run later —
// takes agentKeychainItem() and does its own interpolation.

import type { Env } from "./paths.ts";

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
export function agentTokenPresent(env: Env): boolean {
  const p = Bun.spawnSync(["security", "find-generic-password", "-s", agentKeychainItem(env), "-w"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return p.exitCode === 0;
}
