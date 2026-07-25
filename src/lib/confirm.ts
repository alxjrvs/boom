// Interactive y/N gate for a destructive action (uninstall, reset). --yes is the explicit
// opt-in and always proceeds. An interactive terminal is prompted. A non-TTY — a pipe, CI,
// cron, `boom uninstall < /dev/null` — has no one to prompt, so it REFUSES rather than
// silently running an irreversible teardown: exactly the case where a stray invocation is
// most likely and most costly. Automation passes --yes to consent explicitly. Returns true
// to proceed.
//
// Reads the real process stdin/`prompt` (not the injected ctx.process): TTY-ness and a
// terminal read are inherently about the real terminal, and tests run non-TTY so they take
// the refuse path unless they pass --yes.
export function confirm(question: string, opts: { yes?: boolean } = {}): boolean {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) return false;
  // Bun's global prompt() reads one line from stdin; null on EOF.
  const answer = prompt(`${question} [y/N]`);
  return answer !== null && /^y(es)?$/i.test(answer.trim());
}

export interface Choice<T extends string> {
  // The single character typed to pick this. Matched case-insensitively.
  readonly key: string;
  // Shown in the prompt next to the key.
  readonly label: string;
  readonly value: T;
}

// Multi-way sibling of confirm(), for "what should I do with this one?" rather than
// "should I proceed?" — same doctrine: it reads the real terminal, and a non-TTY (pipe,
// CI, launchd timer) is never prompted and gets `fallback`, which every caller sets to
// the do-nothing option. Empty input takes the fallback too, so leaning on return is
// always the safe move. An unrecognized key re-asks rather than guessing, since the
// choices here are not all reversible.
export function choose<T extends string>(question: string, choices: readonly Choice<T>[], fallback: T): T {
  if (!process.stdin.isTTY || choices.length === 0) return fallback;
  const menu = choices.map((c) => `${c.key}=${c.label}`).join("  ");
  for (;;) {
    const answer = prompt(`${question}\n  ${menu}\n  choice`);
    // null is EOF (stdin closed mid-run) — treat it as "stop asking", not as a pick.
    if (answer === null) return fallback;
    const typed = answer.trim().toLowerCase();
    if (typed === "") return fallback;
    const hit = choices.find((c) => c.key.toLowerCase() === typed);
    if (hit) return hit.value;
  }
}
