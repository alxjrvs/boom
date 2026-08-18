// Pure builders behind the launchd resource + the `[boom]` schedulers: interval parsing,
// deterministic plist rendering, and Label extraction. No launchctl (the effectful helpers are
// darwin-only and exercised via the resource tests). The upgrade-newer compare used to live here
// too; it moved into test/version-compare.test.ts with the comparator it now exercises.
import { expect, test } from "bun:test";
import { agentLastExit, parseInterval, plistLabel, renderAgentPlist } from "../src/lib/launchd.ts";

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
