// The @stricli application: the built-in route map. This map is the *only* registry —
// index.ts introspects it (getRoutingTargetForInput) to decide built-in vs. discovered
// user command, and commands/catalog.ts derives names + briefs from it for completions,
// the man page, and the skill. There is no hardcoded dispatch and no parallel table.
import { buildApplication, buildRouteMap } from "@stricli/core";
import { codeRouteMap } from "./commands/code.ts";
import { completionsCommand } from "./commands/completions.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { manCommand } from "./commands/man.ts";
import { mcpRouteMap } from "./commands/mcp.ts";
import { uninstallCommand, verifyCommand } from "./commands/reconcile.ts";
import { rollbackCommand } from "./commands/rollback.ts";
import { skillCommand } from "./commands/skill.ts";
import { sourceRouteMap } from "./commands/source.ts";
import { upgradeCommand } from "./commands/upgrade.ts";
import { whereCommand } from "./commands/where.ts";
import { VERSION } from "./lib/version.ts";

export const routes = buildRouteMap({
  routes: {
    verify: verifyCommand,
    uninstall: uninstallCommand,
    source: sourceRouteMap,
    where: whereCommand,
    rollback: rollbackCommand,
    upgrade: upgradeCommand,
    doctor: doctorCommand,
    code: codeRouteMap,
    mcp: mcpRouteMap,
    completions: completionsCommand,
    man: manCommand,
    skill: skillCommand,
  },
  docs: {
    brief:
      "boom — a declarative machine reconciler. Converge your machine from a boomfile.toml, then open portals to your code.",
  },
});

export const app = buildApplication(routes, {
  name: "boom",
  versionInfo: { currentVersion: VERSION },
  scanner: {
    // Accept kebab-case for camelCase flags (so `--dry-run` maps to `dryRun`).
    caseStyle: "allow-kebab-for-camel",
    // Treat `--` as an escape: everything after it is captured as raw positionals rather
    // than parsed as flags. This is what lets `boom mcp add … -- <server cmd>` carry a
    // server argv (with its own flags) verbatim, so mcp needs no pre-Stricli passthrough.
    allowArgumentEscapeSequence: true,
  },
});
