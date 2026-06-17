// Resolve, parse, and validate a botufile.toml. Resolution order mirrors the bash
// engine: $BOTU_CONFIG → breadcrumb (from `botu init`) → cwd; first dir with a
// botufile.toml wins. Parsing is smol-toml; validation is the valibot schema.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import * as v from "valibot";
import { type Botufile, BotufileSchema } from "./schema.ts";

export const CONFIG_FILE = "botufile.toml";

export class BotuConfigError extends Error {}

type Env = Record<string, string | undefined>;

function stateHome(env: Env): string {
  return env.XDG_STATE_HOME ?? join(env.HOME ?? "", ".local", "state");
}

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

export async function loadConfig(dir: string): Promise<Botufile> {
  const file = join(dir, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new BotuConfigError(`no ${CONFIG_FILE} at ${dir}`);
  }
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    throw new BotuConfigError(`${file}: invalid TOML — ${(e as Error).message}`);
  }
  const result = v.safeParse(BotufileSchema, raw);
  if (!result.success) {
    const lines = result.issues.map((i) => `  - ${v.getDotPath(i) ?? "(root)"}: ${i.message}`);
    throw new BotuConfigError(`${file}: does not match the botufile schema:\n${lines.join("\n")}`);
  }
  return result.output;
}
