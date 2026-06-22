// `botu man` — emit the botu(1) man page in roff to stdout. Generated from the command
// catalog so it never drifts from the route map. Install:  botu man > ~/.local/share/man/man1/botu.1
import { buildCommand } from "@stricli/core";
import type { BotuContext } from "../context.ts";
import { VERSION } from "../lib/version.ts";
import { COMMANDS } from "./catalog.ts";

// Escape the roff comment/escape lead-in. Briefs never start a line with a control
// char (they follow .B on the previous line), so only the escape char needs guarding.
const roff = (s: string): string => s.replace(/\\/g, "\\\\");

export function manPage(version: string): string {
  const commands = COMMANDS.map((c) => `.TP\n.B ${c.name}\n${roff(c.brief)}`).join("\n");
  return `.TH BOTU 1 "" "botu ${version}" "botu manual"
.SH NAME
botu \\- an installable dotfiles + workspace engine
.SH SYNOPSIS
.B botu
.I command
[\\fIoptions\\fR]
.SH DESCRIPTION
botu reconciles a machine from a declarative
.I botufile.toml
\\(em symlinking and copying dotfiles, installing
packages, running steps and hooks \\(em and opens
portals to your code workspaces.
It is a single self-contained binary.
The reconcile verbs (apply, verify, fix, update,
uninstall) share one loop over a resource registry,
and rollback undoes the most recent apply.
.SH COMMANDS
${commands}
.SH FILES
.TP
.I botufile.toml
The typed, validated TOML config at the root of your dotfiles repo.
.TP
.I ~/.local/state/botu/
Journal, backups, manifest, and breadcrumbs (honors \\fB$XDG_STATE_HOME\\fR).
.SH ENVIRONMENT
.TP
.B BOTU_CONFIG
Override the dotfiles repo botu resolves.
.TP
.B BOTU_OS, BOTU_HOST
Override the auto-detected OS / hostname used to gate sections.
.SH SEE ALSO
.BR botu-verify (1),
.BR botu-apply (1)
`;
}

export const manCommand = buildCommand<Record<never, never>, [], BotuContext>({
  docs: { brief: "Emit the botu(1) man page (roff)" },
  parameters: {},
  func() {
    this.process.stdout.write(manPage(VERSION));
  },
});
