// `boom man` — emit the boom(1) man page in roff to stdout. Generated from the command
// catalog so it never drifts from the route map. Install:  boom man > ~/.local/share/man/man1/boom.1
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { VERSION } from "../lib/version.ts";
import { commandFlags, commandList, type FlagInfo, subcommandGroups } from "./catalog.ts";

// Escape the roff comment/escape lead-in. Briefs never start a line with a control
// char (they follow .B on the previous line), so only the escape char needs guarding.
const roff = (s: string): string => s.replace(/\\/g, "\\\\");

// Flags as a roff sub-list, indented under their command with .RS/.RE. Empty for a command
// (or namespace) that takes none, so it contributes nothing.
const flagBlock = (flags: readonly FlagInfo[]): string =>
  flags.length === 0
    ? ""
    : `\n.RS\n${flags.map((f) => `.TP\n.B ${f.flag}\n${roff(f.brief)}`).join("\n")}\n.RE`;

export function manPage(version: string): string {
  const commands = commandList()
    .map((c) => `.TP\n.B ${c.name}\n${roff(c.brief)}${flagBlock(commandFlags(c.name))}`)
    .join("\n");
  // Nested routes (source/code/mcp subcommands) with their own flags — so the man page is
  // as complete as `--help`, not just a top-level index.
  const subcommands = subcommandGroups()
    .map((g) => {
      const subs = g.children
        .map((c) => `.TP\n.B ${g.parent} ${c.name}\n${roff(c.brief)}${flagBlock(c.flags)}`)
        .join("\n");
      return `.SS ${g.parent}\n${subs}`;
    })
    .join("\n");
  return `.TH BOOM 1 "" "boom ${version}" "boom manual"
.SH NAME
boom \\- a declarative machine reconciler (converge a machine + open portals to your code)
.SH SYNOPSIS
.B boom
.I command
[\\fIoptions\\fR]
.SH DESCRIPTION
boom reconciles a machine from a declarative
.I boomfile.toml
\\(em symlinking and copying dotfiles, installing
packages, running steps and hooks \\(em and opens
portals to your code workspaces.
It is a single self-contained binary.
The reconcile verbs (\\fBsource\\fR/\\fBsync\\fR, verify,
uninstall) share one loop over a resource registry;
\\fBsource --fix\\fR repairs drift by overwriting
conflicts, and rollback undoes the most recent sync.
.SH COMMANDS
${commands}
.SH SUBCOMMANDS
${subcommands}
.SH FILES
.TP
.I boomfile.toml
The typed, validated TOML config at the root of your dotfiles repo.
.TP
.I ~/.local/state/boom/
State DB (manifest + transaction journal), backups, and breadcrumbs (honors \\fB$XDG_STATE_HOME\\fR).
.SH ENVIRONMENT
.TP
.B BOOM_CONFIG
Override the dotfiles repo boom resolves.
.TP
.B BOOM_OS, BOOM_HOST
Override the auto-detected OS / hostname used to gate sections.
.SH SEE ALSO
Full guide and source: https://github.com/alxjrvs/boom
`;
}

export const manCommand = buildCommand<Record<never, never>, [], BoomContext>({
  docs: { brief: "Emit the boom(1) man page (roff)" },
  parameters: {},
  func() {
    this.process.stdout.write(manPage(VERSION));
  },
});
