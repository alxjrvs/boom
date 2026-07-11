// `boom mcp add` claude-argv construction. The key property: the server command survives
// as distinct argv elements (never string-joined into a shell word), so a path with a
// space or a shell metacharacter is passed through, not re-parsed. Stricli now owns the
// flag/positional parsing (mcp is a real route), so there's no parser to unit-test here —
// only the argv assembly (buildMcpAddArgv), which is what carries the injection-safety.
import { expect, test } from "bun:test";
import { buildMcpAddArgv, type McpAdd } from "../src/commands/mcp.ts";

const add = (o: Partial<McpAdd> & Pick<McpAdd, "name" | "server">): McpAdd => ({
  scope: "project",
  envFile: ".env",
  agent: false,
  ...o,
});

test("buildMcpAddArgv keeps the server as separate argv (non-agent path)", () => {
  const argv = buildMcpAddArgv(add({ name: "fs", server: ["mcp-fs", "--root", "/my dir"] }));
  expect(argv.slice(0, 6)).toEqual(["claude", "mcp", "add", "fs", "--scope", "project"]);
  expect(argv).toEqual([
    "claude",
    "mcp",
    "add",
    "fs",
    "--scope",
    "project",
    "--",
    "op",
    "run",
    "--env-file=.env",
    "--",
    "mcp-fs",
    "--root",
    "/my dir",
  ]);
});

test("buildMcpAddArgv passes env-file and server as sh positionals (agent path)", () => {
  const argv = buildMcpAddArgv(
    add({ name: "sb", agent: true, envFile: "a b.env", server: ["mcp-sb", "--flag", "x;y"] }),
  );
  // After `sh -c <script> boom-mcp`, the env-file and each server arg are distinct
  // positionals — never concatenated into the script — so quoting can't be broken.
  const shIdx = argv.indexOf("sh");
  expect(argv.slice(shIdx, shIdx + 2)).toEqual(["sh", "-c"]);
  expect(argv.slice(shIdx + 3)).toEqual(["boom-mcp", "a b.env", "mcp-sb", "--flag", "x;y"]);
  expect(argv[shIdx + 2]).toContain("op-claude-agent");
});
