// Single source of truth for botu's command names + one-line briefs. The @stricli
// route map (cli.ts) is the real dispatch; this list drives the things that can't
// introspect that map — the pre-Stricli dispatch guard (index.ts), shell completions,
// and the man page — so they never drift from the route map. `mcp` is a raw passthrough
// (handled before Stricli), not a route, but it is a real command, so it lives here too.
export interface CommandInfo {
  readonly name: string;
  readonly brief: string;
}

export const COMMANDS: readonly CommandInfo[] = [
  { name: "init", brief: "Clone a remote dotfiles repo and apply it — one-command bootstrap" },
  { name: "link", brief: "Clone a remote dotfiles repo and record it as the active config" },
  { name: "apply", brief: "Reconcile your machine from the botufile — make it so" },
  { name: "verify", brief: "Check for drift (exit 0 ok / 2 warn / 1 fail)" },
  { name: "fix", brief: "Repair drift (apply, overwriting conflicts)" },
  { name: "update", brief: "Apply with upgrades" },
  { name: "uninstall", brief: "Remove everything botu installed" },
  { name: "push", brief: "Push the config repo's local commits upstream" },
  { name: "reset", brief: "Discard local changes in the config repo and reset it to origin" },
  { name: "where", brief: "Print a resolved botu path: config | code | engine" },
  { name: "rollback", brief: "Undo the most recent apply" },
  { name: "upgrade", brief: "Fetch the latest release and replace the binary in place" },
  { name: "validate", brief: "Parse + schema-check the botufile; change nothing" },
  { name: "doctor", brief: "Check botu's own preconditions (tools, keychain, state)" },
  { name: "code", brief: "Open portals to your code workspaces" },
  { name: "mcp", brief: "Register an MCP server the 1Password-native way" },
  { name: "completions", brief: "Emit a shell completion script (bash | zsh | fish)" },
  { name: "man", brief: "Emit the botu(1) man page (roff)" },
] as const;

// Muscle-memory aliases carried from the bash era (`dot sync`). The old `dot doctor`
// alias is gone — `doctor` is now a real command (preconditions, not a verify alias).
export const ALIASES: Readonly<Record<string, string>> = { sync: "apply" };

export const COMMAND_NAMES: readonly string[] = COMMANDS.map((c) => c.name);
