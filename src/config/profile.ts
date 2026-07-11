// Host/OS profiles: gate sections (and overlay files) by os / host / named profile.
// os + host auto-match the machine (overridable via BOOM_OS / BOOM_HOST, which also
// makes them testable); profiles are opt-in via `--profile <name>` (repeatable).
import { hostname } from "node:os";
import type { Env } from "../engine/state.ts";
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

export function sectionApplies(section: Section, pc: ProfileContext): boolean {
  const w = section.when;
  if (!w) return true;
  if (w.os && w.os !== pc.os) return false;
  if (w.host && w.host !== pc.host) return false;
  if (w.profile && !pc.profiles.has(w.profile)) return false;
  return true;
}

// Overlay file basenames sourced (if present) after the base boomfile.toml, in order.
export function overlayFiles(pc: ProfileContext): string[] {
  const names = [`boomfile.${pc.os}.toml`, `boomfile.${pc.host}.toml`];
  for (const p of pc.profiles) names.push(`boomfile.${p}.toml`);
  return names;
}
