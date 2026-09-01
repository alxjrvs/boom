import { describe, expect, test } from "bun:test";
import { failureDetail, redactSecrets } from "../src/lib/proc.ts";

describe("redactSecrets", () => {
  test("replaces a secret-named env value wherever it appears", () => {
    const env = { OP_SERVICE_ACCOUNT_TOKEN: "ops_abcdef1234567890", PATH: "/usr/bin" };
    const out = redactSecrets("curl -H 'Authorization: ops_abcdef1234567890' failed", env);
    expect(out).not.toContain("ops_abcdef1234567890");
    expect(out).toContain("«redacted:OP_SERVICE_ACCOUNT_TOKEN»");
  });

  test("leaves non-secret env values alone", () => {
    const env = { PATH: "/usr/local/bin", HOME: "/Users/someone" };
    expect(redactSecrets("could not exec /usr/local/bin/thing", env)).toContain("/usr/local/bin");
  });

  test("ignores short values so ordinary output is not corrupted", () => {
    const env = { API_KEY: "abc" };
    expect(redactSecrets("abc is a fine word", env)).toBe("abc is a fine word");
  });

  test("failureDetail scrubs, and is a no-op without an env", () => {
    const env = { NPM_TOKEN: "npm_zzzzzzzzzzzz" };
    expect(failureDetail("boom: npm_zzzzzzzzzzzz", undefined, env)).toContain("«redacted:NPM_TOKEN»");
    expect(failureDetail("boom: npm_zzzzzzzzzzzz")).toContain("npm_zzzzzzzzzzzz");
  });
});

// --- dry run must not fail on an absent package manager --------------------------------------
// A dry run changes nothing and cannot install, so a missing CLI is machine state, not a config
// defect. Before this, `boom source --dry-run` exited 1 on any box without brew — which is every
// CI runner, and exactly where previewing a boomfile is most useful.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileSection } from "../src/engine/registry.ts";

function ctxFor(dryRun: boolean, repo: string) {
  const lines: string[] = [];
  let failed = 0;
  const report = {
    category: "",
    fail(s: string) {
      failed++;
      lines.push(`FAIL ${s}`);
    },
    skip(s: string) {
      lines.push(`skip ${s}`);
    },
    note(s: string) {
      lines.push(`note ${s}`);
    },
    plan(s: string) {
      lines.push(`plan ${s}`);
    },
    ok(s: string) {
      lines.push(`ok ${s}`);
    },
    spin: <T>(_l: string, f: () => T | Promise<T>) => f(),
  };
  return {
    ctx: {
      verb: "sync" as const,
      dryRun,
      json: false,
      verbose: false,
      repo,
      // An empty PATH makes hasCommand report every manager absent, deterministically.
      env: { PATH: "" } as Record<string, string>,
      declared: new Set<string>(),
      dirty: new Set<string>(),
      report,
    },
    lines,
    failed: () => failed,
  };
}

describe("dry run with no package manager", () => {
  const repo = mkdtempSync(join(tmpdir(), "boom-pkg-"));
  writeFileSync(join(repo, "Brewfile"), 'brew "jq"\n');
  const section = { name: "pkgs", pkg: [{ manager: "brew" as const, file: "Brewfile" }] };

  test("a dry run skips rather than fails", async () => {
    const { ctx, lines, failed } = ctxFor(true, repo);
    // biome-ignore lint/suspicious/noExplicitAny: a minimal structural ctx for one resource
    await reconcileSection(section as any, ctx as any);
    expect(failed()).toBe(0);
    expect(lines.join("\n")).toContain("cannot preview its plan");
  });

  test("a real sync still fails, because there it is drift", async () => {
    const { ctx, failed } = ctxFor(false, repo);
    // biome-ignore lint/suspicious/noExplicitAny: same
    await reconcileSection(section as any, ctx as any);
    expect(failed()).toBe(1);
  });
});
