// `boom fleet` — a cross-machine view built from the per-machine summaries `[boom] fleet`
// records into the config repo. A nested route map (like `boom source`): bare `boom fleet` lists
// every machine (the `list` default); `drift` narrows to only the machines needing attention;
// `diff <a> <b>` compares two recorded machines. Each is a thin wrapper over engine/fleet.ts;
// warning-tier exit (0/2) for list/drift, informational (0, or 1 on a missing host) for diff.
import { buildCommand, buildRouteMap } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { boomFleet, fleetDiff, fleetDrift } from "../engine/fleet.ts";
import { str } from "./flags.ts";

const jsonFlag = { kind: "boolean", optional: true, brief: "Emit a structured JSON report" } as const;

const listCommand = buildCommand<{ json?: boolean }, [], BoomContext>({
  docs: { brief: "List every machine's last-sync summary (boom version, drift)" },
  parameters: { flags: { json: jsonFlag } },
  async func(flags) {
    this.process.exitCode = await boomFleet(this, flags.json);
  },
});

const driftCommand = buildCommand<{ json?: boolean }, [], BoomContext>({
  docs: { brief: "Show only machines needing attention (behind version, or last sync not clean)" },
  parameters: { flags: { json: jsonFlag } },
  async func(flags) {
    this.process.exitCode = await fleetDrift(this, flags.json);
  },
});

const diffCommand = buildCommand<{ json?: boolean }, [string, string], BoomContext>({
  docs: { brief: "Compare two recorded machines field by field (boom, os, verdict, sync date)" },
  parameters: {
    flags: { json: jsonFlag },
    positional: {
      kind: "tuple",
      parameters: [
        { parse: str, placeholder: "hostA", brief: "first machine's host" },
        { parse: str, placeholder: "hostB", brief: "second machine's host" },
      ],
    },
  },
  async func(flags, hostA, hostB) {
    this.process.exitCode = await fleetDiff(this, hostA, hostB, flags.json);
  },
});

export const fleetCommand = buildRouteMap({
  routes: { list: listCommand, drift: driftCommand, diff: diffCommand },
  // Bare `boom fleet` lists — the historical behavior — with `list` as its explicit spelling.
  defaultCommand: "list",
  docs: {
    brief: "Cross-machine view from the config repo (bare/`list`; or `drift` | `diff <a> <b>`)",
  },
});
