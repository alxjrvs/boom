// `botu completions <bash|zsh|fish>` — emit a shell completion script for botu's
// top-level commands to stdout. Static (the command set is fixed at build time from the
// catalog), so it needs no runtime round-trip into the binary. Install per your shell,
// e.g. `botu completions zsh > ~/.zsh/completions/_botu`.
import { buildCommand } from "@stricli/core";
import type { BotuContext } from "../context.ts";
import { COMMAND_NAMES, COMMANDS } from "./catalog.ts";

export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

export function isShell(s: string): s is Shell {
  return (SHELLS as readonly string[]).includes(s);
}

// Single-quote a brief for embedding in a single-quoted shell literal.
const sq = (s: string): string => s.replace(/'/g, "'\\''");

function bash(): string {
  return `# botu bash completion. Source it, e.g. in ~/.bashrc:  source <(botu completions bash)
_botu() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${COMMAND_NAMES.join(" ")}" -- "$cur") )
  fi
}
complete -F _botu botu
`;
}

function zsh(): string {
  const lines = COMMANDS.map((c) => `    '${sq(c.name)}:${sq(c.brief)}'`).join("\n");
  return `#compdef botu
# botu zsh completion. Install as _botu on your $fpath, or:  source <(botu completions zsh)
_botu() {
  local -a commands
  commands=(
${lines}
  )
  _describe -t commands 'botu command' commands
}
_botu "$@"
`;
}

function fish(): string {
  const lines = COMMANDS.map(
    (c) => `complete -c botu -n __fish_use_subcommand -a '${sq(c.name)}' -d '${sq(c.brief)}'`,
  ).join("\n");
  return `# botu fish completion. Install:  botu completions fish > ~/.config/fish/completions/botu.fish
complete -c botu -f
${lines}
`;
}

export function completionScript(shell: Shell): string {
  switch (shell) {
    case "bash":
      return bash();
    case "zsh":
      return zsh();
    case "fish":
      return fish();
  }
}

export const completionsCommand = buildCommand<Record<never, never>, [string], BotuContext>({
  docs: { brief: "Emit a shell completion script (bash | zsh | fish)" },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ parse: (s: string) => s, placeholder: "shell", brief: "bash | zsh | fish" }],
    },
  },
  func(_flags, shell) {
    if (!isShell(shell)) return new Error(`unknown shell: ${shell} (expected ${SHELLS.join(" | ")})`);
    this.process.stdout.write(completionScript(shell));
  },
});
