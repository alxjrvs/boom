// Command names + one-line briefs, DERIVED from the @stricli route map (cli.ts) — not a
// hand-maintained table. The skill (engine/skill.ts) reads from here, so a command's name/brief
// can never drift from its route: the route *is* the source of truth.
//
// Lazy on purpose. These are functions, not top-level consts, because cli.ts imports the
// skill command, which imports engine/skill.ts, which imports this module — a cycle. Reading
// `routes` only at call time (long after module load) lets the cycle resolve cleanly; a
// top-level `routes.getAllEntries()` here would run mid-load, before cli.ts has assigned
// `routes`.
import { routes } from "../cli.ts";

interface CommandInfo {
  readonly name: string;
  readonly brief: string;
}

export function commandList(): readonly CommandInfo[] {
  return routes
    .getAllEntries()
    .filter((e) => !e.hidden)
    .map((e) => ({ name: e.name.original, brief: e.target.brief }));
}

export function commandNames(): readonly string[] {
  return commandList().map((c) => c.name);
}
