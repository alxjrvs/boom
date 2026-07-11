// `boom completions <bash|zsh|fish>` — emit a shell completion script for boom's
// top-level commands to stdout. Static (the command set is fixed at build time from the
// catalog), so it needs no runtime round-trip into the binary. Install per your shell,
// e.g. `boom completions zsh > ~/.zsh/completions/_boom`.
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { commandList, commandNames } from "./catalog.ts";

export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

export function isShell(s: string): s is Shell {
  return (SHELLS as readonly string[]).includes(s);
}

// Single-quote a brief for embedding in a single-quoted shell literal.
const sq = (s: string): string => s.replace(/'/g, "'\\''");

function bash(): string {
  return `# boom bash completion. Source it, e.g. in ~/.bashrc:  source <(boom completions bash)
_boom() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${commandNames().join(" ")}" -- "$cur") )
  fi
}
complete -F _boom boom
`;
}

function zsh(): string {
  const lines = commandList()
    .map((c) => `    '${sq(c.name)}:${sq(c.brief)}'`)
    .join("\n");
  return `#compdef boom
# boom zsh completion. Install as _boom on your $fpath, or:  source <(boom completions zsh)
_boom() {
  local -a commands
  commands=(
${lines}
  )
  _describe -t commands 'boom command' commands
}
_boom "$@"
`;
}

function fish(): string {
  const lines = commandList()
    .map((c) => `complete -c boom -n __fish_use_subcommand -a '${sq(c.name)}' -d '${sq(c.brief)}'`)
    .join("\n");
  return `# boom fish completion. Install:  boom completions fish > ~/.config/fish/completions/boom.fish
complete -c boom -f
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

export const completionsCommand = buildCommand<Record<never, never>, [string], BoomContext>({
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
