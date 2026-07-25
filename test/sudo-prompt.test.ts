// Naming *what* is asking for the password.
//
// Making the prompt visible was step one; a bare "Password:" still doesn't say who wants it or why,
// and mid-run it's indistinguishable from any other program on the machine deciding to ask. Two
// mechanisms fix that, and they're split because sudo's own escape set (`%p`, `%u`, `%H`…) has
// nothing for the *command*:
//   • SUDO_PROMPT relabels the prompt itself with boom's name and the step's.
//   • the tool's own progress output supplies the specific thing — Homebrew's "==> Upgrading cask
//     tuple" — relayed as a live line so it sits directly above the prompt.
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoomContext } from "../src/context.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import { runArgvAsync } from "../src/lib/proc.ts";
import { Reporter } from "../src/lib/reporter.ts";

async function base(): Promise<string> {
  return mkdtemp(join(tmpdir(), "boom-sudoprompt-"));
}

function sink() {
  const buf = { out: "" };
  return {
    stream: {
      write(s: string) {
        buf.out += s;
      },
    },
    read: () => buf.out,
  };
}

// ------------------------------------------------------------------ proc: watching stdout

test("onStdoutLine sees whole lines, reassembled across chunk boundaries", async () => {
  const lines: string[] = [];
  // printf in one write, but the pump must not depend on that — the assertion is on content.
  const r = await runArgvAsync(
    ["sh", "-c", "printf 'a\\nbb\\nccc\\n'"],
    {},
    {
      silent: true,
      onStdoutLine: (l) => lines.push(l),
    },
  );
  expect(r.code).toBe(0);
  expect(lines).toEqual(["a", "bb", "ccc"]);
});

test("onStdoutLine flushes an unterminated final line (a tool needn't end with a newline)", async () => {
  const lines: string[] = [];
  await runArgvAsync(
    ["sh", "-c", "printf 'done\\nno-newline'"],
    {},
    {
      silent: true,
      onStdoutLine: (l) => lines.push(l),
    },
  );
  expect(lines).toEqual(["done", "no-newline"]);
});

test("onStdoutLine does not deadlock a chatty child (the pipe is drained while it runs)", async () => {
  // 5k lines is far past a pipe buffer: if stdout weren't pumped concurrently with the exit, the
  // child would block on write and this would hang rather than fail.
  let count = 0;
  const r = await runArgvAsync(
    ["sh", "-c", "i=0; while [ $i -lt 5000 ]; do echo line-$i; i=$((i+1)); done"],
    {},
    {
      silent: true,
      onStdoutLine: () => count++,
    },
  );
  expect(r.code).toBe(0);
  expect(count).toBe(5000);
});

test("a watched step still captures stderr, so a failure is still explainable", async () => {
  const r = await runArgvAsync(
    ["sh", "-c", "echo out; echo bad 1>&2; exit 3"],
    {},
    {
      silent: true,
      onStdoutLine: () => {},
    },
  );
  expect(r.code).toBe(3);
  expect(r.stderr).toContain("bad");
});

// ------------------------------------------------------------------- reporter: the live line

test("live() writes immediately — a band-buffered line would print after the prompt it explains", () => {
  const s = sink();
  // bands mode on: every other sub-line would be held until the band closes. live() must not be.
  const r = new Reporter(s.stream, s.stream, true, false, false, true, true, false);
  r.live("Upgrading cask tuple");
  expect(s.read()).toContain("Upgrading cask tuple");
});

test("live() is suppressed for JSON (envelope stays clean) and verbose (tool already streams)", () => {
  const j = sink();
  new Reporter(j.stream, j.stream, true, true, false, true, true, false).live("x");
  expect(j.read()).toBe("");
  const v = sink();
  new Reporter(v.stream, v.stream, true, false, true, true, true, false).live("x");
  expect(v.read()).toBe("");
});

// -------------------------------------------------------------- end-to-end through reconcile

async function brewSandbox(boomfile: string, brewfile: string, brewScript: string) {
  const root = await base();
  const home = join(root, "home");
  const repo = join(root, "repo");
  const bin = join(repo, ".fakebin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(repo, "boomfile.toml"), boomfile);
  await writeFile(join(repo, "Brewfile"), brewfile);
  await writeFile(join(bin, "brew"), `#!/bin/sh\n${brewScript}`);
  await chmod(join(bin, "brew"), 0o755);
  const env: Record<string, string | undefined> = {
    HOME: home,
    XDG_STATE_HOME: join(root, "state"),
    BOOM_CONFIG: repo,
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}:/usr/bin:/bin`,
  };
  const buf = { out: "" };
  const write = (s: string): void => {
    buf.out += s;
  };
  const proc = { stdout: { write }, stderr: { write }, env, exitCode: 0 };
  return {
    repo,
    ctx: { process: proc, env, cwd: repo } as unknown as BoomContext,
    out: () => buf.out,
  };
}

const PKG_SECTION = `[[section]]\nname = "P"\npkg = [{ manager = "brew" }]\n`;

test("brew's own ==> headers are relayed, so the cask that escalates is named", async () => {
  const sb = await brewSandbox(
    PKG_SECTION,
    'brew "mise"\ncask "tuple"\n',
    'echo "==> Downloading https://example.com/t.zip"\necho "####### 45.2%"\necho "==> Upgrading cask tuple"\nexit 0\n',
  );
  expect(await reconcile("sync", sb.ctx, { update: true })).toBe(0);
  expect(sb.out()).toContain("Upgrading cask tuple");
  // Only headers — Homebrew's byte-count noise stays hidden under the band.
  expect(sb.out()).not.toContain("45.2%");
});

test("SUDO_PROMPT names boom and the step, so a prompt is never anonymous", async () => {
  const root = await base();
  const log = join(root, "prompt");
  const sb = await brewSandbox(PKG_SECTION, 'cask "tuple"\n', `echo "$SUDO_PROMPT" > ${log}\nexit 0\n`);
  expect(await reconcile("sync", sb.ctx, { update: true })).toBe(0);
  const prompt = (await readFile(log, "utf8")).trim();
  expect(prompt).toContain("[boom]");
  expect(prompt).toContain("brew bundle");
  expect(prompt).toContain("%p"); // sudo substitutes the user whose password is wanted
});

test("no SUDO_PROMPT and no relay when a formula-only Brewfile can't escalate", async () => {
  const root = await base();
  const log = join(root, "prompt");
  const sb = await brewSandbox(
    PKG_SECTION,
    'brew "mise"\n',
    `echo "$SUDO_PROMPT" > ${log}\necho "==> Pouring mise"\nexit 0\n`,
  );
  expect(await reconcile("sync", sb.ctx, { update: true })).toBe(0);
  expect((await readFile(log, "utf8")).trim()).toBe("");
  expect(sb.out()).not.toContain("Pouring mise"); // nothing can prompt → nothing to narrate
});

test("an askpass shim answering means no prompt to label and no relay", async () => {
  const root = await base();
  const log = join(root, "prompt");
  const sb = await brewSandbox(
    `[boom]\nsudo_askpass = "env:PW"\n\n${PKG_SECTION}`,
    'cask "tuple"\n',
    `echo "$SUDO_PROMPT" > ${log}\necho "==> Upgrading cask tuple"\nexit 0\n`,
  );
  expect(await reconcile("sync", sb.ctx, { update: true })).toBe(0);
  expect((await readFile(log, "utf8")).trim()).toBe("");
  expect(sb.out()).not.toContain("Upgrading cask tuple");
});
