// Config modules (`use`): compose a machine from other boom config repos — vetted, shared
// section sets — instead of authoring every section by hand. A module ref is a local path
// (relative to this repo, or absolute/`~`) or a git remote (`owner/repo[@ref]`, a URL); its
// sections are merged in *before* this repo's own, so your repo can still override a module.
// Each resolved section carries the directory its repo-relative `src` paths resolve against
// (`origin`) — which is what makes a module able to *ship* the files it declares, the promise
// `config/registry.ts` has always advertised and could not deliver.
//
// Resolution runs during reconcile (not at every config load — `where`/`doctor` shouldn't clone).
// Remotes clone once into a modules cache and are reused; a clone that fails (offline, typo)
// degrades to a warning that skips that module, never a failed reconcile. Modules compose
// recursively: a module's own `use` is followed (resolved relative to that module), so packs can
// build on packs. A resolution-stack guard makes that finite — a ref already on the current
// resolve path (a cycle) is warned and skipped instead of looping forever.
import { isAbsolute, join } from "node:path";
import { expandTilde, mkdir, rm } from "../lib/fs.ts";
import { checkoutRef, cloneRepo } from "../lib/git.ts";
import { type Env, stateHome } from "../lib/paths.ts";
import type { ComposedSection } from "./compose.ts";
import { hasBoomfile, loadConfig } from "./load.ts";
import { parseRemoteRef } from "./remote.ts";

export function modulesCacheDir(env: Env): string {
  return join(stateHome(env), "boom", "modules");
}

// A ref that names a filesystem path (rather than a remote): explicit `.`/`/`/`~`, or a bare
// relative path that actually resolves to a module dir under the repo — both are treated local.
function isPathRef(ref: string): boolean {
  return ref.startsWith(".") || ref.startsWith("/") || ref.startsWith("~");
}

// Stable cache-dir name for a remote ref (so re-resolving reuses the same clone).
function moduleSlug(ref: string): string {
  return ref.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "module";
}

export interface ResolvedModule {
  readonly ref: string;
  readonly dir?: string; // the resolved local directory (present on success)
  readonly cloned?: boolean; // a fresh clone happened this call (for `boom module` reporting)
  readonly error?: string; // why it didn't resolve (present on failure)
}

// Resolve one module ref to a local directory holding a boomfile.toml. A remote is cloned into
// the cache on first use (or when `update` forces a re-clone); an already-cached module is reused.
export async function resolveModule(
  env: Env,
  repo: string,
  ref: string,
  update = false,
): Promise<ResolvedModule> {
  // Local path (explicit `.`/`/`/`~`, or a bare repo-relative subdir that exists) — no network,
  // the testable case. A `~`/absolute path is used as-is; anything else resolves under the repo.
  if (isPathRef(ref)) {
    const expanded = expandTilde(ref, env);
    const dir = isAbsolute(expanded) ? expanded : join(repo, expanded);
    return (await hasBoomfile(dir)) ? { ref, dir } : { ref, error: `no boomfile.toml at ${dir}` };
  }
  const asRepoRel = join(repo, ref);
  if (await hasBoomfile(asRepoRel)) return { ref, dir: asRepoRel };

  // Otherwise a git remote — clone into the cache (once, or on --update).
  const { url, ref: gitRef } = parseRemoteRef(ref);
  const dir = join(modulesCacheDir(env), moduleSlug(ref));
  const cached = await hasBoomfile(dir);
  if (cached && !update) return { ref, dir };

  await mkdir(modulesCacheDir(env), { recursive: true });
  await rm(dir, { recursive: true, force: true });
  const clone = cloneRepo(url, dir, env);
  if (clone.code !== 0) return { ref, error: `clone ${url} failed: ${clone.stderr || "unknown error"}` };
  if (gitRef) {
    const co = checkoutRef(dir, gitRef, env);
    if (co.code !== 0) return { ref, error: `checkout ${gitRef} failed: ${co.stderr || "unknown error"}` };
  }
  if (!(await hasBoomfile(dir))) return { ref, error: `no boomfile.toml in module ${ref}` };
  return { ref, dir, cloned: true };
}

// Resolve every `use` module to its sections + `[vars]`, in order, for `composeConfig` to place
// before the base repo's own. A module that fails to resolve (or whose config is invalid) is
// reported via `onError` and skipped — one bad module never sinks the whole reconcile. Composition
// is recursive: a resolved module's own `use` is followed (relative to that module's dir), and its
// nested modules' sections are composed *before* its own — so the same "modules compose first"
// ordering holds at every depth. `stack` is the set of module dirs currently on the resolve path;
// a ref that resolves back onto it is a cycle — warned via `onError` and skipped, so a cyclic
// `use` terminates instead of recursing forever. (A dir that already resolved on a *sibling* path
// is not a cycle and is composed again — diamonds duplicate, sections just merge, which is fine.)
//
// `vars` accumulate in the same order the sections do, so the last module named in `use` wins a
// collision and a nested module is weaker than the parent that pulled it in — leaving the whole
// module layer weaker than the base repo's own `[vars]`, which composeConfig spreads over it.
export async function resolveModules(
  env: Env,
  repo: string,
  uses: readonly string[],
  onError: (ref: string, why: string) => void,
  stack: Set<string> = new Set(),
): Promise<{ sections: ComposedSection[]; vars: Record<string, string> }> {
  const out: ComposedSection[] = [];
  let vars: Record<string, string> = {};
  for (const ref of uses) {
    try {
      // resolveModule can itself throw on a genuine filesystem error (e.g. the modules cache dir
      // isn't writable) — catch here too, so "one bad module never sinks the reconcile" holds for
      // an I/O failure, not just a clean clone/parse error.
      const m = await resolveModule(env, repo, ref);
      if (!m.dir) {
        onError(ref, m.error ?? "unresolved");
        continue;
      }
      if (stack.has(m.dir)) {
        onError(ref, `cycle detected (already resolving ${m.dir}) — skipped`);
        continue;
      }
      const cfg = await loadConfig(m.dir);
      // Follow the module's own `use` first, relative to its own dir, then its sections — so
      // nested modules compose before their parent, matching the top-level ordering. Push/pop the
      // dir around the recursion so it guards only the current path (a stack, not a global seen-set).
      if (cfg.use && cfg.use.length > 0) {
        stack.add(m.dir);
        const nested = await resolveModules(env, m.dir, cfg.use, onError, stack);
        stack.delete(m.dir);
        // Not re-stamped: the recursive call already stamped those sections with the NESTED
        // module's dir, which is where their files actually live.
        out.push(...nested.sections);
        vars = { ...vars, ...nested.vars };
      }
      out.push(...cfg.section.map((s) => ({ ...s, origin: m.dir, source: ref })));
      vars = { ...vars, ...(cfg.vars ?? {}) };
    } catch (e) {
      onError(ref, (e as Error).message);
    }
  }
  return { sections: out, vars };
}
