// Host/OS profiles: gate sections (and overlay files) by os / host / named profile.
// os + host auto-match the machine (overridable via BOOM_OS / BOOM_HOST, which also
// makes them testable); profiles are opt-in via `--profile <name>` (repeatable).
import { hostname } from "node:os";
import type { Env } from "../lib/paths.ts";
import type { Section } from "./schema.ts";

export type OsKind = "darwin" | "linux" | "unknown";

export interface ProfileContext {
  readonly os: OsKind;
  readonly host: string;
  readonly profiles: ReadonlySet<string>;
}

export function detectOs(env: Env): OsKind {
  if (env.BOOM_OS === "darwin" || env.BOOM_OS === "linux") return env.BOOM_OS;
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  return "unknown";
}

export function profileContext(env: Env, explicit: readonly string[]): ProfileContext {
  return { os: detectOs(env), host: env.BOOM_HOST ?? hostname(), profiles: new Set(explicit) };
}

// A `when` axis is any-of: an unset axis constrains nothing, a list matches if *any* member
// does, a scalar is the one-element list. Axes are still ANDed by sectionApplies — the two
// combinators sit apart so that stays obvious rather than hiding inside a chain of `if`s.
const anyOf = (want: string | readonly string[] | undefined, have: string): boolean =>
  want === undefined || (Array.isArray(want) ? want.includes(have) : want === have);

const anyActive = (want: string | readonly string[] | undefined, active: ReadonlySet<string>): boolean =>
  want === undefined
    ? true
    : Array.isArray(want)
      ? want.some((p) => active.has(p))
      : active.has(want as string);

export function sectionApplies(section: Section, pc: ProfileContext): boolean {
  const w = section.when;
  if (!w) return true;
  return anyOf(w.os, pc.os) && anyOf(w.host, pc.host) && anyActive(w.profile, pc.profiles);
}

// Overlay file basenames sourced (if present) after the base boomfile.toml, in order.
export function overlayFiles(pc: ProfileContext): string[] {
  const names = [`boomfile.${pc.os}.toml`, `boomfile.${pc.host}.toml`];
  for (const p of pc.profiles) names.push(`boomfile.${p}.toml`);
  return names;
}
