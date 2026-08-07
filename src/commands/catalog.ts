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

interface CommandInfo {
  readonly name: string;
  readonly brief: string;
}

export interface FlagInfo {
  readonly flag: string; // the CLI spelling, kebab-cased and `--`-prefixed
  readonly brief: string;
}

export function commandList(): readonly CommandInfo[] {
  return routes
    .getAllEntries()
    .filter((e) => !e.hidden)
    .map((e) => ({ name: e.name.original, brief: e.target.brief }));
}

// Stricli stores flags under their camelCase key; the CLI accepts them kebab-cased
// (scanner caseStyle "allow-kebab-for-camel"), so `dryRun` completes/documents as `--dry-run`.
const camelToKebab = (s: string): string => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

// The flags a routing target accepts, DERIVED from its Stricli parameters (a namespace/route
// map has none). One source of truth again — completions and the man page read this instead
// of a hand-maintained flag table that would drift from each command's real parameters.
function flagsOfTarget(target: { parameters?: { flags?: Record<string, { brief?: string }> } }): FlagInfo[] {
  const flags = target.parameters?.flags;
  if (!flags) return [];
  return Object.entries(flags).map(([name, def]) => ({
    flag: `--${camelToKebab(name)}`,
    brief: def.brief ?? "",
  }));
}

// Flags for a top-level command by name (empty for a namespace or unknown name).
export function commandFlags(name: string): readonly FlagInfo[] {
  const entry = routes.getAllEntries().find((e) => !e.hidden && e.name.original === name);
  return entry ? flagsOfTarget(entry.target as never) : [];
}

export function commandNames(): readonly string[] {
  return commandList().map((c) => c.name);
}

// The nested routes under each namespace command (`source set|status|diff|…`,
// `code init|claude|cmux`, `mcp add`), DERIVED from the same route map — so completions
// can offer a second level without a hand-maintained table. A route map exposes
// getAllEntries; a leaf command does not — that `in` check is the one-level-deeper form
// of index.ts asking the route map itself what it routes.
interface SubcommandInfo extends CommandInfo {
  readonly flags: readonly FlagInfo[];
}
interface SubcommandGroup {
  readonly parent: string;
  readonly children: readonly SubcommandInfo[];
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
      .map((c) => ({
        name: c.name.original,
        brief: c.target.brief,
        flags: flagsOfTarget(c.target as never),
      }));
    if (children.length > 0) groups.push({ parent: e.name.original, children });
  }
  return groups;
}
