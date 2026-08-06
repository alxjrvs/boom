// The macOS login-keychain item the 1Password service-account path resolves secrets through, and
// the one probe boom runs against it. Three files declared this same literal independently
// (`boom doctor`, `boom status`, and the `boom mcp` wrapper it emits); a rename would have had to
// find all three.
//
// `boom mcp` deliberately does NOT call agentTokenPresent(): what it needs is the *string* — it
// bakes `security find-generic-password …` into shell text that the MCP client stores and runs
// later, in another process. It imports AGENT_KEYCHAIN_ITEM and keeps its own interpolation.

export const AGENT_KEYCHAIN_ITEM = "op-claude-agent";

// Whether the service-account token is in the keychain. stdout is ignored deliberately, not
// incidentally: `-w` prints the token itself, and this runs inside a process whose output can end
// up in an agent transcript or a `--json` report. Only presence is ever observable here — there
// is no accessor that returns the value, and there should not be one.
export function agentTokenPresent(): boolean {
  const p = Bun.spawnSync(["security", "find-generic-password", "-s", AGENT_KEYCHAIN_ITEM, "-w"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return p.exitCode === 0;
}
