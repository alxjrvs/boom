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
}
