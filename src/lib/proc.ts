// Process helpers. Bun.spawnSync (not Bun.$) so the engine controls exit codes
// without throw semantics; `sh -c` so boomfile `run` strings expand ~ and globs.
export type Env = Record<string, string | undefined>;

export function cleanEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

export interface ShellResult {
  readonly code: number;
  // True when the child was killed by the RunOptions.timeoutMs deadline (rather than
  // exiting on its own). runShell surfaces this so a hung `run` step reads as a timeout,
  // not a generic failure.
  readonly timedOut?: boolean;
  // The child's stderr, captured only under RunOptions.silent (where it's the sole surviving
  // channel) so a failing step can surface *why* it failed even though its chatter was hidden.
  readonly stderr?: string;
}

export interface RunOptions {
  // Keep the parent's stdout clean for a `--json` envelope by routing the child's
  // stdout to fd 2 (the parent's stderr) — diagnostics stay visible, off the JSON
  // channel. Default: inherit the parent's stdout.
  readonly quietStdout?: boolean;
  // Fully suppress the child's stdout (quiet bands mode: the tool's chatter is hidden under a
  // section band, revealed only by --verbose). stderr is captured, not shown, so a non-zero
  // exit can still be explained. Takes precedence over quietStdout.
  readonly silent?: boolean;
  // Working directory for the child. Default: inherit the parent's cwd. The engine
  // sets this to the dotfiles repo so a `run` step (or `mise install`) operates on
  // the configured machine, not on wherever `boom` happened to be invoked from.
  readonly cwd?: string;
  // Wall-clock cap in ms; Bun.spawnSync kills the child (SIGTERM) when it's exceeded.
  // Omit / 0 for no limit.
  readonly timeoutMs?: number;
}

// fd 2 = the parent's stderr; Bun.spawn routes a child stream to a parent fd by number.
const childStdout = (opts?: RunOptions): "inherit" | 2 => (opts?.quietStdout ? 2 : "inherit");

// The stdio pair for a child, resolving the three output disciplines: silent (discard stdout,
// capture stderr so a failure can still be explained), quietStdout (stdout→fd2, keep JSON clean),
// or inherit (stream straight to the terminal — verbose / default).
type Stdio = { stdout: "inherit" | "ignore" | 2; stderr: "inherit" | "pipe" };
const stdioFor = (opts?: RunOptions): Stdio =>
  opts?.silent ? { stdout: "ignore", stderr: "pipe" } : { stdout: childStdout(opts), stderr: "inherit" };

// A child killed by a signal (timeout, SIGKILL) yields exitCode null; map that onto a
// non-zero code so `code === 0` is never a false success and the number type never lies.
function exitOf(p: { exitCode: number | null }): number {
  return p.exitCode ?? 1;
}

export function runShell(cmd: string, env: Env, opts?: RunOptions): ShellResult {
  const timeout = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : undefined;
  const p = Bun.spawnSync(["sh", "-c", cmd], {
    env: cleanEnv(env),
    cwd: opts?.cwd,
    ...stdioFor(opts),
    timeout,
  });
  // exitCode is null when the child was signalled — with a timeout set that's the deadline
  // firing. (A signal without a timeout still maps to a non-zero code via exitOf.)
  return {
    code: exitOf(p),
    timedOut: timeout !== undefined && p.exitCode === null,
    ...(opts?.silent ? { stderr: p.stderr?.toString().trim() ?? "" } : {}),
  };
}

// Run a tool by argv (no shell). Preferred for the engine's own invocations
// (brew/mise/defaults) — passing a path as an argument needs no quoting and can't be
// re-parsed by sh, unlike interpolating it into a `runShell` string. `runShell` stays
// for user `run` strings, which deliberately want shell ~/glob expansion.
export function runArgv(args: string[], env: Env, opts?: RunOptions): ShellResult {
  const p = Bun.spawnSync(args, {
    env: cleanEnv(env),
    cwd: opts?.cwd,
    ...stdioFor(opts),
  });
  return {
    code: exitOf(p),
    ...(opts?.silent ? { stderr: p.stderr?.toString().trim() ?? "" } : {}),
  };
}

// The output discipline for a spawned tool, from the run's mode: --json keeps the child's stdout
// off the envelope channel (→ fd 2); a quiet human run silences it under the section band (stderr
// captured for a failure message); verbose streams it live. Callers spread the result and add
// cwd/timeout. Centralizes the "where does brew's chatter go" decision the noisy resources share.
export function toolIo(json: boolean, verbose: boolean): RunOptions {
  if (json) return { quietStdout: true };
  if (verbose) return {};
  return { silent: true };
}

// The last non-blank line of captured stderr — a compact "why did it fail" tail to fold into a
// fail() message when the tool's own output was silenced. Empty string when there's nothing.
export function lastLine(s?: string): string {
  return s?.trim().split("\n").filter(Boolean).at(-1) ?? "";
}

export function hasCommand(name: string, env: Env): boolean {
  // Bun.which is an in-process PATH lookup — no `sh -c command -v <name>` subprocess
  // (doctor alone forked five), and no shell re-parse of an interpolated name. Honor
  // the caller's PATH so a sandboxed test env resolves against its own PATH, not the
  // parent process's.
  return Bun.which(name, { PATH: env.PATH }) !== null;
}

export interface CaptureResult extends ShellResult {
  readonly stdout: string;
  readonly stderr: string;
}

// Like runArgv, but captures output instead of streaming it — for callers that need
// the text (git plumbing: remote URLs, commit counts, changed-file lists), not just a
// pass/fail exit code.
export function captureArgv(args: string[], env: Env, opts?: RunOptions): CaptureResult {
  // Bun.spawnSync throws (missing executable, nonexistent cwd) rather than returning
  // a failed result. Callers treat the tool as a black box with exit codes — sync
  // must degrade to "reconcile from the local clone", push/reset to a clean exit 1 —
  // so map the throw onto that contract instead of crashing them.
  try {
    const p = Bun.spawnSync(args, { env: cleanEnv(env), cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
    return { code: exitOf(p), stdout: p.stdout.toString().trim(), stderr: p.stderr.toString().trim() };
  } catch (e) {
    return { code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}
