// Pure builders behind the launchd resource + the `[boom]` schedulers: interval parsing,
// deterministic plist rendering, Label extraction, and the upgrade-newer compare. No
// launchctl (the effectful helpers are darwin-only and exercised via the resource tests).
import { expect, test } from "bun:test";
import { isNewer } from "../src/engine/settings.ts";
import { parseInterval, plistLabel, renderAgentPlist } from "../src/lib/launchd.ts";

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

test("plistLabel extracts the Label, or undefined when absent", () => {
  const p = renderAgentPlist({ label: "com.boomtube.verify", programArgs: ["/b"], startInterval: 60 });
  expect(plistLabel(p)).toBe("com.boomtube.verify");
  expect(plistLabel("<plist><dict></dict></plist>")).toBeUndefined();
});

test("isNewer compares release strings component-wise", () => {
  expect(isNewer("0.12.0", "0.11.0")).toBe(true);
  expect(isNewer("0.11.1", "0.11.0")).toBe(true);
  expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  expect(isNewer("0.11.0", "0.11.0")).toBe(false);
  expect(isNewer("0.10.0", "0.11.0")).toBe(false);
});
