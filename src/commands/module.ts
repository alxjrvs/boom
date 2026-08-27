// `boom module` — the declarative-composition surface. Bare `boom module` (the route map's
// `defaultCommand`) inspects the `use` modules this config composes: each ref, whether it
// resolves, and where. `add <ref>` splices a module ref into the boomfile's top-level `use`.
// A nested route map so the whole module story is one namespace; the sync-it-in step is
// `boom source`.
//
// There was a `search` here, over a "curated registry" of five packs. All five refs pointed at
// repositories that do not exist, so the command listed things that could never resolve and
// `add <name>` spliced a dead ref into the user's committed config. Both are gone; `add` now
// takes the ref itself, which is the half that always worked.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCommand, buildRouteMap } from "@stricli/core";
import { CONFIG_FILE, loadConfig, NO_CONFIG_REPO_MSG, resolveConfigDir } from "../config/load.ts";
import { resolveModule } from "../config/modules.ts";
import { insertUseRef } from "../config/registry.ts";
import type { BoomContext } from "../context.ts";
import { bandsReporter, type Reporter } from "../lib/reporter.ts";
import { parseToml } from "../lib/toml.ts";
import { jsonFlag, str } from "./flags.ts";

// `boom module list` (default) — the original behavior: list the boomfile's `use` modules and
// whether each resolves. `--update` re-fetches remote modules into the cache.
const listCommand = buildCommand<{ update?: boolean; json?: boolean }, [], BoomContext>({
  docs: { brief: "List the `use` modules this config composes and their status; --update re-fetches" },
  parameters: {
    flags: {
      update: { kind: "boolean", optional: true, brief: "Re-fetch remote modules into the cache" },
      json: jsonFlag,
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

// A ref shape `resolveModule` could plausibly take: a path (`./mod`, `/mod`, `~/mod`), a
// `scheme:owner/repo` form, or a git URL. Shape only — resolution and the clone are
// `boom source`'s job, and a path ref is legitimately allowed not to exist yet. This exists so a
// bare word (the old registry pack name) isn't written into the config as if it were a ref.
function looksLikeModuleRef(ref: string): boolean {
  const r = ref.trim();
  if (!r) return false;
  if (/^[./~]/.test(r)) return true; // path ref
  if (/^[a-z][\w+.-]*:/i.test(r)) return true; // github:owner/repo, https://…, git@…:
  return /^[\w.-]+\/[\w.-]+/.test(r); // bare owner/repo
}

// `boom module add <ref>` — splice a module ref into the boomfile's top-level `use`. Idempotent
// (an already-present ref is a skip, not a duplicate). Testable core, split out so a sandbox can
// drive it without going through the Stricli command shell.
async function runModuleAdd(ctx: BoomContext, ref: string, json?: boolean): Promise<number> {
  const report = bandsReporter(ctx.process, ctx.env, "module", { json, setup: "ADDING MODULE…" });
  const finish = (msgs: Parameters<Reporter["finish"]>[0]): number =>
    json ? report.finishJson(ctx.process.stdout, false) : report.finish(msgs);

  if (!looksLikeModuleRef(ref)) {
    report.fail(
      `"${ref}" is not a module ref — expected github:owner/repo, a git URL, or a path (./mod, ~/mod)`,
    );
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

  report.header("Modules");
  const { text: next, added } = insertUseRef(text, parsed, ref);
  if (!added) {
    report.ok(`${ref} already in use — nothing to do`);
    return finish({ ok: "module: already up to date" });
  }
  await writeFile(file, next);
  report.ok(`added \`${ref}\` to use — run \`boom source\` to apply`);
  return finish({ ok: "module: 1 module added" });
}

const addCommand = buildCommand<{ json?: boolean }, [string], BoomContext>({
  docs: { brief: "Add a module ref to your boomfile's `use` (then `boom source` to apply)" },
  parameters: {
    flags: { json: jsonFlag },
    positional: {
      kind: "tuple",
      parameters: [{ parse: str, placeholder: "ref", brief: "github:owner/repo, a git URL, or a path" }],
    },
  },
  async func(flags, ref) {
    this.process.exitCode = await runModuleAdd(this, ref, flags.json);
  },
});

export const moduleRouteMap = buildRouteMap({
  routes: {
    // `list` is the default so bare `boom module` keeps its original behavior.
    list: listCommand,
    add: addCommand,
  },
  defaultCommand: "list",
  docs: { brief: "Inspect composed `use` modules (bare, or `list`), or add one (`add <ref>`)" },
});
