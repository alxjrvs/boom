// The @stricli application: the built-in route map. Built-ins are this build-time
// route map; user commands resolve at runtime via import() of <config>/commands/*.ts
// (engine/discovery.ts). The command catalog (commands/catalog.ts) mirrors these
// names for the dispatch guard, completions, and the man page.
import { buildApplication, buildRouteMap } from "@stricli/core";
import { codeRouteMap } from "./commands/code.ts";
import { completionsCommand } from "./commands/completions.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { manCommand } from "./commands/man.ts";
import { applyCommand, repairCommand, uninstallCommand, verifyCommand } from "./commands/reconcile.ts";
import { rollbackCommand } from "./commands/rollback.ts";
import { skillCommand } from "./commands/skill.ts";
import { sourceRouteMap } from "./commands/source.ts";
import { upgradeCommand } from "./commands/upgrade.ts";
import { validateCommand } from "./commands/validate.ts";
import { whereCommand } from "./commands/where.ts";
import { VERSION } from "./lib/version.ts";

const routes = buildRouteMap({
  routes: {
    apply: applyCommand,
    verify: verifyCommand,
    repair: repairCommand,
    uninstall: uninstallCommand,
    source: sourceRouteMap,
    where: whereCommand,
    rollback: rollbackCommand,
    upgrade: upgradeCommand,
    validate: validateCommand,
    doctor: doctorCommand,
    code: codeRouteMap,
    completions: completionsCommand,
    man: manCommand,
    skill: skillCommand,
  },
  docs: { brief: "botu — a dotfiles + workspace engine. Reconcile your machine from a botufile.toml." },
});

export const app = buildApplication(routes, {
  name: "botu",
  versionInfo: { currentVersion: VERSION },
  // Accept kebab-case for camelCase flags (so `--dry-run` maps to `dryRun`).
  scanner: { caseStyle: "allow-kebab-for-camel" },
});
