// `boom mcp add <name> [--scope S] [--env-file F] [--agent] -- <server…>` — register an
// MCP server the 1Password-native way: wrap it in `op run --env-file` so secrets resolve
// from op:// refs, never on disk. A real Stricli route: the app enables
// `allowArgumentEscapeSequence`, so everything after `--` is captured verbatim as trailing
// positionals (the server argv, which can itself contain flags and a second `--`) instead
// of being parsed as boom's own flags — no pre-Stricli passthrough needed.
import { buildCommand, buildRouteMap } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { hasCommand } from "../lib/proc.ts";

const KEYCHAIN_ITEM = "op-claude-agent";
// Resolve `op` from PATH rather than hardcoding /opt/homebrew (Apple-Silicon-only):
// Intel macs install it under /usr/local/bin and Linux elsewhere, and boom ships a
// Linux binary. The agent wrapper runs under `sh -c`, so a bare name resolves there.
const OP_BIN = "op";

// The agent wrapper script. It reads the service-account token from the login keychain
// inline (never on disk, never in argv) and exec's `op run`. Positional `$1` is the
// env-file and `$@` (after a shift) are the server argv — passed as *separate* `sh`
// positionals by buildMcpAddArgv, so a path with a space or a `;` in a server arg is
// never re-parsed by the shell (the hazard the non-agent argv path already avoids).
const AGENT_WRAPPER =
  `export OP_SERVICE_ACCOUNT_TOKEN="$(security find-generic-password -s ${KEYCHAIN_ITEM} -w)"; ` +
  `ef="$1"; shift; exec ${OP_BIN} run --env-file="$ef" -- "$@"`;

export interface McpAdd {
  readonly name: string;
  readonly scope: string;
  readonly envFile: string;
  readonly agent: boolean;
  readonly server: string[];
}

// Build the `claude mcp add …` argv for a request. The server command is always carried
// as distinct argv elements (never string-joined), so quoting/spaces survive.
export function buildMcpAddArgv(p: McpAdd): string[] {
  const wrapped = p.agent
    ? ["sh", "-c", AGENT_WRAPPER, "boom-mcp", p.envFile, ...p.server]
    : ["op", "run", `--env-file=${p.envFile}`, "--", ...p.server];
  return ["claude", "mcp", "add", p.name, "--scope", p.scope, "--", ...wrapped];
}

type McpAddFlags = { scope?: string; envFile?: string; agent?: boolean };

// Positionals arrive as [name, ...server]: `name` is the one positional before `--`, and
// the escape sequence delivers the whole server command after it. minimum: 2 → a name plus
// at least one server token.
const mcpAddCommand = buildCommand<McpAddFlags, string[], BoomContext>({
  docs: { brief: "Register an MCP server, wrapping it in `op run --env-file`" },
  parameters: {
    flags: {
      scope: {
        kind: "parsed",
        parse: (s: string) => s,
        optional: true,
        brief: "Passed through to `claude mcp add --scope` (default: project)",
      },
      envFile: {
        kind: "parsed",
        parse: (s: string) => s,
        optional: true,
        brief: "op env-file of op:// refs for `op run --env-file` (default: .env)",
      },
      agent: {
        kind: "boolean",
        optional: true,
        brief: "Read the service-account token from the keychain first (headless/agent path)",
      },
    },
    positional: {
      kind: "array",
      parameter: {
        parse: (s: string) => s,
        placeholder: "name -- server-cmd…",
        brief: "server name, then `--`, then the server command (kept verbatim)",
      },
      minimum: 2,
    },
  },
  func(flags, ...args) {
    const [name, ...server] = args;
    if (!hasCommand("claude", this.env)) {
      this.process.stderr.write("boom mcp: claude not on PATH\n");
      this.process.exitCode = 2;
      return;
    }
    const argv = buildMcpAddArgv({
      name: name as string,
      scope: flags.scope ?? "project",
      envFile: flags.envFile ?? ".env",
      agent: flags.agent ?? false,
      server,
    });
    this.process.exitCode = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" }).exitCode;
  },
});

export const mcpRouteMap = buildRouteMap({
  routes: { add: mcpAddCommand },
  docs: { brief: "Register an MCP server the 1Password-native way" },
});
