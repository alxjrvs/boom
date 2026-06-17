// The @stricli application: the built-in route map. M5 adds discovered commands
// (code/mcp/watchtower) — built-ins via a build-time route map, user commands via
// runtime import() of <config>/commands/*.ts.
import { buildApplication, buildRouteMap } from "@stricli/core";
import { migrateCommand } from "./commands/migrate.ts";
import {
  applyCommand,
  fixCommand,
  uninstallCommand,
  updateCommand,
  verifyCommand,
} from "./commands/reconcile.ts";
import { whereCommand } from "./commands/where.ts";
import { VERSION } from "./lib/version.ts";

const routes = buildRouteMap({
  routes: {
    apply: applyCommand,
    verify: verifyCommand,
    fix: fixCommand,
    update: updateCommand,
    uninstall: uninstallCommand,
    where: whereCommand,
    migrate: migrateCommand,
  },
  // Muscle-memory aliases carried from the bash era (was `dot sync` / `dot doctor`).
  aliases: { sync: "apply", doctor: "verify" },
  docs: { brief: "botu — a dotfiles + workspace engine. Reconcile your machine from a botufile.toml." },
});

export const app = buildApplication(routes, {
  name: "botu",
  versionInfo: { currentVersion: VERSION },
  // Accept kebab-case for camelCase flags (so `--dry-run` maps to `dryRun`).
  scanner: { caseStyle: "allow-kebab-for-camel" },
});
