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

export function runMcp(args: string[], ctx: BotuContext): number {
  const die = (s: string): number => {
    ctx.process.stderr.write(`botu mcp: ${s}\n`);
    return 2;
  };
  if (args[0] !== "add") {
    return die("usage: botu mcp add <name> [--scope S] [--env-file F] [--agent] -- <server-cmd>");
  }

  let name = "";
  let scope = "project";
  let envFile = ".env";
  let agent = false;
  const server: string[] = [];
  let afterDash = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i] as string;
    if (afterDash) {
      server.push(a);
    } else if (a === "--scope") {
      scope = args[++i] ?? "";
    } else if (a === "--env-file") {
      envFile = args[++i] ?? "";
    } else if (a === "--agent") {
      agent = true;
    } else if (a === "--") {
      afterDash = true;
    } else if (a.startsWith("-")) {
      return die(`unknown flag: ${a}`);
    } else {
      name = a;
    }
  }
  if (!name || server.length === 0) return die("need <name> and a server command after --");
  if (!hasCommand("claude", ctx.env)) return die("claude not on PATH");

  const wrapped = agent
    ? [
        "sh",
        "-c",
        `OP_SERVICE_ACCOUNT_TOKEN="$(security find-generic-password -s ${KEYCHAIN_ITEM} -w)" ${OP_BIN} run --env-file=${envFile} -- ${server.join(" ")}`,
      ]
    : ["op", "run", `--env-file=${envFile}`, "--", ...server];

  return Bun.spawnSync(["claude", "mcp", "add", name, "--scope", scope, "--", ...wrapped], {
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode;
}
