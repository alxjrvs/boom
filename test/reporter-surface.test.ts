// Golden output for every Reporter surface. tsc cannot see an output change — the six public
// level methods, three presentations and two verbosities are 36 spellings of a line, and the
// collapse onto one `emit`/`LEVEL_STYLE` path is only safe if every one of them is pinned
// byte-for-byte. These snapshots were captured from the pre-collapse Reporter and are the proof
// the refactor moved no bytes: glyph, indent, which stream, whether quiet holds it back, and the
// exit code.
import { expect, test } from "bun:test";
import { COSMIC, paintHex } from "../src/lib/color.ts";
import { Reporter, type ReportSurface } from "../src/lib/reporter.ts";

function capture(): { s: string; write(x: string): void } {
  return {
    s: "",
    write(x: string): void {
      this.s += x;
    },
  };
}

// One fixed script through every surface: a section header, one line at each level, then finish
// with a warning tier (so the 0/2/1 ladder is exercised, not just the 0/1 one).
function run(surface: ReportSurface, verbose: boolean): { out: string; err: string; code: number } {
  const out = capture();
  const err = capture();
  const r = new Reporter({ out, err }, { color: false, verbose, surface });
  r.command = "demo";
  r.category = "DOTFILES";
  r.header("Section One");
  r.ok("did a thing");
  r.skip("already fine");
  r.note("a note");
  r.plan("would do");
  r.warn("careful");
  r.fail("broke");
  const code = r.finish({ ok: "all clear", warn: (w) => `${w} warning(s)` });
  // The verdict's elapsed suffix is wall-clock; normalize it so the snapshot is about layout.
  return { out: out.s.replace(/\d+(\.\d+)?(ms|s)/g, "<t>"), err: err.s, code };
}

const GOLDEN: Record<string, { out: string; err: string; code: number }> = {
  "bands quiet": {
    out: "\n▎ Section One...!\n  ✓ did a thing\n    a note\n  ~ would do\n  → careful\n\n▎ DEMO...FAILED!\n   1 failure(s), 1 warning(s) · <t>\n",
    err: "  ✗ broke\n",
    code: 1,
  },
  "bands verbose": {
    out: "\n▎ Section One\n  ✓ did a thing\n  - already fine\n    a note\n  ~ would do\n  → careful\n\n▎ DEMO...FAILED!\n   1 failure(s), 1 warning(s) · <t>\n",
    err: "  ✗ broke\n",
    code: 1,
  },
  // Quiet category ignores the section header entirely and regroups under the stamped category.
  "category quiet": {
    out: "\n▎ DOTFILES...!\n  ✓ did a thing\n    a note\n  ~ would do\n  → careful\n\n▎ DEMO...FAILED!\n   1 failure(s), 1 warning(s) · <t>\n",
    err: "  ✗ broke\n",
    code: 1,
  },
  // Verbose category is the per-section firehose — identical to bands verbose by design.
  "category verbose": {
    out: "\n▎ Section One\n  ✓ did a thing\n  - already fine\n    a note\n  ~ would do\n  → careful\n\n▎ DEMO...FAILED!\n   1 failure(s), 1 warning(s) · <t>\n",
    err: "  ✗ broke\n",
    code: 1,
  },
};

const CASES: Array<[string, ReportSurface, boolean]> = [
  ["bands quiet", "bands", false],
  ["bands verbose", "bands", true],
  ["category quiet", "category", false],
  ["category verbose", "category", true],
];

for (const [name, surface, verbose] of CASES) {
  test(`reporter surface: ${name} is byte-identical`, () => {
    expect(run(surface, verbose)).toEqual(GOLDEN[name] as { out: string; err: string; code: number });
  });
}

test("fail goes to stderr on every surface, everything else to stdout", () => {
  for (const [name, surface, verbose] of CASES) {
    const { out, err } = run(surface, verbose);
    expect(err, name).toContain("broke");
    expect(out, name).not.toContain("broke");
    expect(out, name).toContain("did a thing");
  }
});

// `bands: !json` used to make the verdict unreachable under --json by construction. With the
// surface decoupled from the JSON flag it is only the explicit `!this.json` guard in finish()
// that keeps a band out of a machine-readable stream.
test("json emits exactly the envelope and never a verdict band", () => {
  const out = capture();
  const err = capture();
  const r = new Reporter({ out, err }, { color: false, json: true, surface: "category" });
  r.command = "demo";
  r.ok("did a thing");
  r.warn("careful");
  const code = r.finishJson(out, true);
  expect(code).toBe(2);
  expect(out.s.trimEnd().split("\n")).toHaveLength(1);
  expect(JSON.parse(out.s).records).toHaveLength(2);
  expect(err.s).toBe("");
});

test("json finish() draws no verdict band", () => {
  const out = capture();
  const err = capture();
  const r = new Reporter({ out, err }, { color: false, json: true, surface: "bands" });
  r.command = "demo";
  r.ok("did a thing");
  r.finish({ ok: "all clear" });
  expect(out.s).not.toContain("▎");
  expect(out.s).not.toContain("COMPLETE");
});

// `skip` is the one level quiet holds back. It must still reach `records`, on every surface —
// that is what makes `--json` a complete report rather than a filtered one.
test("skip is suppressed on the quiet human surfaces but always recorded", () => {
  for (const surface of ["bands", "category"] as const) {
    const out = capture();
    const err = capture();
    const r = new Reporter({ out, err }, { color: false, surface });
    r.command = "demo";
    r.header("Section One");
    r.skip("already fine");
    r.ok("did a thing");
    r.finish({ ok: "all clear" });
    expect(out.s, surface).not.toContain("already fine");
    expect(
      r.envelope().records.map((x) => x.level),
      surface,
    ).toContain("skip");
  }
});

// The golden snapshots above all run with `color: false`, so they never exercise paintHex's
// painting branch — which means they could not have caught a change in the escape it emits.
// paintHex now delegates to Bun.color instead of hand-parsing the hex with three parseInt
// slices, so this pins the actual bytes for every color boom can print.
//
// Note what this does NOT pin: "ansi-16m" vs plain "ansi" is invisible here, because both emit
// the same escape when the runtime resolves full color depth. The reason color.ts names
// "ansi-16m" is to keep the escape from depending on a capability probe at all, not because this
// test could tell them apart — swapping it does not fail this.
test("paintHex emits the same truecolor escape for every COSMIC color", () => {
  const handRolled = (hex: string): string => {
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    return `\x1b[38;2;${r};${g};${b}m`;
  };
  for (const [name, hex] of Object.entries(COSMIC)) {
    expect(paintHex(true, hex, "x"), name).toBe(`${handRolled(hex)}x\x1b[0m`);
  }
  // Disabled means untouched — NO_COLOR and pipes get plain text, no escapes at all.
  expect(paintHex(false, COSMIC.cyan, "x")).toBe("x");
});
