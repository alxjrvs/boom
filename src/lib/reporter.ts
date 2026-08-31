// Reporter: the engine's output surface + pass/fail tally. Mirrors the bash engine's
// _ok/_warn/_fail and drives the verify exit code (0 ok / 2 warn / 1 fail). In JSON
// mode it suppresses human output and only collects records (for `verify --json`).
//
// Two human presentations share this one tally + record stream — `ReportSurface`. (A third,
// `classic` — `==> Header` with indented ✓/→/✗ lines — was the pre-bands surface. It became
// unreachable once every construction went through `bandsReporter`, whose `surface` option only
// ever offers bands or category, and was removed rather than left as a mode nothing can select.)
//   • `bands` — the cosmic surface matching the site's design: a permanent `▎` bar per section in
//     a cycling brand color, a trailing status glyph (a Kirby-krackle burst while working → ✓ done
//     / ! attention), a grey setup band to open, and a `COMMAND...COMPLETE!` / `...FAILED!`
//     verdict band to close. The default is *dense*: each section's marked band is followed by its
//     detail lines (skips excepted);
//   • `category` — reconcile's default: buffer every line and group it at finish into
//     distinct-category bands (DOTFILES/PACKAGES/…) instead of one band per boomfile section,
//     which on a real machine is a wall of `▎ Thing ...✓`.
// --verbose streams live instead — showing the held-back skips and the raw subprocess chatter
// (brew/mise/git) — and collapses `category` onto `bands`, which is why they share every branch
// below except the quiet ones.
import { BAND_CYCLE, COSMIC, colorEnabled, paintHex } from "./color.ts";

interface Stream {
  write(s: string): void;
}

// stdout may carry isTTY (a real terminal) — bands-mode quiet uses it to draw a live krackle line
// and rewrite it in place. Absent on the test/JSON fake streams, so those take the plain path.
type OutStream = Stream & { isTTY?: boolean };

type ReportLevel = "ok" | "skip" | "warn" | "fail" | "note" | "plan" | "header";
// Every level except `header`, which is not a leveled line: it opens a section (a band, a
// `==> ` banner) rather than reporting an outcome, so it has no glyph, no stream and no tally.
type EmitLevel = Exclude<ReportLevel, "header">;

// One value instead of the two booleans (`bands`, `categoryMode`) it replaces. They were never
// independent — `categoryMode` was only ever passed alongside `bands`, and "category but not
// bands" had no branch — so the pair could express a state the renderer did not implement.
export type ReportSurface = "bands" | "category";

interface ReportRecord {
  readonly level: ReportLevel;
  readonly msg: string;
  // The reconcile category this line belongs to (DOTFILES/PACKAGES/…), stamped from
  // Reporter.category as resources emit. Drives the dense default's category-grouped bands (and
  // lets a `--json` consumer group the same way). Absent unless the run sets a category.
  readonly category?: string;
}

// The buckets the `category` surface groups under, in render order; the strings match what
// registry.ts / reconcile.ts stamp onto `Reporter.category`. A category with no *shown* line
// (only held-back skips) draws nothing, so a steady-state run collapses to setup + verdict.
const RECONCILE_CATEGORY_ORDER = [
  "CONFIG",
  "DOTFILES",
  "SECRETS",
  "DIRECTORIES",
  "PACKAGES",
  "MACOS",
  "SERVICES",
  "COMMANDS",
  "CHECKS",
  "HOOKS",
  "SELF-WIRING",
  "ORPHANS",
] as const;

// Everything that distinguishes one leveled line from another, in one place. This used to be
// spelled out twelve times — once per level in `writeSub`'s switch, once per level in the six
// public methods — which is how `note` came to be dim on the bands surface and plain on the
// classic one. `shape` is what keeps this a table rather than a formatter: the tallying levels
// color only their glyph (`✓ msg`), `skip`/`plan` color glyph *and* message, `note` is a bare
// 4-space-indented line. Preserved exactly, and asserted byte-for-byte by
// test/reporter-surface.test.ts — this is a collapse, not a redesign.
interface LevelStyle {
  readonly glyph: string;
  readonly hex: string;
  readonly shape: "glyph" | "prefix" | "note";
  readonly stream: "out" | "err";
  readonly verboseOnly?: boolean; // quiet holds it back — `skip` is the only one
  readonly tally?: "warn" | "fail"; // which counter it moves, hence which exit code it can force
}

const LEVEL_STYLE: Record<EmitLevel, LevelStyle> = {
  ok: { glyph: "✓", hex: COSMIC.ok, shape: "glyph", stream: "out" },
  skip: { glyph: "- ", hex: COSMIC.dim, shape: "prefix", stream: "out", verboseOnly: true },
  note: { glyph: "", hex: COSMIC.dim, shape: "note", stream: "out" },
  plan: { glyph: "~ ", hex: COSMIC.cyan, shape: "prefix", stream: "out" },
  warn: { glyph: "→", hex: COSMIC.warn, shape: "glyph", stream: "out", tally: "warn" },
  fail: { glyph: "✗", hex: COSMIC.crit, shape: "glyph", stream: "err", tally: "fail" },
};

// The active-work spinner's frames — a pulsing Kirby-krackle burst (grows and shrinks, spins),
// on-brand where a plain dot-spinner would read as generic. Redrawn in place while a slow tool
// (brew/mise/git/a `run` step) works, then erased when it resolves to the band's ✓/! mark.
const SPIN_FRAMES = ["✶", "✷", "✸", "✹", "✺", "✹", "✸", "✷"] as const;

// Elapsed-time suffix on the verdict's meta line: sub-second in ms, else one-decimal seconds.
// Whole-command wall time, measured from Reporter construction.
function fmtElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Version of the `--json` report envelope. Bump when its shape changes so a script consuming
// `verify --json` / `doctor --json` / etc. can detect (and refuse) an unknown shape. v2 added
// the per-record `category` field.
export const REPORT_SCHEMA_VERSION = 2;

interface ReportEnvelope {
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

  // The category the next emitted line belongs to (category mode only). The reconcile loop and
  // registry set this as they move through the run's phases; every record stamps its current
  // value, and finish() groups by it. Undefined until a run sets it.
  category?: string;

  // Bands-mode state: the section currently accumulating, and the color-cycle cursor.
  private band?: Band;
  private cycle = 0;
  // Active-work spinner: the interval redrawing the krackle while an awaited tool runs. Live only
  // between spin() start and stop; the spun line is erased on stop, so it never persists.
  private spinTimer?: ReturnType<typeof setInterval>;
  // Wall-clock start, for the verdict's elapsed suffix — every command's Reporter times itself.
  private readonly startedAt = performance.now();
  // Whether any section band or detail line has been drawn since the setup band. Gates the blank
  // line before the verdict: with no intermediate content (e.g. `upgrade` already-latest), the
  // verdict hugs the setup band instead of floating a blank line between them.
  private bandsDrawn = false;

  private readonly out: OutStream;
  private readonly err: Stream;
  private readonly color: boolean;
  private readonly json: boolean;
  // Verbose shows every line (the historical firehose: each ✓/skip/note). Quiet — the CLI
  // default — suppresses the `skip` no-ops (already-linked, unchanged, satisfied) and the
  // headers of sections that emit only those, leaving what changed + what needs attention.
  private readonly verbose: boolean;
  private readonly surface: ReportSurface; // see the header comment
  // stdout is a TTY, so a quiet band can draw a live krackle line and rewrite it in place (\r) on
  // conclude. Non-interactive (piped/CI) prints only the resolved band.
  private readonly interactive: boolean;

  // Named options rather than eight positionals (five of them booleans), where a construction
  // read `(out, err, true, false, false, true, true, false)` and an off-by-one silently changed
  // every line the command printed.
  constructor(
    streams: { out: OutStream; err: Stream },
    opts: {
      color: boolean;
      json?: boolean;
      verbose?: boolean;
      surface?: ReportSurface;
      interactive?: boolean;
    },
  ) {
    this.out = streams.out;
    this.err = streams.err;
    this.color = opts.color;
    this.json = opts.json ?? false;
    this.verbose = opts.verbose ?? false;
    this.surface = opts.surface ?? "bands";
    this.interactive = opts.interactive ?? false;
  }

  private hx(hex: string, s: string): string {
    return paintHex(this.color, hex, s);
  }

  // ---- band rendering (the bands + category surfaces) ---------------------------------------

  // The grey opening band ("PREPARING FOR THE WORLD THAT'S COMING…"). Bands mode only; a no-op
  // elsewhere so the reconcile entry can call it unconditionally.
  setup(msg: string): void {
    if (this.json) return;
    this.out.write(`\n${this.hx(COSMIC.dim, `▎ ${msg}`)}\n`);
  }

  // Run an awaited slow operation under an active-work indicator, so a network/tool wait never runs
  // silently. Three presentations of the same beat, by mode:
  //   • dense + interactive TTY → an in-place krackle line (`  ✸ <label>…`) that pulses while `work`
  //     runs and is erased on resolve (transient — never in the final output);
  //   • verbose (streaming commands: push/reset/diff, or --verbose) → a persistent `  ◇ <label>…`
  //     line, since verbose has no buffered band to hide it under and its own tool output follows;
  //   • JSON, or dense + non-interactive (piped/CI) → suppressed, so captured output stays clean.
  // Always awaits `work` and always clears the animation timer, even if `work` throws.
  //
  // `mayPrompt` is the fourth case, and it exists because the animation is destructive: the frame
  // is redrawn with `\r\x1b[K` 11×/second, which erases anything the *child* wrote to that line.
  // A tool that shells out to `sudo` writes its password prompt straight to /dev/tty — verified:
  // "Password:" reaches the terminal even with the child's stdout ignored and stderr piped, so
  // boom's quiet stdio never hid it, the spinner did. The prompt was printed and then wiped, and
  // the run read as a hang. So when a step can escalate, boom gives up the line: a persistent
  // label (the verbose presentation) instead of an animated one, and the prompt survives to be
  // answered. Cosmetics lose to being able to type your password.
  async spin<T>(label: string, work: () => Promise<T>, opts?: { mayPrompt?: boolean }): Promise<T> {
    if (this.json) return work();
    if (this.verbose) {
      this.out.write(`  ${this.hx(COSMIC.solar, "◇")} ${this.hx(COSMIC.dim, `${label}…`)}\n`);
      return work();
    }
    if (!this.interactive) return work();
    if (opts?.mayPrompt) {
      // Say so, rather than letting a bare "Password:" appear from nowhere: the child's own
      // "==> Upgrading cask …" context is silenced under the band, so the label is all there is.
      const hint = this.hx(COSMIC.dim, "(may ask for your password)");
      this.out.write(`  ${this.hx(COSMIC.solar, "◇")} ${this.hx(COSMIC.dim, `${label}…`)} ${hint}\n`);
      return work();
    }
    let i = 0;
    const draw = (): void => {
      const frame = SPIN_FRAMES[i++ % SPIN_FRAMES.length] ?? "✸";
      this.out.write(`\r\x1b[K  ${this.hx(COSMIC.solar, frame)} ${this.hx(COSMIC.dim, `${label}…`)}`);
    };
    draw();
    this.spinTimer = setInterval(draw, 90);
    try {
      return await work();
    } finally {
      if (this.spinTimer) {
        clearInterval(this.spinTimer);
        this.spinTimer = undefined;
      }
      this.out.write("\r\x1b[K"); // erase the spinner line; the resolved band/detail prints next
    }
  }

  // A live progress line, written straight out *now* — deliberately not a ReportRecord and not
  // band-buffered. Every other sub-line (note/ok/skip) is collected and flushed when its band
  // closes, which is the wrong shape for narrating a step that's still running: the whole point is
  // to name what a tool is doing at the moment it stops to ask for a password, and a buffered line
  // would print after the prompt it was supposed to explain. Only meaningful under the `mayPrompt`
  // presentation (no animation to fight with); suppressed for JSON so an envelope stays clean, and
  // in verbose, where the tool's own unfiltered output is already streaming past.
  live(s: string): void {
    if (this.json || this.verbose) return;
    this.out.write(`    ${this.hx(COSMIC.dim, `▸ ${s}`)}\n`);
  }

  // Render one leveled line from LEVEL_STYLE. Both remaining surfaces tint from the same `hex`,
  // so this no longer branches on which one asked: the `band` parameter and the ANSI-named
  // `color` it selected went with the classic surface.
  private line(level: EmitLevel, msg: string): string {
    const st = LEVEL_STYLE[level];
    const tint = (s: string): string => this.hx(st.hex, s);
    if (st.shape === "glyph") return `  ${tint(st.glyph)} ${msg}\n`;
    if (st.shape === "prefix") return `  ${tint(`${st.glyph}${msg}`)}\n`;
    return `    ${tint(msg)}\n`;
  }

  // Write one buffered sub-line under a band. Fail goes to stderr.
  private writeSub(rec: ReportRecord): void {
    this.bandsDrawn = true;
    if (rec.level === "header") return; // headers open bands; they are never band content
    const st = LEVEL_STYLE[rec.level];
    (st.stream === "err" ? this.err : this.out).write(this.line(rec.level, rec.msg));
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

    // A band whose only lines are held-back skips has no permanent text to sit under its
    // headline — so it collapses entirely (no headline, no surrounding blank), matching the
    // dense category surface and the "no empty headline" output rule. An interactive run
    // already drew a live krackle line; erase it so nothing persists in its place.
    const shown = b.buf.filter((rec) => rec.level !== "skip");
    if (shown.length === 0) {
      if (b.krackleShown) this.out.write("\r\x1b[K");
      return;
    }
    this.bandsDrawn = true;

    const mark = this.mark(this.failures > b.failAt, this.warnings > b.warnAt);
    // `...` leads into the mark, echoing the verdict band's COMMAND...COMPLETE! motif.
    const line = `${this.hx(b.color, `▎ ${b.label}...`)}${mark}`;
    // Interactive drew `▎ LABEL...✸` already; \r + clear-to-EOL, then the resolved line in place.
    // Non-interactive prints it fresh with a leading blank, so section blocks are separated.
    if (b.krackleShown) this.out.write(`\r\x1b[K${line}\n`);
    else this.out.write(`\n${line}\n`);

    // Dense by default: flush the section's detail below its marked band. Skips are the one
    // exception — steady-state no-op noise, held back for --verbose (which streams instead).
    for (const rec of shown) this.writeSub(rec);
  }

  // The band/category mark: ! at either severity (crit vs warn colored), ✓ otherwise. Shared by
  // the per-section band and the category summary, which computed it identically from different
  // inputs (tally delta vs the category's own records).
  private mark(failed: boolean, warned: boolean): string {
    return failed ? this.hx(COSMIC.crit, "!") : warned ? this.hx(COSMIC.warn, "!") : this.hx(COSMIC.ok, "✓");
  }

  // The two-line verdict block both surfaces close on: the COMMAND...COMPLETE! /
  // …FAILED! band, then its outcome as a dim sub-line beneath. Reads the tally (never mutates
  // it), so the 0/2/1 ladder matches finish()'s own. The elapsed suffix is appended here, once
  // — before this collapse `verdict` appended it at the write and `categoryVerdict` folded it
  // into `meta`, two spellings of one format that could drift apart.
  private drawVerdict(hasWarnTier: boolean, meta: string): number {
    const name = (this.command ?? "").toUpperCase();
    const failed = this.failures > 0;
    const warned = hasWarnTier && this.warnings > 0;
    const color = failed ? COSMIC.crit : warned ? COSMIC.warn : COSMIC.ok;
    const verb = failed ? "FAILED" : "COMPLETE";
    // A blank line sets the verdict off from the section blocks — but only when some were drawn.
    // With no intermediate content (e.g. `upgrade` already-latest) it hugs the setup band instead.
    const lead = this.bandsDrawn ? "\n" : "";
    this.out.write(`${lead}${this.hx(color, `▎ ${name}...${verb}!`)}\n`);
    this.out.write(
      `   ${this.hx(COSMIC.dim, `${meta} · ${fmtElapsed(performance.now() - this.startedAt)}`)}\n`,
    );
    return failed ? 1 : warned ? 2 : 0;
  }

  // The bands-surface verdict. `metaOverride` lets a command state its own outcome (upgrade:
  // "v0.14.0 → v0.15.0") in place of the auto count; ignored on a failure, where the count (and
  // the ✗ lines above) tell the story.
  private verdict(hasWarnTier: boolean, metaOverride?: string): number {
    const f = this.failures;
    const w = this.warnings;
    const failed = f > 0;
    const autoMeta = failed
      ? `${f} failure(s)${w > 0 ? `, ${w} warning(s)` : ""}`
      : w > 0
        ? `${w} warning(s)`
        : "all clear";
    return this.drawVerdict(hasWarnTier, !failed && metaOverride ? metaOverride : autoMeta);
  }

  // ---- category-surface rendering -----------------------------------------------------------

  // Group the run's *shown* records (skips held back) by category and draw one marked band per
  // non-empty category, in the canonical order, with that category's action lines below it —
  // every dotfile action across every section folds under one DOTFILES band, so a clean run
  // draws nothing. Returns the count the verdict's "N categories touched" reports.
  private renderCategorySummary(): number {
    const byCat = new Map<string, ReportRecord[]>();
    for (const rec of this.records) {
      if (rec.level === "header" || rec.level === "skip") continue;
      const cat = rec.category ?? "BOOM";
      const list = byCat.get(cat);
      if (list) list.push(rec);
      else byCat.set(cat, [rec]);
    }
    // Canonical categories first; then any unrecognized one (defensive — a mis-stamped line
    // must never be silently dropped) in first-seen order.
    const known = RECONCILE_CATEGORY_ORDER as readonly string[];
    const order = [...known, ...[...byCat.keys()].filter((k) => !known.includes(k))];
    let touched = 0;
    for (const cat of order) {
      const recs = byCat.get(cat);
      if (!recs || recs.length === 0) continue;
      touched++;
      this.bandsDrawn = true;
      const mark = this.mark(
        recs.some((r) => r.level === "fail"),
        recs.some((r) => r.level === "warn"),
      );
      const color = BAND_CYCLE[this.cycle++ % BAND_CYCLE.length] ?? COSMIC.cyan;
      this.out.write(`\n${this.hx(color, `▎ ${cat}...`)}${mark}\n`);
      for (const rec of recs) this.writeSub(rec);
    }
    return touched;
  }

  // The category-surface verdict: same band, but its outcome names the count of categories
  // touched (or the drift/checks tier) instead of the bands surface's per-section tally.
  private categoryVerdict(hasWarnTier: boolean, touched: number): number {
    const f = this.failures;
    const w = this.warnings;
    const failed = f > 0;
    const warned = hasWarnTier && w > 0;
    let meta: string;
    if (failed) meta = `${f} failure(s)${w > 0 ? `, ${w} warning(s)` : ""}`;
    else if (warned) meta = `${w} warning(s)`;
    else if (hasWarnTier) meta = "all checks passed";
    else
      meta =
        touched === 0
          ? "nothing to change"
          : `${touched} categor${touched === 1 ? "y" : "ies"} touched · all clear`;
    return this.drawVerdict(hasWarnTier, meta);
  }

  // ---- public surface ---------------------------------------------------------------------

  // `eager` marks a run-level banner (e.g. the dry-run notice) that must print even with no
  // lines under it — quiet holds *section* headers back, but not these.
  header(s: string, eager = false): void {
    this.records.push({ level: "header", msg: s, category: this.category });
    if (this.json) return;
    if (this.surface === "category" && !this.verbose) {
      // Category mode buffers everything and draws grouped bands at finish, so a section header is
      // not a persistent line here. An eager banner (the dry-run notice) still prints — as grey
      // sub-text of the setup band above it (indented, no bar), matching the verdict's meta line.
      // Section progress itself needs no live line: fast sections flash by, and the slow work
      // (brew/mise/git) surfaces its own active-work spinner via report.spin().
      if (eager) {
        this.out.write(`   ${this.hx(COSMIC.dim, s)}\n`);
        this.bandsDrawn = true;
      }
      return;
    }
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
      this.bandsDrawn = true;
      this.out.write(`\n${this.hx(color, `▎ ${s}`)}\n`);
    } else if (this.interactive) {
      // Live: the permanent bar + a krackle burst where the mark will land, on its own blank-
      // separated line. No trailing newline — close overwrites this line in place with \r.
      // Nothing prints between (detail buffers; subprocess output is silenced), so it stays put.
      this.out.write(`\n${this.hx(color, `▎ ${s}...`)}${this.hx(COSMIC.solar, "✸")}`);
      band.krackleShown = true;
    }
  }

  // The one path every leveled line takes, in place of six copies of the same six-step preamble.
  // Order matters and is load-bearing: the record is collected *before* any suppression, so
  // `--json` and `envelope()` see every line regardless of surface or verbosity.
  private emit(level: EmitLevel, msg: string): void {
    const st = LEVEL_STYLE[level];
    if (st.tally === "warn") this.warnings++;
    else if (st.tally === "fail") this.failures++;
    const rec: ReportRecord = { level, msg, category: this.category };
    this.records.push(rec);
    if (this.json) return;
    if (this.surface === "category" && !this.verbose) return; // buffered → grouped at finish
    if (st.verboseOnly && !this.verbose) return;
    this.bandEmit(rec);
  }

  ok(s: string): void {
    this.emit("ok", s);
  }
  // A no-op: already in the desired state, nothing done. Pure noise on a steady-state run, so
  // quiet suppresses it (records still capture it for `--json`); verbose shows the dim line.
  // The lone `verboseOnly` level — every other one prints even when quiet.
  skip(s: string): void {
    this.emit("skip", s);
  }
  note(s: string): void {
    this.emit("note", s);
  }
  plan(s: string): void {
    this.emit("plan", s);
  }
  warn(s: string): void {
    this.emit("warn", s);
  }
  fail(s: string): void {
    this.emit("fail", s);
  }

  // The one place the 0/2/1 exit contract lives: write a trailing blank line + a summary
  // line at the right severity, and return the exit code — so reconcile/doctor/validate
  // stop each re-implementing the same failures→1 / warnings→2 / ok→0 ladder with
  // subtly different wording. Callers pass only the varying messages. Omitting `warn` means
  // "no warning tier" (warnings don't change the exit code) — the mutating/validate case.
  // Exit code is decided from the counts *before* the summary line is emitted, so the
  // summary's own fail()/warn() call can't perturb it.
  finish(msgs: {
    ok: string;
    fail?: (failures: number, warnings: number) => string;
    warn?: (warnings: number) => string;
    // Bands mode only: the verdict band's outcome text on success (e.g. "v0.14.0 → v0.15.0"),
    // in place of the auto-generated count. Ignored on failure.
    meta?: string;
  }): number {
    const f = this.failures;
    const w = this.warnings;
    // Category mode (dense reconcile default): draw the grouped category bands from the buffered
    // records, then the two-line verdict block.
    if (this.surface === "category" && !this.verbose && !this.json) {
      const touched = this.renderCategorySummary();
      return this.categoryVerdict(msgs.warn !== undefined, touched);
    }
    // Bands mode: resolve the last section band, then draw the verdict band. `msgs.warn` presence
    // marks a warning-tier command (verify), same as below. The `!json` is what `bands: !json`
    // used to buy by construction: with the surface no longer derived from the JSON flag, a
    // `--json` run would otherwise draw a verdict band into stdout ahead of the envelope.
    if (!this.json) {
      this.closeBand();
      return this.verdict(msgs.warn !== undefined, msgs.meta);
    }
    // Reached only under `--json`, and only defensively: every json-capable command branches to
    // finishJson() first (module.ts, reconcile.ts), so nothing takes this path today. It stays
    // because it is what makes finish() total — it computes the same 0/2/1 ladder the band
    // verdicts do, so the two modes cannot disagree about an exit code. Its ok/warn/fail calls
    // print nothing under json: emit() returns at the json guard before any surface renders.
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
// lines still show. Under --json, bands turn off and the structured envelope (finishJson) is used.
// `surface` picks between one band per section (the default) and reconcile's dense
// distinct-category grouping. Under --json every surface renders nothing anyway (each emitter
// returns at the json guard), so it is passed through unconditionally rather than derived.
export function bandsReporter(
  proc: { stdout: OutStream; stderr: Stream },
  env: Record<string, string | undefined>,
  command: string,
  opts?: { json?: boolean; verbose?: boolean; setup?: string; surface?: "bands" | "category" },
): Reporter {
  const json = opts?.json ?? false;
  const color = colorEnabled(env);
  const interactive = !json && color && Boolean(proc.stdout.isTTY);
  const r = new Reporter(
    { out: proc.stdout, err: proc.stderr },
    { color, json, verbose: opts?.verbose ?? false, surface: opts?.surface ?? "bands", interactive },
  );
  r.command = command;
  if (opts?.setup) r.setup(opts.setup);
  return r;
}
