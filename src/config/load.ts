// Resolve, parse, and validate a botufile.toml. Resolution order mirrors the bash
// engine: $BOTU_CONFIG → breadcrumb (from `botu init`) → cwd; first dir with a
// botufile.toml wins. Parsing is smol-toml; validation is the valibot schema.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import * as v from "valibot";
import { type Env, stateHome } from "../engine/state.ts";
import { type Botufile, BotufileSchema } from "./schema.ts";

export const CONFIG_FILE = "botufile.toml";

export class BotuConfigError extends Error {}

export function configBreadcrumbPath(env: Env): string {
  return join(stateHome(env), "botu", "config");
}

async function hasBotufile(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, CONFIG_FILE))).isFile();
  } catch {
    return false;
  }
}

export async function resolveConfigDir(env: Env, cwd: string): Promise<string | undefined> {
  let recorded: string | undefined;
  try {
    recorded = (await readFile(configBreadcrumbPath(env), "utf8")).trim() || undefined;
  } catch {
    recorded = undefined;
  }
  for (const candidate of [env.BOTU_CONFIG, recorded, cwd]) {
    if (candidate && (await hasBotufile(candidate))) return candidate;
  }
  return undefined;
}

// Record a dotfiles repo as the active config — write the breadcrumb that
// resolveConfigDir reads. This is the CWD-linking half of `botu init`: `botu link`
// is exactly this, while `botu init` is this plus the botuinit.sh bootstrap. Returns
// the resolved absolute path; throws BotuConfigError if the dir has no botufile.toml.
export async function linkConfigRepo(env: Env, dir: string): Promise<string> {
  const target = resolve(dir);
  if (!(await hasBotufile(target))) {
    throw new BotuConfigError(
      `no ${CONFIG_FILE} at ${target} — point me at your dotfiles repo: botu link /path/to/repo`,
    );
  }
  const crumb = configBreadcrumbPath(env);
  await mkdir(dirname(crumb), { recursive: true });
  await writeFile(crumb, `${target}\n`);
  return target;
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
