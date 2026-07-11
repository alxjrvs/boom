// Reporter: the engine's output surface + pass/fail tally. Mirrors the bash engine's
// _ok/_warn/_fail and drives the verify exit code (0 ok / 2 warn / 1 fail). In JSON
// mode it suppresses human output and only collects records (for `verify --json`).
import { type ColorName, paint } from "./color.ts";

interface Stream {
  write(s: string): void;
}

export type ReportLevel = "ok" | "skip" | "warn" | "fail" | "note" | "plan" | "header";
export interface ReportRecord {
  readonly level: ReportLevel;
  readonly msg: string;
}

export class Reporter {
  warnings = 0;
  failures = 0;
  readonly records: ReportRecord[] = [];

  constructor(
    private readonly out: Stream,
    private readonly err: Stream,
    private readonly color: boolean,
    private readonly json = false,
  ) {}

  private c(name: ColorName, s: string): string {
    return paint(this.color, name, s);
  }

  header(s: string): void {
    this.records.push({ level: "header", msg: s });
    if (!this.json) this.out.write(`\n${this.c("bold", `==> ${s}`)}\n`);
  }
  ok(s: string): void {
    this.records.push({ level: "ok", msg: s });
    if (!this.json) this.out.write(`  ${this.c("green", "✓")} ${s}\n`);
  }
  skip(s: string): void {
    this.records.push({ level: "skip", msg: s });
    if (!this.json) this.out.write(`  ${this.c("dim", `- ${s}`)}\n`);
  }
  note(s: string): void {
    this.records.push({ level: "note", msg: s });
    if (!this.json) this.out.write(`    ${s}\n`);
  }
  plan(s: string): void {
    this.records.push({ level: "plan", msg: s });
    if (!this.json) this.out.write(`  ${this.c("cyan", `~ ${s}`)}\n`);
  }
  warn(s: string): void {
    this.warnings++;
    this.records.push({ level: "warn", msg: s });
    if (!this.json) this.out.write(`  ${this.c("yellow", "→")} ${s}\n`);
  }
  fail(s: string): void {
    this.failures++;
    this.records.push({ level: "fail", msg: s });
    if (!this.json) this.err.write(`  ${this.c("red", "✗")} ${s}\n`);
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
  }): number {
    const f = this.failures;
    const w = this.warnings;
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
}
