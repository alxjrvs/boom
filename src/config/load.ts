// Resolve, parse, and validate a botufile.toml. Resolution order mirrors the bash
// engine: $BOTU_CONFIG → breadcrumb (from `botu source set`) → cwd; first dir
// with a botufile.toml wins. Parsing is smol-toml; validation is the valibot schema.
//
// Config is repo-only: the breadcrumb always names a botu-managed clone of a git
// remote (config/remote.ts owns cloning + writing it), never an arbitrary local
// folder — so it carries the remote alongside the resolved path.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import * as v from "valibot";
import type { BotuContext } from "../context.ts";
import { type Env, stateHome } from "../engine/state.ts";
import { type Botufile, BotufileSchema } from "./schema.ts";

export const CONFIG_FILE = "botufile.toml";

export class BotuConfigError extends Error {}

export interface ConfigRemote {
  readonly url: string;
  readonly ref?: string;
}

export interface ConfigBreadcrumb {
  readonly path: string;
  readonly remote: ConfigRemote;
}

export function configBreadcrumbPath(env: Env): string {
  return join(stateHome(env), "botu", "config");
}

// Where `botu source set` clones the remote config repo. Fixed — repo-only mode
// has exactly one active config at a time, same as the breadcrumb it pairs with.
export function configRepoCacheDir(env: Env): string {
  return join(stateHome(env), "botu", "config-repo");
}

export async function hasBotufile(dir: string): Promise<boolean> {
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

// The one linked-config guard shared by every `botu source` subcommand (and any command
// that operates the managed clone): resolve the breadcrumb or print the single canonical
// "not linked" error. Returns undefined so callers can `return 1` uniformly.
export async function requireConfigBreadcrumb(ctx: BotuContext): Promise<ConfigBreadcrumb | undefined> {
  const breadcrumb = await readConfigBreadcrumb(ctx.env);
  if (!breadcrumb) {
    ctx.process.stderr.write("botu: no remote config linked — run `botu source set <owner/repo>`\n");
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
  for (const candidate of [env.BOTU_CONFIG, breadcrumb?.path, cwd]) {
    if (candidate && (await hasBotufile(candidate))) return candidate;
  }
  return undefined;
}

function validate(file: string, raw: unknown): Botufile {
  const result = v.safeParse(BotufileSchema, raw);
  if (!result.success) {
    const lines = result.issues.map((i) => `  - ${v.getDotPath(i) ?? "(root)"}: ${i.message}`);
    throw new BotuConfigError(`${file}: does not match the botufile schema:\n${lines.join("\n")}`);
  }
  return result.output;
}

// Load + validate a specific botufile.toml (base or overlay) by full path.
export async function loadConfigFile(file: string): Promise<Botufile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new BotuConfigError(`no config file at ${file}`);
  }
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    throw new BotuConfigError(`${file}: invalid TOML — ${(e as Error).message}`);
  }
  return validate(file, raw);
}

// Like loadConfigFile, but returns undefined when the file is absent (for overlays).
export async function loadOptionalConfigFile(file: string): Promise<Botufile | undefined> {
  try {
    await stat(file);
  } catch {
    return undefined;
  }
  return loadConfigFile(file);
}

export function loadConfig(dir: string): Promise<Botufile> {
  return loadConfigFile(join(dir, CONFIG_FILE));
}
