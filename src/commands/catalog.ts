// Single source of truth for botu's command names + one-line briefs. The @stricli
// route map (cli.ts) is the real dispatch; this list drives the things that can't
// introspect that map — the pre-Stricli dispatch guard (index.ts), shell completions,
// and the man page — so they never drift from the route map. `mcp` is a raw passthrough
// (handled before Stricli), not a route, but it is a real command, so it lives here too.
// There are no aliases: one canonical name per command, the single way in.
export interface CommandInfo {
  readonly name: string;
  readonly brief: string;
}

export const COMMANDS: readonly CommandInfo[] = [
  { name: "apply", brief: "Reconcile your machine from the botufile — make it so" },
  { name: "verify", brief: "Check for drift (exit 0 ok / 2 warn / 1 fail)" },
  { name: "repair", brief: "Repair drift (apply, overwriting conflicts)" },
  { name: "uninstall", brief: "Remove everything botu installed" },
  { name: "source", brief: "Set or operate the config repo (set | diff | commit | push | reset)" },
  { name: "where", brief: "Print a resolved botu path: config | code | engine" },
  { name: "rollback", brief: "Undo the most recent apply" },
  { name: "upgrade", brief: "Fetch the latest release and replace the binary in place" },
  { name: "validate", brief: "Parse + schema-check the botufile; change nothing" },
  { name: "doctor", brief: "Check botu's own preconditions (tools, keychain, state)" },
  { name: "code", brief: "Open portals to your code workspaces" },
  { name: "mcp", brief: "Register an MCP server the 1Password-native way" },
  { name: "completions", brief: "Emit a shell completion script (bash | zsh | fish)" },
  { name: "man", brief: "Emit the botu(1) man page (roff)" },
  { name: "skill", brief: "Emit a Claude Code SKILL.md for driving botu (agentic use)" },
] as const;

export const COMMAND_NAMES: readonly string[] = COMMANDS.map((c) => c.name);
