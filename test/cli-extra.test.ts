// Coverage for the commands added alongside the watchtower removal: completions, man,
// the shared command catalog, and the read-only doctor / validate engines.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_NAMES, COMMANDS } from "../src/commands/catalog.ts";
import { completionScript } from "../src/commands/completions.ts";
import { manPage } from "../src/commands/man.ts";
import { skillDoc } from "../src/commands/skill.ts";
import type { BotuContext } from "../src/context.ts";
import { doctor } from "../src/engine/doctor.ts";
import { validateConfig } from "../src/engine/validate.ts";

async function base(): Promise<string> {
  return mkdtemp(join(tmpdir(), "botu-x-"));
}

function ctxFor(env: Record<string, string | undefined>, cwd: string): { ctx: BotuContext; out(): string } {
  const buf = { out: "" };
  const write = (s: string) => {
    buf.out += s;
  };
  const proc = { stdout: { write }, stderr: { write }, env, exitCode: 0 };
  return { ctx: { process: proc, env, cwd } as unknown as BotuContext, out: () => buf.out };
}

// ---- catalog ----------------------------------------------------------------

test("catalog command names are unique and include the core verbs", () => {
  expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length);
  for (const v of ["apply", "verify", "repair", "uninstall", "source", "doctor", "validate"]) {
    expect(COMMAND_NAMES).toContain(v);
  }
  expect(COMMAND_NAMES).not.toContain("watchtower");
});

// ---- completions ------------------------------------------------------------

test("bash completion lists every command and wires the function", () => {
  const s = completionScript("bash");
  expect(s).toContain("complete -F _botu botu");
  for (const name of COMMAND_NAMES) expect(s).toContain(name);
});

test("zsh completion is a #compdef with described commands", () => {
  const s = completionScript("zsh");
  expect(s.startsWith("#compdef botu")).toBe(true);
  expect(s).toContain("_describe");
  expect(s).toContain(`'validate:${COMMANDS.find((c) => c.name === "validate")?.brief}'`);
  // An apostrophe in a brief is escaped for the single-quoted zsh literal.
  expect(s).toContain("'\\''");
});

test("fish completion emits a per-command line", () => {
  const s = completionScript("fish");
  expect(s).toContain("complete -c botu -f");
  expect(s).toContain("-a 'verify'");
});

// ---- man ---------------------------------------------------------------------

test("man page is valid-ish roff naming every command", () => {
  const m = manPage("9.9.9");
  expect(m).toContain('.TH BOTU 1 "" "botu 9.9.9"');
  expect(m).toContain(".SH COMMANDS");
  for (const c of COMMANDS) expect(m).toContain(`.B ${c.name}`);
});

// ---- skill -------------------------------------------------------------------

test("skill doc is a SKILL.md with frontmatter naming every command", () => {
  const s = skillDoc("9.9.9");
  expect(s).toStartWith("---\nname: botu\n");
  expect(s).toContain("# botu (v9.9.9)"); // version stamped in the heading
  for (const c of COMMANDS) expect(s).toContain(`\`botu ${c.name}\``);
  // the safety facts an agent must not miss
  expect(s).toContain("--dry-run");
  expect(s).toContain("--json");
  expect(s).toContain("source reset --force");
});

// ---- validate ----------------------------------------------------------------

test("validate accepts a valid base + overlay and reports each file", async () => {
  const repo = await base();
  await writeFile(join(repo, "botufile.toml"), `[[section]]\nname = "base"\n`);
  await writeFile(join(repo, "botufile.linux.toml"), `[[section]]\nname = "linux"\n`);
  const { ctx, out } = ctxFor({ BOTU_CONFIG: repo, NO_COLOR: "1" }, repo);
  expect(await validateConfig(ctx)).toBe(0);
  expect(out()).toContain("botufile.toml");
  expect(out()).toContain("botufile.linux.toml");
  expect(out()).toContain("config OK");
});

test("validate fails (exit 1) on a schema-invalid overlay", async () => {
  const repo = await base();
  await writeFile(join(repo, "botufile.toml"), `[[section]]\nname = "base"\n`);
  await writeFile(join(repo, "botufile.darwin.toml"), `[[section]]\nlink = "not-an-array"\n`);
  const { ctx } = ctxFor({ BOTU_CONFIG: repo, NO_COLOR: "1" }, repo);
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
  await writeFile(join(repo, "botufile.toml"), `[[section]]\nname = "x"\n`);
  const state = await base();
  // BOTU_OS=linux skips the macOS keychain probe so the result is deterministic.
  const { ctx, out } = ctxFor(
    { BOTU_CONFIG: repo, XDG_STATE_HOME: state, BOTU_OS: "linux", NO_COLOR: "1" },
    repo,
  );
  const rc = await doctor(ctx);
  expect(out()).toContain("botufile.toml — 1 section(s)");
  expect(out()).toContain("state dir writable");
  // No failures possible here (config valid, state writable); tool warnings may bump to 2.
  expect([0, 2]).toContain(rc);
});

test("doctor fails (exit 1) on an unparseable botufile", async () => {
  const repo = await base();
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "botufile.toml"), `this = is = not = toml`);
  const { ctx } = ctxFor(
    { BOTU_CONFIG: repo, XDG_STATE_HOME: await base(), BOTU_OS: "linux", NO_COLOR: "1" },
    repo,
  );
  expect(await doctor(ctx)).toBe(1);
});
