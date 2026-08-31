// The `check` resource: an assertion that folds into `boom verify`'s exit code and `--json`
// report instead of being scraped from a shell step's stdout. Three kinds, sharing one
// `message`/`repair`/`missing_file` contract:
//
//   present/absent  regexes over a file's TEXT — the declarative form of the escaping-heavy
//                   `grep`-in-a-`run` guardrail
//   json            assertions over a file's PARSED structure, because a regex over JSON text
//                   means writing `'"model"\s*:\s*"[^"]*fable'` and hoping the formatting never
//                   changes, and cannot express array membership at all
//   cmd             a command's exit status and output, because the `run`-with-`unless` shape
//                   reports through a shell exit code rather than the drift report
//
// The last two exist because they are what consumers were hand-rolling `run` steps for: in
// boom's own reference consumer, most verify-only `run` steps were a `jq` walk or a
// "does this command still succeed" probe.
//
// On `verify` a check reports. On `sync`, a check with a `repair` command *converges*: when
// the assertion currently fails, the command runs to make it so — so `check` is no longer the
// one resource whose drift `boom source` can detect but not repair. Without `repair`, sync is
// a no-op (there is nothing to make so). `uninstall` is always a no-op.
import type { Check } from "../../config/schema.ts";
import { displayPath, expandTilde, pathExists } from "../../lib/fs.ts";
import { captureShell, runShell } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

// Compile a pattern, or return the error text so a bad regex fails the check legibly instead
// of throwing out of the section loop.
function compile(pattern: string): { re: RegExp } | { err: string } {
  try {
    return { re: new RegExp(pattern) };
  } catch (e) {
    return { err: `invalid regex /${pattern}/: ${(e as Error).message}` };
  }
}

// Resolve a dot path against a parsed document. A numeric segment indexes an array, so
// `hooks.PreToolUse.0.matcher` reads the way the document does. Returns the MISSING sentinel
// rather than undefined, because `null` and "absent" are different things in a config file and
// an assertion has to be able to tell them apart.
const MISSING = Symbol("missing");
function resolveKey(doc: unknown, key: string): unknown | typeof MISSING {
  let cur: unknown = doc;
  for (const seg of key.split(".")) {
    if (cur === null || cur === undefined) return MISSING;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return MISSING;
      const i = Number(seg);
      if (i >= cur.length) return MISSING;
      cur = cur[i];
      continue;
    }
    if (typeof cur !== "object") return MISSING;
    const rec = cur as Record<string, unknown>;
    if (!(seg in rec)) return MISSING;
    cur = rec[seg];
  }
  return cur;
}

// Structural equality, so `equals` can compare an object or array literal and not just a scalar.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    return (
      ka.length === kb.length &&
      ka.every((k, i) => k === kb[i]) &&
      ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}

function show(v: unknown): string {
  return v === MISSING ? "absent" : JSON.stringify(v);
}

// The assertion's current state: the file is missing, satisfied, or has concrete failures.
type Assessment = { missing: true } | { ok: true } | { failures: string[] };

// A `cmd` check: the command's exit status and combined output ARE the assertion. Read-only by
// contract — this runs during verify, so the declared command must not mutate anything; the
// mutating half is `repair`, which sync alone runs.
function assessCmd(entry: Check, ctx: ReconcileCtx): Assessment {
  const want = entry.exit ?? 0;
  const { code, stdout, stderr, timedOut } = captureShell(entry.cmd as string, ctx.env, { cwd: ctx.repo });
  const failures: string[] = [];
  if (timedOut) return { failures: [`\`${entry.cmd}\` timed out`] };
  if (code !== want) failures.push(`\`${entry.cmd}\` exited ${code}, expected ${want}`);
  // stderr included: a tool that reports a problem on stderr and still exits 0 is exactly the
  // shape a `stdout_absent` assertion is written to catch.
  const out = `${stdout}${stderr}`;
  for (const pattern of entry.stdout_present ?? []) {
    const c = compile(pattern);
    if ("err" in c) failures.push(c.err);
    else if (!c.re.test(out)) failures.push(`output missing required /${pattern}/`);
  }
  for (const pattern of entry.stdout_absent ?? []) {
    const c = compile(pattern);
    if ("err" in c) failures.push(c.err);
    else if (c.re.test(out)) failures.push(`output has forbidden /${pattern}/`);
  }
  return failures.length === 0 ? { ok: true } : { failures };
}

async function assess(entry: Check, ctx: ReconcileCtx): Promise<Assessment> {
  if (entry.cmd !== undefined) return assessCmd(entry, ctx);
  const file = expandTilde(entry.path as string, ctx.env);
  if (!(await pathExists(file))) return { missing: true };
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch (e) {
    return { failures: [`could not read — ${(e as Error).message}`] };
  }
  const failures: string[] = [];
  for (const pattern of entry.present ?? []) {
    const c = compile(pattern);
    if ("err" in c) failures.push(c.err);
    else if (!c.re.test(text)) failures.push(`missing required /${pattern}/`);
  }
  for (const pattern of entry.absent ?? []) {
    const c = compile(pattern);
    if ("err" in c) failures.push(c.err);
    else if (c.re.test(text)) failures.push(`forbidden /${pattern}/ present`);
  }
  // Structural assertions. Parsed once; a document that does not parse fails every one of them
  // with the parse error rather than each assertion separately.
  const asserts = entry.json ?? [];
  if (asserts.length > 0) {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      failures.push(`not valid JSON — ${(e as Error).message}`);
      return { failures };
    }
    for (const a of asserts) {
      const got = resolveKey(doc, a.key);
      if (a.absent === true) {
        if (got !== MISSING) failures.push(`${a.key} should be absent, is ${show(got)}`);
      } else if (a.present === true) {
        if (got === MISSING) failures.push(`${a.key} is absent`);
      } else if (a.present === false) {
        if (got !== MISSING) failures.push(`${a.key} should be absent, is ${show(got)}`);
      } else if (a.equals !== undefined) {
        if (got === MISSING) failures.push(`${a.key} is absent, expected ${show(a.equals)}`);
        else if (!deepEqual(got, a.equals))
          failures.push(`${a.key} is ${show(got)}, expected ${show(a.equals)}`);
      } else if (a.contains !== undefined) {
        if (got === MISSING) failures.push(`${a.key} is absent, expected it to contain ${show(a.contains)}`);
        else if (!Array.isArray(got)) failures.push(`${a.key} is ${show(got)}, not an array`);
        else if (!got.some((x) => deepEqual(x, a.contains)))
          failures.push(`${a.key} does not contain ${show(a.contains)}`);
      }
    }
  }
  return failures.length === 0 ? { ok: true } : { failures };
}

export async function reconcileCheck(entry: Check, ctx: ReconcileCtx): Promise<void> {
  if (ctx.verb === "uninstall") return;
  const { report } = ctx;
  // A `cmd` check has no path; it is named by the command it runs.
  const disp =
    entry.path === undefined ? `\`${entry.cmd}\`` : displayPath(expandTilde(entry.path, ctx.env), ctx.env);
  const label = entry.message ? `${entry.message} (${disp})` : disp;
  // Default `fail`: a guardrail that silently stops guarding when its file disappears is worse
  // than useless — the missing file is exactly the regression it exists to catch.
  const missing = entry.missing_file ?? "fail";
  const result = await assess(entry, ctx);

  if (ctx.verb === "verify") {
    if ("missing" in result) {
      if (missing === "fail") report.fail(`${label}: file missing`);
      else if (missing === "pass") report.skip(`${disp} absent (allowed)`);
      else report.skip(`${disp} absent — check skipped`);
    } else if ("ok" in result) {
      report.skip(entry.cmd === undefined ? `${disp} content ok` : `${disp} ok`);
    } else {
      report.fail(`${label}: ${result.failures.join("; ")}`);
    }
    return;
  }

  // sync: only a declared `repair` gives sync anything to do — otherwise a check is inert here.
  if (!entry.repair) return;

  // Already satisfied (content ok, or legitimately-absent under `pass`) → nothing to repair.
  if ("ok" in result || ("missing" in result && missing === "pass")) {
    report.skip(`${disp} ok — no repair needed`);
    return;
  }
  // A file absent under `skip` isn't drift to converge — leave it.
  if ("missing" in result && missing === "skip") {
    report.skip(`${disp} absent — check skipped`);
    return;
  }
  if (ctx.dryRun) {
    report.plan(`would repair ${disp}: ${entry.repair}`);
    return;
  }
  // A repair is arbitrary shell — journal it as a non-reversible side effect (mutating sync
  // only), like `run`/`hook`, so the run's record shows it cannot be undone. Run from
  // the repo so a repair command is cwd-independent, matching the `run` resource.
  await ctx.journal?.side("check-repair", entry.repair);
  const { code, timedOut } = runShell(entry.repair, ctx.env, { quietStdout: ctx.json, cwd: ctx.repo });
  if (timedOut || code !== 0) {
    report.fail(`${label}: repair failed (${entry.repair})`);
    return;
  }
  // Converged? Re-assess so a repair that ran but didn't actually satisfy the assertion is
  // surfaced, not assumed fixed.
  const after = await assess(entry, ctx);
  if ("ok" in after || ("missing" in after && missing === "pass")) report.ok(`${disp} repaired`);
  else report.warn(`${label}: repair ran but assertion still fails`);
}
