// Coverage for the shared command catalog and the read-only doctor / validate engines.
// The completions and man cases went with those commands.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@stricli/core";
import { app, routes } from "../src/cli.ts";
import { commandList, commandNames } from "../src/commands/catalog.ts";
import type { BoomContext } from "../src/context.ts";
import { doctor } from "../src/engine/doctor.ts";
import { skillDoc } from "../src/engine/skill.ts";
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

// The exact set, not a contains-list: the catalog DERIVES this from the route map, so a route
// added or re-added by accident would otherwise reappear in every derived surface (the skill
// most of all) with nothing to catch it.
test("command list (derived from the route map) is exactly the five built-ins", () => {
  expect([...commandNames()].sort()).toEqual(["doctor", "skill", "source", "uninstall", "verify"]);
});

test("`source` is the one nested route map, and it routes exactly sync + set", () => {
  const nested = routes
    .getAllEntries()
    .filter((e) => !e.hidden && "getAllEntries" in e.target)
    .map((e) => ({
      parent: e.name.original,
      children: (e.target as typeof routes)
        .getAllEntries()
        .map((c) => c.name.original)
        .sort(),
    }));
  expect(nested).toEqual([{ parent: "source", children: ["set", "sync"] }]);
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

// ---- man ---------------------------------------------------------------------

// ---- skill -------------------------------------------------------------------

test("skill doc is a SKILL.md with frontmatter naming every command", () => {
  const s = skillDoc("9.9.9");
  expect(s).toStartWith("---\nname: boom\n");
  expect(s).toContain("# boom (v9.9.9)"); // version stamped in the heading
  for (const c of commandList()) expect(s).toContain(`\`boom ${c.name}\``);
  // the safety facts an agent must not miss
  expect(s).toContain("--dry-run");
  expect(s).toContain("--json");
  expect(s).toContain("boom uninstall");
});

// The inverse of the case above. skill.ts's command reference is generated from the catalog and
// cannot name a dead verb; the hand-written guidance around it can, and has — so every `boom X`
// the doc mentions is checked against the route map.
test("the skill names no command that isn't a route", () => {
  const s = skillDoc("9.9.9");
  const real = new Set(commandNames());
  const mentioned = [...s.matchAll(/`boom ([a-z][a-z-]*)/g)].map((m) => m[1] as string);
  expect(mentioned.length).toBeGreaterThan(0); // guard the guard
  const ghosts = [...new Set(mentioned)].filter((v) => !real.has(v));
  expect(ghosts).toEqual([]);
});

test("skill --install writes SKILL.md under the Claude config dir", async () => {
  const cfg = await base(); // stand in for ~/.claude via CLAUDE_CONFIG_DIR
  const { ctx, out } = ctxFor({ CLAUDE_CONFIG_DIR: cfg, NO_COLOR: "1" }, cfg);
  await run(app, ["skill", "--install"], ctx);
  const file = join(cfg, "skills", "boom", "SKILL.md");
  expect(await readFile(file, "utf8")).toStartWith("---\nname: boom\n");
  expect(out()).toContain(`installed skill → ${file}`);
});

// ---- doctor --config (the folded-in `boom validate`) ------------------------

test("doctor --config accepts a valid base + overlay and reports each file", async () => {
  const repo = await base();
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "base"\n`);
  await writeFile(join(repo, "boomfile.linux.toml"), `[[section]]\nname = "linux"\n`);
  const { ctx, out } = ctxFor({ BOOM_CONFIG: repo, NO_COLOR: "1" }, repo);
  expect(await doctor(ctx, false, true)).toBe(0);
  expect(out()).toContain("boomfile.toml");
  expect(out()).toContain("boomfile.linux.toml");
  expect(out()).toContain("DOCTOR...COMPLETE!"); // the cosmic verdict band replaces the plain summary
});

test("doctor --config --json emits a versioned report envelope", async () => {
  const repo = await base();
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "base"\n`);
  const { ctx, out } = ctxFor({ BOOM_CONFIG: repo, NO_COLOR: "1" }, repo);
  expect(await doctor(ctx, true, true)).toBe(0);
  const env = JSON.parse(out());
  expect(env.schemaVersion).toBe(2);
  expect(env.ok).toBe(true);
  expect(env.failures).toBe(0);
  expect(Array.isArray(env.records)).toBe(true);
});

test("doctor --config fails (exit 1) on a schema-invalid overlay", async () => {
  const repo = await base();
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "base"\n`);
  await writeFile(join(repo, "boomfile.darwin.toml"), `[[section]]\nlink = "not-an-array"\n`);
  const { ctx } = ctxFor({ BOOM_CONFIG: repo, NO_COLOR: "1" }, repo);
  expect(await doctor(ctx, false, true)).toBe(1);
});

test("doctor --config fails when no dotfiles repo resolves (strict CI gate)", async () => {
  const empty = await base();
  const { ctx } = ctxFor({ XDG_STATE_HOME: await base(), NO_COLOR: "1" }, empty);
  expect(await doctor(ctx, false, true)).toBe(1);
});

// ---- doctor ------------------------------------------------------------------

// An empty PATH so no tool resolves: every probe warns, and the exit code is a fixed 2 rather
// than whatever the host machine happens to have installed. BOOM_OS=linux skips the macOS
// keychain probe for the same reason.
test("doctor reports a parseable config and a writable state dir", async () => {
  const repo = await base();
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  const state = await base();
  const { ctx, out } = ctxFor(
    { BOOM_CONFIG: repo, XDG_STATE_HOME: state, BOOM_OS: "linux", NO_COLOR: "1", PATH: await base() },
    repo,
  );
  expect(await doctor(ctx)).toBe(2);
  expect(out()).toContain("boomfile.toml — 1 section(s)");
  expect(out()).toContain("state dir writable");
  expect(out()).toContain("brew not on PATH");
});

test("doctor --json emits a versioned report envelope", async () => {
  const repo = await base();
  await writeFile(join(repo, "boomfile.toml"), `[[section]]\nname = "x"\n`);
  const { ctx, out } = ctxFor(
    { BOOM_CONFIG: repo, XDG_STATE_HOME: await base(), BOOM_OS: "linux", NO_COLOR: "1", PATH: await base() },
    repo,
  );
  expect(await doctor(ctx, true)).toBe(2);
  const env = JSON.parse(out());
  expect(env.schemaVersion).toBe(2);
  expect(env.ok).toBe(true); // warnings, no failures
  expect(env.warnings).toBeGreaterThan(0);
  expect(Array.isArray(env.records)).toBe(true);
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
