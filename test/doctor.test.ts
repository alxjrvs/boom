// `boom doctor`: the machine walk, and `--config` — the config-repo CI gate that schema-checks
// every boomfile without walking the machine. Both through the engine directly and through the
// CLI, since the gate's exit code is what a workflow step keys on.
import { expect, test } from "bun:test";
import { run } from "@stricli/core";
import { app } from "../src/cli.ts";
import { doctor } from "../src/engine/doctor.ts";
import { fakeCtx } from "./support/ctx.ts";
import { makeSandbox, type Sandbox } from "./support/sandbox.ts";
import { tmp } from "./support/tmp.ts";

const sandbox = (boomfile: string): Promise<Sandbox> =>
  makeSandbox(boomfile, { prefix: "doctor", env: { BOOM_HOST: "testhost" } });

// ---- doctor --config (the folded-in `boom validate`) ------------------------

test("doctor --config accepts a valid base + overlay and reports each file", async () => {
  const sb = await sandbox(`[[section]]\nname = "base"\n`);
  await sb.write("boomfile.linux.toml", `[[section]]\nname = "linux"\n`);
  expect(await doctor(sb.ctx, false, true)).toBe(0);
  expect(sb.out()).toContain("boomfile.toml");
  expect(sb.out()).toContain("boomfile.linux.toml");
  expect(sb.out()).toContain("DOCTOR...COMPLETE!"); // the cosmic verdict band replaces the plain summary
});

test("doctor --config --json emits a versioned report envelope", async () => {
  const sb = await sandbox(`[[section]]\nname = "base"\n`);
  expect(await doctor(sb.ctx, true, true)).toBe(0);
  const env = JSON.parse(sb.out());
  expect(env.schemaVersion).toBe(2);
  expect(env.ok).toBe(true);
  expect(env.failures).toBe(0);
  expect(Array.isArray(env.records)).toBe(true);
});

test("doctor --config fails (exit 1) on a schema-invalid overlay", async () => {
  const sb = await sandbox(`[[section]]\nname = "base"\n`);
  await sb.write("boomfile.darwin.toml", `[[section]]\nlink = "not-an-array"\n`);
  expect(await doctor(sb.ctx, false, true)).toBe(1);
});

test("doctor --config fails when no dotfiles repo resolves (strict CI gate)", async () => {
  const { ctx } = fakeCtx({ XDG_STATE_HOME: await tmp("doctor"), NO_COLOR: "1" }, await tmp("doctor"));
  expect(await doctor(ctx, false, true)).toBe(1);
});

// ---- doctor --config through the CLI ------------------------------------------

test("doctor --config passes (exit 0) on a valid boomfile without walking the machine", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\nlink = [{ src = "a", dst = "~/.a" }]\n');
  await run(app, ["doctor", "--config"], sb.ctx);
  expect(sb.code()).toBe(0);
  // A CI gate schema-checks the config; it must not walk the machine. The validator reports
  // one line per config file (the boomfile), never per resource/section drift.
  expect(sb.out()).toContain("boomfile.toml");
  expect(sb.out()).not.toContain("~/.a"); // no link-resource walk happened
});

test("doctor --config fails (exit 1) on a schema-invalid boomfile (unknown key)", async () => {
  const sb = await sandbox('[[section]]\nname = "x"\nbogus = true\n');
  await run(app, ["doctor", "--config"], sb.ctx);
  expect(sb.code()).toBe(1);
});

test("doctor --config fails (exit 1) when no config repo resolves (strict gate)", async () => {
  // No config pointer, and a cwd where nothing resolves.
  const { ctx, code } = fakeCtx({ XDG_STATE_HOME: await tmp("doctor"), NO_COLOR: "1" }, await tmp("doctor"));
  await run(app, ["doctor", "--config"], ctx);
  expect(code()).toBe(1);
});

// ---- doctor ------------------------------------------------------------------

// An empty PATH so no tool resolves: every probe warns, and the exit code is a fixed 2 rather
// than whatever the host machine happens to have installed. BOOM_OS=linux skips the macOS
// keychain probe for the same reason.
const walk = (boomfile: string): Promise<Sandbox> =>
  makeSandbox(boomfile, { prefix: "doctor", emptyPath: true, env: { BOOM_OS: "linux" } });

test("doctor reports a parseable config and a writable state dir", async () => {
  const sb = await walk(`[[section]]\nname = "x"\n`);
  expect(await doctor(sb.ctx)).toBe(2);
  expect(sb.out()).toContain("boomfile.toml — 1 section(s)");
  expect(sb.out()).toContain("state dir writable");
  expect(sb.out()).toContain("brew not on PATH");
});

test("doctor --json emits a versioned report envelope", async () => {
  const sb = await walk(`[[section]]\nname = "x"\n`);
  expect(await doctor(sb.ctx, true)).toBe(2);
  const env = JSON.parse(sb.out());
  expect(env.schemaVersion).toBe(2);
  expect(env.ok).toBe(true); // warnings, no failures
  expect(env.warnings).toBeGreaterThan(0);
  expect(Array.isArray(env.records)).toBe(true);
});

test("doctor fails (exit 1) on an unparseable boomfile", async () => {
  const sb = await walk(`this = is = not = toml`);
  expect(await doctor(sb.ctx)).toBe(1);
});

test("doctor warns when no remote config is linked", async () => {
  const { ctx, out } = fakeCtx(
    { XDG_STATE_HOME: await tmp("doctor"), BOOM_OS: "linux", NO_COLOR: "1" },
    await tmp("doctor"),
  );
  await doctor(ctx);
  expect(out()).toContain("no config repo linked");
});
