// Pure builders behind the launchd resource + the `[boom]` schedulers: interval parsing,
// deterministic plist rendering, and Label extraction. No launchctl (the effectful helpers are
// darwin-only and exercised via the resource tests). The upgrade-newer compare used to live here
// too; it moved into test/version-compare.test.ts with the comparator it now exercises.
import { expect, test } from "bun:test";
import {
  agentLastExit,
  parseInterval,
  plistEnvValue,
  plistLabel,
  renderAgentPlist,
  samePathSet,
} from "../src/lib/launchd.ts";

test("parseInterval normalizes s/m/h and bare seconds", () => {
  expect(parseInterval("30s")).toBe(30);
  expect(parseInterval("15m")).toBe(900);
  expect(parseInterval("1h")).toBe(3600);
  expect(parseInterval("900")).toBe(900);
});

test("renderAgentPlist is deterministic and well-formed", () => {
  const a = renderAgentPlist({ label: "com.x", programArgs: ["/b/boom", "verify"], startInterval: 900 });
  const b = renderAgentPlist({ label: "com.x", programArgs: ["/b/boom", "verify"], startInterval: 900 });
  expect(a).toBe(b); // byte-identical → an unchanged config is a no-op sync
  expect(a).toContain("<key>Label</key>");
  expect(a).toContain("<string>com.x</string>");
  expect(a).toContain("<string>/b/boom</string>");
  expect(a).toContain("<string>verify</string>");
  expect(a).toContain("<key>StartInterval</key>");
  expect(a).toContain("<integer>900</integer>");
  expect(a).toContain("<false/>"); // RunAtLoad defaults off
});

test("renderAgentPlist XML-escapes argv and includes log paths when given", () => {
  const p = renderAgentPlist({
    label: "com.x",
    programArgs: ["/b/boom", "a&b", "<x>"],
    startInterval: 60,
    stdoutPath: "/l/x.log",
    stderrPath: "/l/x.log",
  });
  expect(p).toContain("<string>a&amp;b</string>");
  expect(p).toContain("<string>&lt;x&gt;</string>");
  expect(p).toContain("<key>StandardOutPath</key>");
  expect(p).toContain("<string>/l/x.log</string>");
});

test("renderAgentPlist carries an environment, sorted, and omits the key when empty", () => {
  // launchd hands an agent a minimal PATH, not the user's — so a scheduled command that shells
  // out to a version-manager-installed tool cannot find it. Without EnvironmentVariables the
  // failure is silent by construction: it goes to the agent's own log and nowhere else.
  const p = renderAgentPlist({
    label: "com.x",
    programArgs: ["/b/boom", "code", "fetch"],
    startInterval: 900,
    environment: { PATH: "/opt/mise/shims:/usr/bin", LANG: "en_US.UTF-8" },
  });
  expect(p).toContain("<key>EnvironmentVariables</key>");
  expect(p).toContain("<key>PATH</key>");
  expect(p).toContain("<string>/opt/mise/shims:/usr/bin</string>");
  // Sorted: LANG before PATH, so the render is a pure function of its inputs and verify's
  // byte-comparison can't see object key order as drift.
  expect(p.indexOf("<key>LANG</key>")).toBeLessThan(p.indexOf("<key>PATH</key>"));

  // Absent and empty both render nothing, so plists needing no env stay byte-identical to what
  // earlier versions wrote — an upgrade must not churn every live timer.
  const none = renderAgentPlist({ label: "com.x", programArgs: ["/b"], startInterval: 60 });
  const empty = renderAgentPlist({ label: "com.x", programArgs: ["/b"], startInterval: 60, environment: {} });
  expect(none).not.toContain("EnvironmentVariables");
  expect(empty).toBe(none);
});

test("renderAgentPlist XML-escapes environment keys and values", () => {
  const p = renderAgentPlist({
    label: "com.x",
    programArgs: ["/b"],
    startInterval: 60,
    environment: { "A&B": "<v>" },
  });
  expect(p).toContain("<key>A&amp;B</key>");
  expect(p).toContain("<string>&lt;v&gt;</string>");
});

test("agentLastExit parses launchctl's LastExitStatus, and is undefined when unloaded", () => {
  // A stripped env has no launchctl (and no such agent), which must read as "unknown" rather
  // than as "healthy" — the failure mode this guards against is a failing timer looking fine.
  expect(agentLastExit("com.boomtube.definitely-not-loaded", { PATH: "/nonexistent" })).toBeUndefined();
});

test("plistLabel extracts the Label, or undefined when absent", () => {
  const p = renderAgentPlist({ label: "com.boomtube.verify", programArgs: ["/b"], startInterval: 60 });
  expect(plistLabel(p)).toBe("com.boomtube.verify");
  expect(plistLabel("<plist><dict></dict></plist>")).toBeUndefined();
});

// --- PATH comparison: a set, not a string -----------------------------------
// A recorded PATH was compared to a freshly-read one byte-for-byte, so a machine whose PATH is
// merely ORDERED differently under `zsh -i` vs `zsh -l` — which is every machine using a version
// manager — reported timer drift on every run. `boom verify` exited 2 forever on a converged
// box, and 7 of 10 syncs rewrote the same two plists without reaching a fixed point.

test("samePathSet ignores order and duplicates", () => {
  expect(samePathSet("/a:/b:/c", "/c:/a:/b")).toBe(true);
  expect(samePathSet("/a:/b", "/b:/a:/b")).toBe(true);
  expect(samePathSet("/a:/b", "/a:/b")).toBe(true);
});

test("samePathSet ignores a trailing slash and empty entries", () => {
  expect(samePathSet("/a/:/b", "/a:/b")).toBe(true);
  expect(samePathSet("/a::/b", "/b:/a")).toBe(true);
});

test("samePathSet still reports a genuinely changed PATH", () => {
  // The property worth keeping: a directory that DISAPPEARED is real drift, because the timer
  // may no longer find `gh` or `git`.
  expect(samePathSet("/a:/b:/c", "/a:/b")).toBe(false);
  expect(samePathSet("/a:/b", "/a:/b:/c")).toBe(false);
  expect(samePathSet("/a:/b", "/a:/different")).toBe(false);
});

test("samePathSet handles undefined on either side", () => {
  expect(samePathSet(undefined, undefined)).toBe(true);
  expect(samePathSet("/a", undefined)).toBe(false);
  expect(samePathSet(undefined, "/a")).toBe(false);
});

test("plistEnvValue reads back a recorded PATH, and nothing when there is none", () => {
  const withEnv = renderAgentPlist({
    label: "com.x",
    programArgs: ["/b/boom", "verify"],
    startInterval: 900,
    environment: { PATH: "/opt/homebrew/bin:/usr/bin" },
  });
  expect(plistEnvValue(withEnv, "PATH")).toBe("/opt/homebrew/bin:/usr/bin");
  expect(plistEnvValue(withEnv, "NOPE")).toBeUndefined();

  const withoutEnv = renderAgentPlist({
    label: "com.x",
    programArgs: ["/b/boom", "verify"],
    startInterval: 900,
  });
  expect(plistEnvValue(withoutEnv, "PATH")).toBeUndefined();
});

test("a reordered PATH re-renders to a plist that differs ONLY in PATH", () => {
  // This is the equivalence `applyTimer` relies on: re-render with the recorded PATH and the
  // file must come back byte-identical, which is what proves nothing else drifted.
  const opts = { label: "com.x", programArgs: ["/b/boom", "verify"], startInterval: 900 } as const;
  const recorded = renderAgentPlist({ ...opts, environment: { PATH: "/a:/b:/c" } });
  const fresh = renderAgentPlist({ ...opts, environment: { PATH: "/c:/b:/a" } });
  expect(recorded).not.toBe(fresh); // byte comparison: drift
  const readBack = plistEnvValue(recorded, "PATH");
  expect(renderAgentPlist({ ...opts, environment: { PATH: readBack ?? "" } })).toBe(recorded);
  expect(samePathSet(readBack, "/c:/b:/a")).toBe(true); // set comparison: no drift
});

test("a plist that differs beyond PATH is still drift", () => {
  const opts = { label: "com.x", programArgs: ["/b/boom", "verify"] } as const;
  const recorded = renderAgentPlist({ ...opts, startInterval: 900, environment: { PATH: "/a" } });
  // Different interval — re-rendering with the recorded PATH must NOT reproduce the file.
  const fresh = renderAgentPlist({ ...opts, startInterval: 1800, environment: { PATH: "/a" } });
  expect(fresh).not.toBe(recorded);
  expect(
    renderAgentPlist({
      ...opts,
      startInterval: 1800,
      environment: { PATH: plistEnvValue(recorded, "PATH") ?? "" },
    }),
  ).not.toBe(recorded);
});
