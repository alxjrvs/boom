// `boom completions <bash|zsh|fish>` — emit a shell completion script for boom's
// top-level commands to stdout. Static (the command set is fixed at build time from the
// catalog), so it needs no runtime round-trip into the binary. Install per your shell,
// e.g. `boom completions zsh > ~/.zsh/completions/_boom`.
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { commandList, commandNames, subcommandGroups } from "./catalog.ts";
import { str } from "./flags.ts";

export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

export function isShell(s: string): s is Shell {
  return (SHELLS as readonly string[]).includes(s);
}

// Single-quote a brief for embedding in a single-quoted shell literal.
const sq = (s: string): string => s.replace(/'/g, "'\\''");

function bash(): string {
  // Second level: when the first word is a namespace command, complete its subcommands.
  const arms = subcommandGroups()
    .map(
      (g) =>
        `      ${g.parent}) COMPREPLY=( $(compgen -W "${g.children.map((c) => c.name).join(" ")}" -- "$cur") );;`,
    )
    .join("\n");
  return `# boom bash completion. Source it, e.g. in ~/.bashrc:  source <(boom completions bash)
_boom() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${commandNames().join(" ")}" -- "$cur") )
    return
  fi
  if [ "$COMP_CWORD" -eq 2 ]; then
    case "\${COMP_WORDS[1]}" in
${arms}
    esac
  fi
}
complete -F _boom boom
`;
}

function zsh(): string {
  const top = commandList()
    .map((c) => `    '${sq(c.name)}:${sq(c.brief)}'`)
    .join("\n");
  // One `_describe` block per namespace, dispatched on the first word.
  const arms = subcommandGroups()
    .map((g) => {
      const subs = g.children.map((c) => `        '${sq(c.name)}:${sq(c.brief)}'`).join("\n");
      return `      ${g.parent})
        local -a ${g.parent}_cmds
        ${g.parent}_cmds=(
${subs}
        )
        _describe -t ${g.parent}_cmds '${g.parent} subcommand' ${g.parent}_cmds
        ;;`;
    })
    .join("\n");
  return `#compdef boom
# boom zsh completion. Install as _boom on your $fpath, or:  source <(boom completions zsh)
_boom() {
  local -a commands
  commands=(
${top}
  )
  local curcontext="$curcontext" state
  _arguments -C '1: :->cmd' '*::arg:->args'
  case $state in
    cmd) _describe -t commands 'boom command' commands ;;
    args)
      case $words[1] in
${arms}
      esac
      ;;
  esac
}
_boom "$@"
`;
}

function fish(): string {
  const top = commandList()
    .map((c) => `complete -c boom -n __fish_use_subcommand -a '${sq(c.name)}' -d '${sq(c.brief)}'`)
    .join("\n");
  // Offer a namespace's subcommands once that namespace word has been typed. -f on the
  // nested completes suppresses file completion where a subcommand name is expected.
  const nested = subcommandGroups()
    .flatMap((g) =>
      g.children.map(
        (c) =>
          `complete -c boom -f -n '__fish_seen_subcommand_from ${g.parent}' -a '${sq(c.name)}' -d '${sq(c.brief)}'`,
      ),
    )
    .join("\n");
  return `# boom fish completion. Install:  boom completions fish > ~/.config/fish/completions/boom.fish
complete -c boom -f
${top}
${nested}
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
      parameters: [{ parse: str, placeholder: "shell", brief: "bash | zsh | fish" }],
    },
  },
  func(_flags, shell) {
    if (!isShell(shell)) return new Error(`unknown shell: ${shell} (expected ${SHELLS.join(" | ")})`);
    this.process.stdout.write(completionScript(shell));
  },
});
