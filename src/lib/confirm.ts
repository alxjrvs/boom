// Interactive y/N gate for a destructive action (uninstall, reset). Scriptable-first: the
// ONLY case that actually prompts is an interactive terminal without --yes. A non-TTY —
// a pipe, CI, a test, `boom uninstall < /dev/null` — proceeds silently, so automation is
// never blocked and the flag-driven contract is unchanged. Returns true to proceed.
//
// Reads the real process stdin/`prompt` (not the injected ctx.process): TTY-ness and a
// terminal read are inherently about the real terminal, and tests run non-TTY so they take
// the silent-proceed path and never reach the prompt.
export function confirm(question: string, opts: { yes?: boolean } = {}): boolean {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) return true;
  // Bun's global prompt() reads one line from stdin; null on EOF.
  const answer = prompt(`${question} [y/N]`);
  return answer !== null && /^y(es)?$/i.test(answer.trim());
}
