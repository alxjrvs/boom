// The @stricli application: the built-in route map. This map is the *only* registry —
// index.ts introspects it (getRoutingTargetForInput) to decide built-in vs. discovered
// user command, and commands/catalog.ts derives names + briefs from it for the skill.
// There is no hardcoded dispatch and no parallel table.
import { buildApplication, buildRouteMap } from "@stricli/core";
import { doctorCommand } from "./commands/doctor.ts";
import { lockCommand } from "./commands/lock.ts";
import { uninstallCommand, verifyCommand } from "./commands/reconcile.ts";
import { rollbackCommand } from "./commands/rollback.ts";
import { skillCommand } from "./commands/skill.ts";
import { sourceRouteMap } from "./commands/source.ts";
import { statusCommand } from "./commands/status.ts";
import { upgradeCommand } from "./commands/upgrade.ts";
import { whereCommand } from "./commands/where.ts";
import { VERSION } from "./lib/version.ts";

export const routes = buildRouteMap({
  routes: {
    verify: verifyCommand,
    status: statusCommand,
    uninstall: uninstallCommand,
    source: sourceRouteMap,
    where: whereCommand,
    rollback: rollbackCommand,
    upgrade: upgradeCommand,
    doctor: doctorCommand,
    // Kept when its six siblings went, because it is not standalone: `boom verify` audits
    // boom.lock drift into the same warning tier as any other drift (engine/reconcile.ts) and
    // `boom status` reports the pin count (engine/overview.ts). Removing the command while
    // keeping those would leave a lockfile that verify reads and nothing can regenerate.
    lock: lockCommand,
    skill: skillCommand,
  },
  docs: {
    brief: "boom — declarative dev-machine setup. Converge your machine from a boomfile.toml.",
  },
});

export const app = buildApplication(routes, {
  name: "boom",
  versionInfo: { currentVersion: VERSION },
  scanner: {
    // Accept kebab-case for camelCase flags (so `--dry-run` maps to `dryRun`).
    caseStyle: "allow-kebab-for-camel",
    // Treat `--` as an escape: everything after it is captured as raw positionals rather than
    // parsed as flags. Kept after `mcp` was removed because it is a property of the scanner
    // rather than of any one route: a user command discovered from `<config>/commands/` is
    // free to take its own flags, and `--` is how they ride through unparsed.
    allowArgumentEscapeSequence: true,
  },
});
