// Interactive y/N gate for a destructive action (uninstall). --yes is the explicit
// opt-in and always proceeds. An interactive terminal is prompted. A non-TTY — a pipe, CI,
// cron, `boom uninstall < /dev/null` — has no one to prompt, so it REFUSES rather than
// silently running an irreversible teardown: exactly the case where a stray invocation is
// most likely and most costly. Automation passes --yes to consent explicitly. Returns true
// to proceed.

// What confirm needs from a terminal: whether anyone is there, and one line from them. A
// parameter (defaulting to the real one) so the prompted branch is testable at all — `bun test`
// runs non-TTY, which is exactly the branch that refuses.
export interface Terminal {
  readonly isTTY: boolean;
  // One line of input, or null on EOF.
  ask(question: string): string | null;
}

// The real process stdin, not the injected ctx.process: TTY-ness and a terminal read are
// inherently about the real terminal.
export const realTerminal: Terminal = {
  get isTTY() {
    return Boolean(process.stdin.isTTY);
  },
  // Bun's global prompt() reads one line from stdin; null on EOF.
  ask: (question) => prompt(question),
};

export function confirm(
  question: string,
  opts: { yes?: boolean } = {},
  term: Terminal = realTerminal,
): boolean {
  if (opts.yes) return true;
  if (!term.isTTY) return false;
  const answer = term.ask(`${question} [y/N]`);
  return answer !== null && /^y(es)?$/i.test(answer.trim());
}
