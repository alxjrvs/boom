// `botu mcp add <name> [--scope S] [--env-file F] [--agent] -- <server…>` — register an
// MCP server the 1Password-native way: wrap it in `op run --env-file` so secrets
// resolve from op:// refs, never on disk. Ported from the bash engine/commands/mcp.
// Handled as a raw passthrough (not a Stricli command) so the `--` server args are
// not parsed.
import type { BotuContext } from "../context.ts";
import { hasCommand } from "../lib/proc.ts";

const KEYCHAIN_ITEM = "op-claude-agent";
// Resolve `op` from PATH rather than hardcoding /opt/homebrew (Apple-Silicon-only):
// Intel macs install it under /usr/local/bin and Linux elsewhere, and botu ships a
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

// Parse `add <name> [flags] -- <server…>`. Returns the parsed shape or an error string.
export function parseMcpAdd(args: string[]): McpAdd | { error: string } {
  if (args[0] !== "add") {
    return { error: "usage: botu mcp add <name> [--scope S] [--env-file F] [--agent] -- <server-cmd>" };
  }
  let name = "";
  let scope = "project";
  let envFile = ".env";
  let agent = false;
  const server: string[] = [];
  let afterDash = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i] as string;
    if (afterDash) server.push(a);
    else if (a === "--scope") scope = args[++i] ?? "";
    else if (a === "--env-file") envFile = args[++i] ?? "";
    else if (a === "--agent") agent = true;
    else if (a === "--") afterDash = true;
    else if (a.startsWith("-")) return { error: `unknown flag: ${a}` };
    else name = a;
  }
  if (!name || server.length === 0) return { error: "need <name> and a server command after --" };
  return { name, scope, envFile, agent, server };
}

// Build the `claude mcp add …` argv for a parsed request. The server command is always
// carried as distinct argv elements (never string-joined), so quoting/spaces survive.
export function buildMcpAddArgv(p: McpAdd): string[] {
  const wrapped = p.agent
    ? ["sh", "-c", AGENT_WRAPPER, "botu-mcp", p.envFile, ...p.server]
    : ["op", "run", `--env-file=${p.envFile}`, "--", ...p.server];
  return ["claude", "mcp", "add", p.name, "--scope", p.scope, "--", ...wrapped];
}

export function runMcp(args: string[], ctx: BotuContext): number {
  const parsed = parseMcpAdd(args);
  if ("error" in parsed) {
    ctx.process.stderr.write(`botu mcp: ${parsed.error}\n`);
    return 2;
  }
  if (!hasCommand("claude", ctx.env)) {
    ctx.process.stderr.write("botu mcp: claude not on PATH\n");
    return 2;
  }
  return Bun.spawnSync(buildMcpAddArgv(parsed), { stdout: "inherit", stderr: "inherit" }).exitCode;
}
