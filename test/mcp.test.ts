// `botu mcp add` arg parsing + claude-argv construction. The key property: the server
// command survives as distinct argv elements (never string-joined into a shell word),
// so a path with a space or a shell metacharacter is passed through, not re-parsed.
import { expect, test } from "bun:test";
import { buildMcpAddArgv, parseMcpAdd } from "../src/commands/mcp.ts";

test("parseMcpAdd reads name, flags, and the server after --", () => {
  const p = parseMcpAdd([
    "add",
    "ctx7",
    "--scope",
    "user",
    "--env-file",
    "secrets.env",
    "--",
    "node",
    "s.js",
  ]);
  expect(p).toEqual({
    name: "ctx7",
    scope: "user",
    envFile: "secrets.env",
    agent: false,
    server: ["node", "s.js"],
  });
});

test("parseMcpAdd defaults scope=project, env-file=.env", () => {
  const p = parseMcpAdd(["add", "x", "--", "serve"]);
  expect(p).toMatchObject({ scope: "project", envFile: ".env", agent: false });
});

test("parseMcpAdd errors without `add`, without a name, or without a server", () => {
  expect(parseMcpAdd(["list"])).toHaveProperty("error");
  expect(parseMcpAdd(["add", "--"])).toHaveProperty("error");
  expect(parseMcpAdd(["add", "x"])).toHaveProperty("error");
  expect(parseMcpAdd(["add", "x", "--bogus", "--", "serve"])).toHaveProperty("error");
});

test("buildMcpAddArgv keeps the server as separate argv (non-agent path)", () => {
  const p = parseMcpAdd(["add", "fs", "--", "mcp-fs", "--root", "/my dir"]);
  if ("error" in p) throw new Error(p.error);
  const argv = buildMcpAddArgv(p);
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
  const p = parseMcpAdd(["add", "sb", "--agent", "--env-file", "a b.env", "--", "mcp-sb", "--flag", "x;y"]);
  if ("error" in p) throw new Error(p.error);
  const argv = buildMcpAddArgv(p);
  // After `sh -c <script> botu-mcp`, the env-file and each server arg are distinct
  // positionals — never concatenated into the script — so quoting can't be broken.
  const shIdx = argv.indexOf("sh");
  expect(argv.slice(shIdx, shIdx + 2)).toEqual(["sh", "-c"]);
  expect(argv.slice(shIdx + 3)).toEqual(["botu-mcp", "a b.env", "mcp-sb", "--flag", "x;y"]);
  expect(argv[shIdx + 2]).toContain("op-claude-agent");
});
