// Reporter: the engine's output surface + pass/fail tally. Mirrors the bash engine's
// _ok/_warn/_fail and drives the verify exit code (0 ok / 2 warn / 1 fail). In JSON
// mode it suppresses human output and only collects records (for `verify --json`).
//
// Two human presentations share this one tally + record stream:
//   • the classic surface (`==> Header`, indented ✓/→/✗ lines) — every non-reconcile command;
//   • the "cosmic bands" surface (bands mode) — every user-facing command, matching the site's
//     design: a permanent `▎` bar per section in a cycling brand color, a trailing status glyph
//     (a Kirby-krackle burst while working → ✓ done / ! attention), a grey setup band to open, and
//     a `COMMAND...COMPLETE!` / `...FAILED!` verdict band to close. The default is *dense*: each
//     section's marked band is followed by its detail lines (skips excepted). --verbose instead
//     streams live — showing the held-back skips and the raw subprocess chatter (brew/mise/git).
import { BAND_CYCLE, COSMIC, type ColorName, colorEnabled, paint, paintHex } from "./color.ts";

interface Stream {
  write(s: string): void;
}

// stdout may carry isTTY (a real terminal) — bands-mode quiet uses it to draw a live krackle line
// and rewrite it in place. Absent on the test/JSON fake streams, so those take the plain path.
type OutStream = Stream & { isTTY?: boolean };

export type ReportLevel = "ok" | "skip" | "warn" | "fail" | "note" | "plan" | "header";
export interface ReportRecord {
  readonly level: ReportLevel;
  readonly msg: string;
}

// Version of the `--json` report envelope. Bump when its shape changes so a script consuming
// `verify --json` / `doctor --json` / etc. can detect (and refuse) an unknown shape.
export const REPORT_SCHEMA_VERSION = 1;

export interface ReportEnvelope {
  readonly schemaVersion: number;
  readonly ok: boolean;
  readonly warnings: number;
  readonly failures: number;
  readonly records: readonly ReportRecord[];
}

// A band being built up: which section, its cycled color, the tally at open (to decide the
// final mark), a buffer of its lines (rendered at close in quiet), and whether its live krackle
// line is already on screen (interactive quiet only — so close overwrites it with \r).
interface Band {
  readonly label: string;
  readonly color: string;
  readonly failAt: number;
  readonly warnAt: number;
  readonly buf: ReportRecord[];
  krackleShown: boolean;
}

export class Reporter {
  warnings = 0;
  failures = 0;
  readonly records: ReportRecord[] = [];

  // The command name the verdict band echoes (`SOURCE...COMPLETE!`). Set by the reconcile
  // entry after construction; bands mode falls back to nothing (a bare `...COMPLETE!`) if unset.
  command?: string;

  // Quiet mode (the default) holds a section header back until a *shown* line lands under it,
  // so a section that produced only suppressed `skip` noise prints no header at all — the whole
  // point of quiet output being that a steady-state run says almost nothing. Verbose writes
  // headers eagerly and this stays undefined. (Classic surface only; bands mode uses `band`.)
  private pendingHeader?: string;

  // Bands-mode state: the section currently accumulating, and the color-cycle cursor.
  private band?: Band;
  private cycle = 0;

  constructor(
    private readonly out: Stream,
    private readonly err: Stream,
    private readonly color: boolean,
    private readonly json = false,
    // Verbose shows every line (the historical firehose: each ✓/skip/note). Quiet — the CLI
    // default — suppresses the `skip` no-ops (already-linked, unchanged, satisfied) and the
    // headers of sections that emit only those, leaving what changed + what needs attention.
    private readonly verbose = false,
    // Bands mode: the cosmic-bands presentation (reconcile only). Default false keeps every other
    // command on the classic `==> Header` surface, byte-for-byte unchanged.
    private readonly bands = false,
    // Interactive: stdout is a TTY, so bands-mode quiet can draw a live krackle line and rewrite
    // it in place (\r) on conclude. Non-interactive (piped/CI) prints only the resolved band.
    private readonly interactive = false,
  ) {}

  private c(name: ColorName, s: string): string {
    return paint(this.color, name, s);
  }
  private hx(hex: string, s: string): string {
    return paintHex(this.color, hex, s);
  }

  // Flush a header the classic quiet path is holding back — called by every *shown* line so its
  // section banner precedes it. A no-op in verbose (headers already wrote) and once flushed.
  private flushHeader(): void {
    if (this.pendingHeader !== undefined) {
      this.out.write(`\n${this.c("bold", `==> ${this.pendingHeader}`)}\n`);
      this.pendingHeader = undefined;
    }
  }

  // ---- bands-mode rendering ---------------------------------------------------------------

  // The grey opening band ("PREPARING FOR THE WORLD THAT'S COMING…"). Bands mode only; a no-op
  // elsewhere so the reconcile entry can call it unconditionally.
  setup(msg: string): void {
    if (this.json || !this.bands) return;
    this.out.write(`\n${this.hx(COSMIC.dim, `▎ ${msg}`)}\n`);
  }

  // Render one buffered sub-line under a band (indent + colored glyph). Fail goes to stderr to
  // match the classic surface; everything else to stdout.
  private writeSub(rec: ReportRecord): void {
    switch (rec.level) {
      case "ok":
        this.out.write(`  ${this.hx(COSMIC.ok, "✓")} ${rec.msg}\n`);
        return;
      case "skip":
        this.out.write(`  ${this.hx(COSMIC.dim, `- ${rec.msg}`)}\n`);
        return;
      case "note":
        this.out.write(`    ${this.hx(COSMIC.dim, rec.msg)}\n`);
        return;
      case "plan":
        this.out.write(`  ${this.hx(COSMIC.cyan, `~ ${rec.msg}`)}\n`);
        return;
      case "warn":
        this.out.write(`  ${this.hx(COSMIC.warn, "→")} ${rec.msg}\n`);
        return;
      case "fail":
        this.err.write(`  ${this.hx(COSMIC.crit, "✗")} ${rec.msg}\n`);
        return;
    }
  }

  // Route a leveled line in bands mode: --verbose prints it live under the (already-printed) band;
  // the dense default buffers it for the band's close; with no open band, only attention lines
  // (warn/fail/plan) print (a stray ok/note without a section has nowhere to nest).
  private bandEmit(rec: ReportRecord): void {
    if (this.verbose) {
      this.writeSub(rec);
      return;
    }
    if (this.band) {
      this.band.buf.push(rec);
      return;
    }
    if (rec.level === "warn" || rec.level === "fail" || rec.level === "plan") this.writeSub(rec);
  }

  // Resolve the open band: pick its mark from whether the tally moved while it was active, draw
  // the band line (overwriting the live krackle in place when interactive), then flush the lines
  // worth showing — attention (warn/fail) and dry-run plans always; the rest only in verbose.
  private closeBand(): void {
    const b = this.band;
    if (!b) return;
    this.band = undefined;
    if (this.verbose) return; // --verbose streams the header + lines live; no trailing mark

    const failed = this.failures > b.failAt;
    const warned = this.warnings > b.warnAt;
    const mark = failed
      ? this.hx(COSMIC.crit, "!")
      : warned
        ? this.hx(COSMIC.warn, "!")
        : this.hx(COSMIC.ok, "✓");
    // `...` leads into the mark, echoing the verdict band's COMMAND...COMPLETE! motif.
    const line = `${this.hx(b.color, `▎ ${b.label}...`)}${mark}`;
    // Interactive drew `▎ LABEL...✸` already; \r + clear-to-EOL, then the resolved line in place.
    // Non-interactive prints it fresh with a leading blank, so section blocks are separated.
    if (b.krackleShown) this.out.write(`\r\x1b[K${line}\n`);
    else this.out.write(`\n${line}\n`);

    // Dense by default: flush the section's detail below its marked band. Skips are the one
    // exception — steady-state no-op noise, held back for --verbose (which streams instead).
    for (const rec of b.buf) if (rec.level !== "skip") this.writeSub(rec);
  }

  // Draw the closing verdict band and return the exit code, replacing finish()'s summary line in
  // bands mode. Reads the tally (never mutates it), so the 0/2/1 ladder matches the classic path.
  // `metaOverride` lets a command state its own outcome (upgrade: "v0.14.0 → v0.15.0") in place of
  // the auto count; ignored on a failure, where the count (and the ✗ lines above) tell the story.
  private verdict(hasWarnTier: boolean, metaOverride?: string): number {
    const f = this.failures;
    const w = this.warnings;
    const name = (this.command ?? "").toUpperCase();
    const failed = f > 0;
    const warned = hasWarnTier && w > 0;
    const color = failed ? COSMIC.crit : warned ? COSMIC.warn : COSMIC.ok;
    const verb = failed ? "FAILED" : "COMPLETE";
    const autoMeta = failed
      ? `${f} failure(s)${w > 0 ? `, ${w} warning(s)` : ""}`
      : w > 0
        ? `${w} warning(s)`
        : "all clear";
    const meta = !failed && metaOverride ? metaOverride : autoMeta;
    // A blank line sets the verdict band off from the last section block.
    this.out.write(`\n${this.hx(color, `▎ ${name}...${verb}!`)}  ${this.hx(COSMIC.dim, meta)}\n`);
    return failed ? 1 : warned ? 2 : 0;
  }

  // ---- public surface ---------------------------------------------------------------------

  // `eager` marks a run-level banner (e.g. the dry-run notice) that must print even with no
  // lines under it — quiet holds *section* headers back, but not these.
  header(s: string, eager = false): void {
    this.records.push({ level: "header", msg: s });
    if (this.json) return;
    if (this.bands) {
      // An eager banner isn't a section — draw it grey like the setup band and don't track it.
      if (eager) {
        this.out.write(`\n${this.hx(COSMIC.dim, `▎ ${s}`)}\n`);
        return;
      }
      this.closeBand(); // resolve the previous section before starting this one
      const color = BAND_CYCLE[this.cycle++ % BAND_CYCLE.length] ?? COSMIC.cyan;
      const band: Band = {
        label: s,
        color,
        failAt: this.failures,
        warnAt: this.warnings,
        buf: [],
        krackleShown: false,
      };
      this.band = band;
      if (this.verbose) {
        this.out.write(`\n${this.hx(color, `▎ ${s}`)}\n`);
      } else if (this.interactive) {
        // Live: the permanent bar + a krackle burst where the mark will land, on its own blank-
        // separated line. No trailing newline — close overwrites this line in place with \r.
        // Nothing prints between (detail buffers; subprocess output is silenced), so it stays put.
        this.out.write(`\n${this.hx(color, `▎ ${s}...`)}${this.hx(COSMIC.solar, "✸")}`);
        band.krackleShown = true;
      }
      return;
    }
    if (this.verbose) {
      this.out.write(`\n${this.c("bold", `==> ${s}`)}\n`);
      return;
    }
    // Quiet: stage this header. A following header with no shown line in between overwrites
    // (and thereby discards) it — the previous section was all-skips; `eager` flushes now.
    this.pendingHeader = s;
    if (eager) this.flushHeader();
  }
  ok(s: string): void {
    const rec: ReportRecord = { level: "ok", msg: s };
    this.records.push(rec);
    if (this.json) return;
    if (this.bands) {
      this.bandEmit(rec);
      return;
    }
    this.flushHeader();
    this.out.write(`  ${this.c("green", "✓")} ${s}\n`);
  }
  // A no-op: already in the desired state, nothing done. Pure noise on a steady-state run, so
  // quiet suppresses it (records still capture it for `--json`); verbose shows the dim line.
  skip(s: string): void {
    const rec: ReportRecord = { level: "skip", msg: s };
    this.records.push(rec);
    if (this.json) return;
    if (this.bands) {
      this.bandEmit(rec);
      return;
    }
    if (!this.verbose) return;
    this.flushHeader();
    this.out.write(`  ${this.c("dim", `- ${s}`)}\n`);
  }
  note(s: string): void {
    const rec: ReportRecord = { level: "note", msg: s };
    this.records.push(rec);
    if (this.json) return;
    if (this.bands) {
      this.bandEmit(rec);
      return;
    }
    this.flushHeader();
    this.out.write(`    ${s}\n`);
  }
  plan(s: string): void {
    const rec: ReportRecord = { level: "plan", msg: s };
    this.records.push(rec);
    if (this.json) return;
    if (this.bands) {
      this.bandEmit(rec);
      return;
    }
    this.flushHeader();
    this.out.write(`  ${this.c("cyan", `~ ${s}`)}\n`);
  }
  warn(s: string): void {
    this.warnings++;
    const rec: ReportRecord = { level: "warn", msg: s };
    this.records.push(rec);
    if (this.json) return;
    if (this.bands) {
      this.bandEmit(rec);
      return;
    }
    this.flushHeader();
    this.out.write(`  ${this.c("yellow", "→")} ${s}\n`);
  }
  fail(s: string): void {
    this.failures++;
    const rec: ReportRecord = { level: "fail", msg: s };
    this.records.push(rec);
    if (this.json) return;
    if (this.bands) {
      this.bandEmit(rec);
      return;
    }
    this.flushHeader();
    this.err.write(`  ${this.c("red", "✗")} ${s}\n`);
  }

  // The one place the 0/2/1 exit contract lives: write a trailing blank line + a summary
  // line at the right severity, and return the exit code — so reconcile/doctor/validate/
  // rollback stop each re-implementing the same failures→1 / warnings→2 / ok→0 ladder with
  // subtly different wording. Callers pass only the varying messages. Omitting `warn` means
  // "no warning tier" (warnings don't change the exit code) — the mutating/validate case.
  // Exit code is decided from the counts *before* the summary line is emitted, so the
  // summary's own fail()/warn() call can't perturb it.
  finish(msgs: {
    ok: string;
    fail?: (failures: number, warnings: number) => string;
    warn?: (warnings: number) => string;
    // Bands mode only: the verdict band's outcome text on success (e.g. "v0.14.0 → v0.15.0"),
    // in place of the auto-generated count. Ignored on the classic surface and on failure.
    meta?: string;
  }): number {
    const f = this.failures;
    const w = this.warnings;
    // Discard a section header still held back from the last (all-skips) section, so quiet
    // mode doesn't print a stray banner right before the summary. The summary itself is an
    // `ok`/`warn`/`fail` line and is always shown.
    this.pendingHeader = undefined;
    // Bands mode: resolve the last section band, then draw the verdict band in place of the
    // classic summary. `msgs.warn` presence marks a warning-tier command (verify), same as below.
    if (this.bands) {
      this.closeBand();
      return this.verdict(msgs.warn !== undefined, msgs.meta);
    }
    this.out.write("\n");
    if (f > 0) {
      this.fail(msgs.fail ? msgs.fail(f, w) : `${f} failure(s)`);
      return 1;
    }
    if (msgs.warn && w > 0) {
      this.warn(msgs.warn(w));
      return 2;
    }
    this.ok(msgs.ok);
    return 0;
  }

  // The one `--json` envelope shape, shared by every scriptable command so their reports
  // can't drift. Built from the tally + collected records.
  envelope(schemaVersion = REPORT_SCHEMA_VERSION): ReportEnvelope {
    return {
      schemaVersion,
      ok: this.failures === 0,
      warnings: this.warnings,
      failures: this.failures,
      records: this.records,
    };
  }

  // The json-mode twin of finish(): write the envelope and return the exit code. failures→1;
  // warnings→2 only for a command with a warning tier (verify/doctor), else 0 — the same
  // 0/2/1 ladder finish() applies to human output, so the two modes agree on exit codes.
  finishJson(out: Stream, hasWarnTier: boolean, schemaVersion = REPORT_SCHEMA_VERSION): number {
    out.write(`${JSON.stringify(this.envelope(schemaVersion))}\n`);
    return this.failures > 0 ? 1 : hasWarnTier && this.warnings > 0 ? 2 : 0;
  }
}

// Build a bands-mode Reporter for a command — the cosmic output form (site's design): a grey
// setup band, marked `▎` section bands with their detail below, and a `COMMAND...COMPLETE!` /
// `...FAILED!` verdict from finish(). Interactive (TTY + color, non-JSON) enables the live in-place
// krackle. `verbose` defaults false — the dense-by-default form; a command that streams raw output
// with no section band to nest under (diff/push stream git verbatim) passes verbose:true so its
// lines still show. Under --json, bands turn off and the classic envelope (finishJson) is used.
export function bandsReporter(
  proc: { stdout: OutStream; stderr: Stream },
  env: Record<string, string | undefined>,
  command: string,
  opts?: { json?: boolean; verbose?: boolean; setup?: string },
): Reporter {
  const json = opts?.json ?? false;
  const color = colorEnabled(env);
  const interactive = !json && color && Boolean(proc.stdout.isTTY);
  const r = new Reporter(proc.stdout, proc.stderr, color, json, opts?.verbose ?? false, !json, interactive);
  r.command = command;
  if (opts?.setup) r.setup(opts.setup);
  return r;
}
