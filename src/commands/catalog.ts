// Command names + one-line briefs, DERIVED from the @stricli route map (cli.ts) — not a
// hand-maintained table. Completions, the man page, and the skill all read from here, so a
// command's name/brief can never drift from its route: the route *is* the source of truth.
//
// Lazy on purpose. These are functions, not top-level consts, because cli.ts imports the
// generator commands (completions/man/skill) that import this module — a cycle. Reading
// `routes` only at call time (help/generator execution, long after module load) lets the
// cycle resolve cleanly; a top-level `routes.getAllEntries()` here would run mid-load,
// before cli.ts has assigned `routes`.
import { routes } from "../cli.ts";

export interface CommandInfo {
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

// The nested routes under each namespace command (`source set|status|diff|…`,
// `code init|claude|cmux`, `mcp add`), DERIVED from the same route map — so completions
// can offer a second level without a hand-maintained table. A route map exposes
// getAllEntries; a leaf command does not — that `in` check is the one-level-deeper form
// of index.ts asking the route map itself what it routes.
export interface SubcommandGroup {
  readonly parent: string;
  readonly children: readonly CommandInfo[];
}

export function subcommandGroups(): readonly SubcommandGroup[] {
  const groups: SubcommandGroup[] = [];
  for (const e of routes.getAllEntries()) {
    if (e.hidden) continue;
    const target = e.target;
    if (!("getAllEntries" in target)) continue; // a leaf command, not a namespace
    const children = target
      .getAllEntries()
      .filter((c) => !c.hidden)
      .map((c) => ({ name: c.name.original, brief: c.target.brief }));
    if (children.length > 0) groups.push({ parent: e.name.original, children });
  }
  return groups;
}
