// Resolve, parse, and validate a boomfile.toml. Resolution order mirrors the bash
// engine: $BOOM_CONFIG → breadcrumb (from `boom source set`) → cwd; first dir
// with a boomfile.toml wins. Parsing is smol-toml; validation is the valibot schema.
//
// Config is repo-only: the breadcrumb always names a boom-managed clone of a git
// remote (config/remote.ts owns cloning + writing it), never an arbitrary local
// folder — so it carries the remote alongside the resolved path.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import * as v from "valibot";
import type { BoomContext } from "../context.ts";
import { type Env, stateHome } from "../engine/state.ts";
import { type Boomfile, BoomfileSchema } from "./schema.ts";

export const CONFIG_FILE = "boomfile.toml";

// The one canonical "you haven't linked a config repo yet" message, so every command that
// resolves the config (reconcile, validate, where, doctor) — and requireConfigBreadcrumb —
// points the user at the same next step with identical wording instead of a near-copy that
// can drift. Reported verbatim through the Reporter; requireConfigBreadcrumb prefixes `boom:`
// for its raw-stderr path.
export const NO_CONFIG_REPO_MSG = "no config repo linked — run `boom source set <owner/repo>`";

export class BoomConfigError extends Error {}

export interface ConfigRemote {
  readonly url: string;
  readonly ref?: string;
}

export interface ConfigBreadcrumb {
  readonly path: string;
  readonly remote: ConfigRemote;
}

export function configBreadcrumbPath(env: Env): string {
  return join(stateHome(env), "boom", "config");
}

// Where `boom source set` clones the remote config repo. Fixed — repo-only mode
// has exactly one active config at a time, same as the breadcrumb it pairs with.
export function configRepoCacheDir(env: Env): string {
  return join(stateHome(env), "boom", "config-repo");
}

export async function hasBoomfile(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, CONFIG_FILE))).isFile();
  } catch {
    return false;
  }
}

export async function readConfigBreadcrumb(env: Env): Promise<ConfigBreadcrumb | undefined> {
  try {
    const raw = await readFile(configBreadcrumbPath(env), "utf8");
    const parsed = JSON.parse(raw) as Partial<ConfigBreadcrumb>;
    if (typeof parsed.path === "string" && typeof parsed.remote?.url === "string") {
      return { path: parsed.path, remote: parsed.remote };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// The one linked-config guard shared by every `boom source` subcommand (and any command
// that operates the managed clone): resolve the breadcrumb or print the single canonical
// "not linked" error. Returns undefined so callers can `return 1` uniformly.
export async function requireConfigBreadcrumb(ctx: BoomContext): Promise<ConfigBreadcrumb | undefined> {
  const breadcrumb = await readConfigBreadcrumb(ctx.env);
  if (!breadcrumb) {
    ctx.process.stderr.write(`boom: ${NO_CONFIG_REPO_MSG}\n`);
    return undefined;
  }
  return breadcrumb;
}

export async function writeConfigBreadcrumb(env: Env, breadcrumb: ConfigBreadcrumb): Promise<void> {
  const crumb = configBreadcrumbPath(env);
  await mkdir(dirname(crumb), { recursive: true });
  await writeFile(crumb, `${JSON.stringify(breadcrumb)}\n`);
}

export async function resolveConfigDir(env: Env, cwd: string): Promise<string | undefined> {
  const breadcrumb = await readConfigBreadcrumb(env);
  for (const candidate of [env.BOOM_CONFIG, breadcrumb?.path, cwd]) {
    if (candidate && (await hasBoomfile(candidate))) return candidate;
  }
  return undefined;
}

function validate(file: string, raw: unknown): Boomfile {
  const result = v.safeParse(BoomfileSchema, raw);
  if (!result.success) {
    // Field path + message, plus the offending value where valibot reports one — so a
    // schema failure points at both *where* (`section.0.link.2.mode`) and *what*
    // (`received "999"`), instead of just naming the field and leaving the user to hunt.
    const lines = result.issues.map((i) => {
      const path = v.getDotPath(i) ?? "(root)";
      const got = i.received && i.received !== "undefined" ? ` (received ${i.received})` : "";
      return `  - ${path}: ${i.message}${got}`;
    });
    throw new BoomConfigError(`${file}: does not match the boomfile schema:\n${lines.join("\n")}`);
  }
  return result.output;
}

// Load + validate a specific boomfile.toml (base or overlay) by full path.
export async function loadConfigFile(file: string): Promise<Boomfile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new BoomConfigError(`no config file at ${file}`);
  }
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    throw new BoomConfigError(`${file}: invalid TOML — ${(e as Error).message}`);
  }
  return validate(file, raw);
}

// Like loadConfigFile, but returns undefined when the file is absent (for overlays).
export async function loadOptionalConfigFile(file: string): Promise<Boomfile | undefined> {
  try {
    await stat(file);
  } catch {
    return undefined;
  }
  return loadConfigFile(file);
}

export function loadConfig(dir: string): Promise<Boomfile> {
  return loadConfigFile(join(dir, CONFIG_FILE));
}
