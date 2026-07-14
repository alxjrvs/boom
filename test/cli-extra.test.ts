// Coverage for the commands added alongside the watchtower removal: completions, man,
// the shared command catalog, and the read-only doctor / validate engines.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@stricli/core";
import { app } from "../src/cli.ts";
import { commandList, commandNames, subcommandGroups } from "../src/commands/catalog.ts";
import { completionScript } from "../src/commands/completions.ts";
import { manPage } from "../src/commands/man.ts";
import { skillDoc } from "../src/commands/skill.ts";
import type { BoomContext } from "../src/context.ts";
import { doctor } from "../src/engine/doctor.ts";
import { validateConfig } from "../src/engine/validate.ts";
import { colorEnabled } from "../src/lib/color.ts";
import { hasCommand } from "../src/lib/proc.ts";

async function base(): Promise<string> {
  return mkdtemp(join(tmpdir(), "boom-x-"));
}

function ctxFor(env: Record<string, string | undefined>, cwd: string): { ctx: BoomContext; out(): string } {
  const buf = { out: "" };
  const write = (s: string) => {
    buf.out += s;
  };
  const proc = { stdout: { write }, stderr: { write }, env, exitCode: 0 };
  return { ctx: { process: proc, env, cwd } as unknown as BoomContext, out: () => buf.out };
}

// ---- catalog ----------------------------------------------------------------

test("command list (derived from the route map) is unique and includes the core verbs", () => {
  const names = commandNames();
  expect(new Set(names).size).toBe(names.length);
  // mcp is a real route now, so it must appear in the derived list like any other.
  for (const v of ["verify", "uninstall", "source", "mcp", "doctor", "validate"]) {
    expect(names).toContain(v);
  }
  expect(names).not.toContain("watchtower");
});

// ---- completions ------------------------------------------------------------

test("bash completion lists every command and wires the function", () => {
  const s = completionScript("bash");
  expect(s).toContain("complete -F _boom boom");
  for (const name of commandNames()) expect(s).toContain(name);
});

test("zsh completion is a #compdef with described commands", () => {
  const s = completionScript("zsh");
  expect(s.startsWith("#compdef boom")).toBe(true);
  expect(s).toContain("_describe");
  expect(s).toContain(`'validate:${commandList().find((c) => c.name === "validate")?.brief}'`);
  // An apostrophe in a brief is escaped for the single-quoted zsh literal.
  expect(s).toContain("'\\''");
});

test("fish completion emits a per-command line", () => {
  const s = completionScript("fish");
  expect(s).toContain("complete -c boom -f");
  expect(s).toContain("-a 'verify'");
});

test("subcommandGroups derives nested routes from the route map", () => {
  const groups = subcommandGroups();
  const source = groups.find((g) => g.parent === "source");
  const names = source?.children.map((c) => c.name) ?? [];
  for (const sub of ["set", "status", "diff", "push", "reset"]) expect(names).toContain(sub);
  expect(groups.find((g) => g.parent === "code")?.children.map((c) => c.name)).toContain("claude");
});

test("completions complete the second level (source|code|mcp subcommands)", () => {
  const bash = completionScript("bash");
  expect(bash).toContain("COMP_WORDS[1]"); // dispatches on the namespace word
  expect(bash).toContain("status"); // a source subcommand reachable only via the 2nd level
  const fish = completionScript("fish");
  expect(fish).toContain("__fish_seen_subcommand_from source");
  const zsh = completionScript("zsh");
  expect(zsh).toContain("source subcommand");
});

// ---- color / command detection ----------------------------------------------

test("colorEnabled: NO_COLOR forces off, FORCE_COLOR forces on", () => {
  expect(colorEnabled({ NO_COLOR: "1" })).toBe(false);
  expect(colorEnabled({ FORCE_COLOR: "1" })).toBe(true);
  // NO_COLOR wins over FORCE_COLOR (spec: any NO_COLOR value disables).
  expect(colorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
});

test("hasCommand resolves via PATH (Bun.which), not a shell", () => {
  // `sh` is always on a sane PATH; a nonsense name never is.
  expect(hasCommand("sh", process.env)).toBe(true);
  expect(hasCommand("definitely-not-a-real-binary-xyz", process.env)).toBe(false);
});

test("completions include flag names derived from the route map", () => {
  for (const shell of ["bash", "zsh", "fish"] as const) {
    const s = completionScript(shell);
    // `dry-run`/`json` are flags, not command names — so their presence proves flag
    // derivation, and it can't be confused with a command word.
    expect(s).toContain("dry-run");
    expect(s).toContain("json");
  }
});

// ---- man ---------------------------------------------------------------------

test("man page is valid-ish roff naming every command", () => {
  const m = manPage("9.9.9");
  expect(m).toContain('.TH BOOM 1 "" "boom 9.9.9"');
  expect(m).toContain(".SH COMMANDS");
  for (const c of commandList()) expect(m).toContain(`.B ${c.name}`);
});

test("man page documents nested subcommands and their flags", () => {
  const m = manPage("9.9.9");
  expect(m).toContain(".SH SUBCOMMANDS");
  expect(m).toContain(".B source sync"); // a nested route, now documented
  expect(m).toContain("--json"); // a flag, now documented under its command
});

// ---- skill -------------------------------------------------------------------

test("skill doc is a SKILL.md with frontmatter naming every command", () => {
  const s = skillDoc("9.9.9");
  expect(s).toStartWith("---\nname: boom\n");
  expect(s).toContain("# boom (v9.9.9)"); // version stamped in the heading
  for (const c of commandList()) expect(s).toContain(`\`boom ${c.name}\``);
  // the safety facts an agent must not miss
  expect(s).toContain("--dry-run");
  expect(s).toContain("--json");
  expect(s).toContain("source reset --force");
});

test("skill --install writes SKILL.md under the Claude config dir", async () => {
  const cfg = await base(); // stand in for ~/.claude via CLAUDE_CONFIG_DIR
  const { ctx, out } = ctxFor({ CLAUDE_CONFIG_DIR: cfg, NO_COLOR: "1" }, cfg);
  await run(app, ["skill", "--install"], ctx);
  const file = join(cfg, "skills", "boom", "SKILL.md");
  expect(await readFile(file, "utf8")).toStartWith("---\nname: boom\n");
  expect(out()).toContain(`installed skill → ${file}`);
});

// ---- validate ----------------------------------------------------------------

test("validate accepts a valid base + overlay and reports each file", async () => {
  const repo = await base();
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "base"\n`);
  await writeFile(join(repo, "boomfile.linux.toml"), `[[section]]\nname = "linux"\n`);
  const { ctx, out } = ctxFor({ BOOM_CONFIG: repo, NO_COLOR: "1" }, repo);
  expect(await validateConfig(ctx)).toBe(0);
  expect(out()).toContain("boomfile.toml");
  expect(out()).toContain("boomfile.linux.toml");
  expect(out()).toContain("config OK");
});

test("validate --json emits a versioned report envelope", async () => {
  const repo = await base();
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "base"\n`);
  const { ctx, out } = ctxFor({ BOOM_CONFIG: repo, NO_COLOR: "1" }, repo);
  expect(await validateConfig(ctx, true)).toBe(0);
  const env = JSON.parse(out());
  expect(env.schemaVersion).toBe(1);
  expect(env.ok).toBe(true);
  expect(env.failures).toBe(0);
  expect(Array.isArray(env.records)).toBe(true);
});

test("validate fails (exit 1) on a schema-invalid overlay", async () => {
  const repo = await base();
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "base"\n`);
  await writeFile(join(repo, "boomfile.darwin.toml"), `[[section]]\nlink = "not-an-array"\n`);
  const { ctx } = ctxFor({ BOOM_CONFIG: repo, NO_COLOR: "1" }, repo);
  expect(await validateConfig(ctx)).toBe(1);
});

test("validate fails when no dotfiles repo resolves", async () => {
  const empty = await base();
  const { ctx } = ctxFor({ XDG_STATE_HOME: await base(), NO_COLOR: "1" }, empty);
  expect(await validateConfig(ctx)).toBe(1);
});

// ---- doctor ------------------------------------------------------------------

test("doctor reports a parseable config and a writable state dir", async () => {
  const repo = await base();
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  const state = await base();
  // BOOM_OS=linux skips the macOS keychain probe so the result is deterministic.
  const { ctx, out } = ctxFor(
    { BOOM_CONFIG: repo, XDG_STATE_HOME: state, BOOM_OS: "linux", NO_COLOR: "1" },
    repo,
  );
  const rc = await doctor(ctx);
  expect(out()).toContain("boomfile.toml — 1 section(s)");
  expect(out()).toContain("state dir writable");
  // No failures possible here (config valid, state writable); tool warnings may bump to 2.
  expect([0, 2]).toContain(rc);
});

test("doctor --json emits a versioned report envelope", async () => {
  const repo = await base();
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  const { ctx, out } = ctxFor(
    { BOOM_CONFIG: repo, XDG_STATE_HOME: await base(), BOOM_OS: "linux", NO_COLOR: "1" },
    repo,
  );
  const rc = await doctor(ctx, true);
  const env = JSON.parse(out());
  expect(env.schemaVersion).toBe(1);
  expect(typeof env.ok).toBe("boolean");
  expect(Array.isArray(env.records)).toBe(true);
  expect([0, 2]).toContain(rc); // valid config + writable state; tool warnings may bump to 2
});

test("doctor fails (exit 1) on an unparseable boomfile", async () => {
  const repo = await base();
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "boomfile.toml"), `this = is = not = toml`);
  const { ctx } = ctxFor(
    { BOOM_CONFIG: repo, XDG_STATE_HOME: await base(), BOOM_OS: "linux", NO_COLOR: "1" },
    repo,
  );
  expect(await doctor(ctx)).toBe(1);
});
