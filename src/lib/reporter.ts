// Reporter: the engine's output surface + pass/fail tally. Mirrors the bash engine's
// _ok/_warn/_fail and drives the verify exit code (0 ok / 2 warn / 1 fail).
import { type ColorName, paint } from "./color.ts";

interface Stream {
  write(s: string): void;
}

export class Reporter {
  warnings = 0;
  failures = 0;

  constructor(
    private readonly out: Stream,
    private readonly err: Stream,
    private readonly color: boolean,
  ) {}

  private c(name: ColorName, s: string): string {
    return paint(this.color, name, s);
  }

  header(s: string): void {
    this.out.write(`\n${this.c("bold", `==> ${s}`)}\n`);
  }
  ok(s: string): void {
    this.out.write(`  ${this.c("green", "✓")} ${s}\n`);
  }
  skip(s: string): void {
    this.out.write(`  ${this.c("dim", `- ${s}`)}\n`);
  }
  note(s: string): void {
    this.out.write(`    ${s}\n`);
  }
  plan(s: string): void {
    this.out.write(`  ${this.c("cyan", `~ ${s}`)}\n`);
  }
  warn(s: string): void {
    this.warnings++;
    this.out.write(`  ${this.c("yellow", "→")} ${s}\n`);
  }
  fail(s: string): void {
    this.failures++;
    this.err.write(`  ${this.c("red", "✗")} ${s}\n`);
  }
}
