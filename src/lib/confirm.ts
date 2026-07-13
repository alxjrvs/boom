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
