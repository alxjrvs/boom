// `boom module` — the declarative-composition surface. Bare `boom module` (the route map's
// `defaultCommand`) inspects the `use` modules this config composes: each ref, whether it
// resolves, and where. `search`/`add` operate the curated module registry (config/registry.ts):
// discover a vetted pack, then splice its ref into your boomfile's top-level `use`. A nested
// route map so the whole module story is one namespace; the sync-it-in step is `boom source`.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCommand, buildRouteMap } from "@stricli/core";
import { parse as parseToml } from "smol-toml";
import { CONFIG_FILE, loadConfig, NO_CONFIG_REPO_MSG, resolveConfigDir } from "../config/load.ts";
import { resolveModule } from "../config/modules.ts";
import { findPack, insertUseRef, searchRegistry } from "../config/registry.ts";
import type { BoomContext } from "../context.ts";
import { bandsReporter, type Reporter } from "../lib/reporter.ts";

// `boom module list` (default) — the original behavior: list the boomfile's `use` modules and
// whether each resolves. `--update` re-fetches remote modules into the cache.
const listCommand = buildCommand<{ update?: boolean; json?: boolean }, [], BoomContext>({
  docs: { brief: "List the `use` modules this config composes and their status; --update re-fetches" },
  parameters: {
    flags: {
      update: { kind: "boolean", optional: true, brief: "Re-fetch remote modules into the cache" },
      json: { kind: "boolean", optional: true, brief: "Emit a structured JSON report" },
    },
  },
  async func(flags) {
    const report = bandsReporter(this.process, this.env, "module", {
      json: flags.json,
      setup: flags.update ? "REFRESHING MODULES…" : "SURVEYING MODULES…",
    });
    const finish = (msgs: Parameters<Reporter["finish"]>[0]): number =>
      flags.json ? report.finishJson(this.process.stdout, msgs.warn !== undefined) : report.finish(msgs);

    const repo = await resolveConfigDir(this.env, this.cwd);
    if (!repo) {
      report.fail(NO_CONFIG_REPO_MSG);
      this.process.exitCode = finish({ ok: "module done", fail: (f) => `module: ${f} failure(s)` });
      return;
    }
    const uses = await loadConfig(repo)
      .then((c) => c.use ?? [])
      .catch((e: Error) => {
        report.fail(e.message);
        return [] as string[];
      });
    if (report.failures > 0) {
      this.process.exitCode = finish({ ok: "module done", fail: (f) => `module: ${f} failure(s)` });
      return;
    }
    if (uses.length === 0) {
      // No header for an empty result — nothing sits under it (the "no empty headline" rule);
      // the verdict carries the message.
      this.process.exitCode = finish({ ok: "module: no modules declared (add a top-level `use = [...]`)" });
      return;
    }

    report.header("Modules");
    for (const ref of uses) {
      const m = await resolveModule(this.env, repo, ref, flags.update);
      if (m.dir) report.ok(`${ref} → ${m.dir}${m.cloned ? " (fetched)" : ""}`);
      else report.warn(`${ref}: ${m.error}`);
    }
    this.process.exitCode = finish({
      ok: `module: ${uses.length} module(s) resolved`,
      warn: (w) => `module: ${w} unresolved`,
      fail: (f) => `module: ${f} failure(s)`,
    });
  },
});

// `boom module search [term]` — filter the curated registry by name/description/tags. Testable
// core split out so a sandbox can drive it without going through the Stricli command shell.
export function runModuleSearch(ctx: BoomContext, term: string, json?: boolean): number {
  const report = bandsReporter(ctx.process, ctx.env, "module", { json, setup: "SEARCHING THE REGISTRY…" });
  const matches = searchRegistry(term);
  if (matches.length === 0) {
    return json
      ? report.finishJson(ctx.process.stdout, false)
      : report.finish({ ok: `module: no packs match "${term}" (try a broader term)` });
  }
  report.header("Registry");
  for (const p of matches) {
    report.ok(`${p.name} — ${p.description}`);
    report.note(`use = ["${p.ref}"]${p.tags?.length ? `  ·  ${p.tags.join(", ")}` : ""}`);
  }
  return json
    ? report.finishJson(ctx.process.stdout, false)
    : report.finish({
        ok: `module: ${matches.length} pack(s) found — \`boom module add <name>\` to use one`,
      });
}

const searchCommand = buildCommand<{ json?: boolean }, [string?], BoomContext>({
  docs: { brief: "Search the curated module registry by name, description, or tag" },
  parameters: {
    flags: { json: { kind: "boolean", optional: true, brief: "Emit a structured JSON report" } },
    positional: {
      kind: "tuple",
      parameters: [{ parse: (s) => s, placeholder: "term", brief: "substring to match", optional: true }],
    },
  },
  func(flags, term) {
    this.process.exitCode = runModuleSearch(this, term ?? "", flags.json);
  },
});

// `boom module add <name>` — resolve <name> in the registry and splice its ref into the
// boomfile's top-level `use`. Idempotent (an already-present ref is a skip, not a duplicate).
// Testable core, like runModuleSearch.
export async function runModuleAdd(ctx: BoomContext, name: string, json?: boolean): Promise<number> {
  const report = bandsReporter(ctx.process, ctx.env, "module", { json, setup: "ADDING MODULE…" });
  const finish = (msgs: Parameters<Reporter["finish"]>[0]): number =>
    json ? report.finishJson(ctx.process.stdout, false) : report.finish(msgs);

  const pack = findPack(name);
  if (!pack) {
    report.fail(`no registry pack named "${name}" — run \`boom module search\` to see what's available`);
    return finish({ ok: "module done", fail: (f) => `module: ${f} failure(s)` });
  }

  const repo = await resolveConfigDir(ctx.env, ctx.cwd);
  if (!repo) {
    report.fail(NO_CONFIG_REPO_MSG);
    return finish({ ok: "module done", fail: (f) => `module: ${f} failure(s)` });
  }

  const file = join(repo, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    report.fail(`no ${CONFIG_FILE} at ${repo}`);
    return finish({ ok: "module done", fail: (f) => `module: ${f} failure(s)` });
  }
  let parsed: { use?: string[] };
  try {
    parsed = parseToml(text) as { use?: string[] };
  } catch (e) {
    report.fail(`${file}: invalid TOML — ${(e as Error).message}`);
    return finish({ ok: "module done", fail: (f) => `module: ${f} failure(s)` });
  }

  report.header("Registry");
  const { text: next, added } = insertUseRef(text, parsed, pack.ref);
  if (!added) {
    report.ok(`${pack.ref} already in use — nothing to do`);
    return finish({ ok: "module: already up to date" });
  }
  await writeFile(file, next);
  report.ok(`added \`${pack.ref}\` to use — run \`boom source\` to apply`);
  return finish({ ok: "module: 1 pack added" });
}

const addCommand = buildCommand<{ json?: boolean }, [string], BoomContext>({
  docs: { brief: "Add a registry pack's ref to your boomfile's `use` (then `boom source` to apply)" },
  parameters: {
    flags: { json: { kind: "boolean", optional: true, brief: "Emit a structured JSON report" } },
    positional: {
      kind: "tuple",
      parameters: [
        { parse: (s) => s, placeholder: "name", brief: "registry pack name (see `module search`)" },
      ],
    },
  },
  async func(flags, name) {
    this.process.exitCode = await runModuleAdd(this, name, flags.json);
  },
});

export const moduleRouteMap = buildRouteMap({
  routes: {
    // `list` is the default so bare `boom module` keeps its original behavior; `search`/`add`
    // operate the curated registry.
    list: listCommand,
    search: searchCommand,
    add: addCommand,
  },
  defaultCommand: "list",
  docs: {
    brief: "Inspect composed `use` modules (bare, or `list`); or discover the registry (search | add)",
  },
});
