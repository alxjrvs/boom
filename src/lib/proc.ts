// Process helpers. Bun.spawnSync (not Bun.$) so the engine controls exit codes
// without throw semantics; `sh -c` so boomfile `run` strings expand ~ and globs.
// `Env` lives in ./paths.ts and is deliberately NOT re-exported here: with
// `verbatimModuleSyntax` on, a re-export would let a consumer keep spelling the process
// environment as a proc concern, which is how four duplicate local aliases grew.
import type { Env } from "./paths.ts";

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

interface RunOptions {
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
  // Watch the child's stdout line by line while it runs, instead of discarding it. The one caller
  // that needs this is a step that can trigger a `sudo` prompt: the tool's own progress output is
  // the only thing that knows *what* is about to ask (Homebrew's "==> Upgrading cask tuple"), so
  // boom relays a filtered version of it rather than leaving a bare "Password:" with no referent.
  // Set alongside `silent` — stdout is piped and pumped here rather than ignored, and stderr keeps
  // silent's capture-for-failures behavior. Lines arrive without their trailing newline.
  //
  // Piping stdout has a deliberate side effect: it costs the child its tty, so Homebrew drops its
  // colors and download progress bars and emits clean, parseable lines. sudo's prompt is unaffected
  // — it goes to /dev/tty, which is exactly why it survives every stdio discipline boom has.
  readonly onStdoutLine?: (line: string) => void;
}

// fd 2 = the parent's stderr; Bun.spawn routes a child stream to a parent fd by number.
const childStdout = (opts?: RunOptions): "inherit" | 2 => (opts?.quietStdout ? 2 : "inherit");

// The stdio pair for a child, resolving the output disciplines: a watched stdout (piped, pumped to
// onStdoutLine), silent (discard stdout, capture stderr so a failure can still be explained),
// quietStdout (stdout→fd2, keep JSON clean), or inherit (stream straight to the terminal).
type Stdio = { stdout: "inherit" | "ignore" | "pipe" | 2; stderr: "inherit" | "pipe" };
const stdioFor = (opts?: RunOptions): Stdio => {
  if (opts?.onStdoutLine) return { stdout: "pipe", stderr: opts.silent ? "pipe" : "inherit" };
  return opts?.silent
    ? { stdout: "ignore", stderr: "pipe" }
    : { stdout: childStdout(opts), stderr: "inherit" };
};

// Pump a piped stream to a per-line callback. Split on newlines across chunk boundaries (a chunk is
// not a line), and flush any unterminated tail so a tool whose last line lacks a newline is still
// seen. Must be consumed concurrently with the child's exit: an unread pipe fills and the child
// blocks on write, which would deadlock the very step this exists to narrate.
async function pumpLines(stream: ReadableStream, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  }
  if (buf.length > 0) onLine(buf);
}

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

// Async twins of runShell/runArgv/captureArgv, backing the animated active-work spinner: a slow
// tool (brew/mise/git/a `run` step) is spawned with `Bun.spawn` and awaited, so the event loop
// stays free to redraw the spinner while it works — `Bun.spawnSync` would block the loop and freeze
// the animation. Same stdio disciplines, timeout, and ShellResult shape as the sync versions; the
// sync ones stay for the fast, non-awaited callers (defaults writes, launchctl, git plumbing).
export async function runShellAsync(cmd: string, env: Env, opts?: RunOptions): Promise<ShellResult> {
  const io = stdioFor(opts);
  const proc = Bun.spawn(["sh", "-c", cmd], { env: cleanEnv(env), cwd: opts?.cwd, ...io });
  const timeout = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : undefined;
  let timedOut = false;
  // SIGTERM on the deadline, mirroring spawnSync's `timeout`; the flag (not exitCode===null) is the
  // truthful "did the deadline fire" signal, since any signal death also nulls the exit code.
  const timer = timeout
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeout)
    : undefined;
  const stderr = opts?.silent ? await new Response(proc.stderr as ReadableStream).text() : undefined;
  await proc.exited;
  if (timer) clearTimeout(timer);
  return { code: exitOf(proc), timedOut, ...(opts?.silent ? { stderr: stderr?.trim() ?? "" } : {}) };
}

export async function runArgvAsync(args: string[], env: Env, opts?: RunOptions): Promise<ShellResult> {
  const io = stdioFor(opts);
  const proc = Bun.spawn(args, { env: cleanEnv(env), cwd: opts?.cwd, ...io });
  const watch = opts?.onStdoutLine ? pumpLines(proc.stdout as ReadableStream, opts.onStdoutLine) : undefined;
  // Same deadline discipline as runShellAsync. This used to ignore `timeoutMs` outright, which
  // made the documented cap a lie for every engine-owned argv invocation (brew/mise/apt) — the
  // exact callers most able to block forever. No caller passes one today; the point is that the
  // next one gets the behavior RunOptions advertises instead of an unbounded wait.
  const timeout = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : undefined;
  let timedOut = false;
  const timer = timeout
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeout)
    : undefined;
  // Drain stderr and the watched stdout concurrently, and only then await the exit. Reading one to
  // completion first would stall on a full pipe for a chatty tool — the deadlock this narration
  // exists to avoid, not cause.
  const [stderr] = await Promise.all([
    opts?.silent ? new Response(proc.stderr as ReadableStream).text() : undefined,
    watch,
  ]);
  await proc.exited;
  if (timer) clearTimeout(timer);
  return { code: exitOf(proc), timedOut, ...(opts?.silent ? { stderr: stderr?.trim() ?? "" } : {}) };
}

export async function captureArgvAsync(args: string[], env: Env, opts?: RunOptions): Promise<CaptureResult> {
  // Same missing-executable → {code:-1} contract as captureArgv, so an awaited git call degrades
  // rather than crashing its caller.
  try {
    const proc = Bun.spawn(args, { env: cleanEnv(env), cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    await proc.exited;
    return { code: exitOf(proc), stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
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
// captureArgv's shell-string sibling, for a user-authored command that wants the shell's
// expansion (the `check` resource's `cmd`, which is written in a boomfile the way it would be
// typed). Honors `timeoutMs`, because a `cmd` check runs inside `verify` and a command that
// hangs would hang the drift report.
export function captureShell(cmd: string, env: Env, opts?: RunOptions): CaptureResult {
  const timeout = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : undefined;
  try {
    const p = Bun.spawnSync(["sh", "-c", cmd], {
      env: cleanEnv(env),
      cwd: opts?.cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout,
    });
    return {
      code: exitOf(p),
      timedOut: timeout !== undefined && p.exitCode === null,
      stdout: p.stdout.toString().trim(),
      stderr: p.stderr.toString().trim(),
    };
  } catch (e) {
    return { code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

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
