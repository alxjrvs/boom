// Process helpers. Bun.spawn/spawnSync (not Bun.$) so the engine controls exit codes
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

interface ShellResult {
  readonly code: number;
  // True when the child was killed by the RunOptions.timeoutMs deadline (rather than
  // exiting on its own), so a hung `run` step reads as a timeout, not a generic failure.
  readonly timedOut?: boolean;
  // The child's stderr, captured only under RunOptions.silent (where it's the sole surviving
  // channel) so a failing step can surface *why* it failed even though its chatter was hidden.
  readonly stderr?: string;
  // The child's stdout, captured only under RunOptions.captureStdout. Kept separate from stderr
  // because a script explains itself on whichever channel it likes, and under `silent` both are
  // hidden — so a step that reports on stdout would otherwise fail with no reason at all.
  readonly stdout?: string;
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
  // Capture the child's stdout into the result instead of discarding it. Only meaningful
  // alongside `silent`, which otherwise sends stdout to /dev/null.
  //
  // Opt-in rather than the default for `silent`, because the two kinds of caller want opposite
  // things. A package manager is silenced precisely because it is chatty — buffering all of
  // `brew bundle` to explain a failure would trade a real memory cost for output whose useful
  // part is the tail anyway. A `run` step is a short, purpose-written command whose entire job
  // may be to print one diagnostic, and it is free to print it on stdout.
  readonly captureStdout?: boolean;
  // Working directory for the child. Default: inherit the parent's cwd. The engine
  // sets this to the dotfiles repo so a `run` step (or `mise install`) operates on
  // the configured machine, not on wherever `boom` happened to be invoked from.
  readonly cwd?: string;
  // Wall-clock cap in ms; the child is killed (SIGTERM) when it's exceeded. Omit / 0 for no limit.
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
// onStdoutLine), silent (capture stderr so a failure can still be explained, and stdout too when
// captureStdout is set, otherwise discard it), quietStdout (stdout→fd2, keep JSON clean), or
// inherit (stream straight to the terminal).
type Stdio = { stdout: "inherit" | "ignore" | "pipe" | 2; stderr: "inherit" | "pipe" };
const stdioFor = (opts?: RunOptions): Stdio => {
  if (opts?.onStdoutLine) return { stdout: "pipe", stderr: opts.silent ? "pipe" : "inherit" };
  if (opts?.silent) return { stdout: opts.captureStdout ? "pipe" : "ignore", stderr: "pipe" };
  return { stdout: childStdout(opts), stderr: "inherit" };
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

// Drain a piped child stream to text. Bun types a subprocess's streams from its options, and
// `stdioFor` returns a union, so the channel is narrowed here at the read; a channel that was
// not piped (inherited, ignored, an fd) reads as empty.
const readAll = (s: ReadableStream | number | undefined): Promise<string> =>
  s instanceof ReadableStream ? s.text() : Promise.resolve("");

// The awaited spawners back the animated active-work spinner: a slow tool (brew/mise/git/a `run`
// step) is spawned with `Bun.spawn` and awaited, so the event loop stays free to redraw the
// spinner while it works — `Bun.spawnSync` would block the loop and freeze the animation.
// `runShellAsync` runs a user `run` string under `sh -c` (which deliberately wants shell ~/glob
// expansion); `runArgvAsync` runs a tool by argv, so a path is an argument that sh never re-parses.
// The synchronous `captureArgv` below stays for the fast, non-awaited callers (git plumbing,
// launchctl, defaults).
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
  // Both pipes drained CONCURRENTLY, and before the exit is awaited. Reading one to completion
  // first would stall on a full pipe for a command chatty on the other — the same deadlock the
  // argv path documents. With captureStdout unset this is the single-stream read it always was.
  const [stderr, stdout] = await Promise.all([
    opts?.silent ? readAll(proc.stderr) : undefined,
    opts?.silent && opts.captureStdout ? readAll(proc.stdout) : undefined,
  ]);
  await proc.exited;
  if (timer) clearTimeout(timer);
  return {
    code: exitOf(proc),
    timedOut,
    ...(opts?.silent ? { stderr: stderr?.trim() ?? "" } : {}),
    ...(opts?.silent && opts.captureStdout ? { stdout: stdout?.trim() ?? "" } : {}),
  };
}

export async function runArgvAsync(args: string[], env: Env, opts?: RunOptions): Promise<ShellResult> {
  const io = stdioFor(opts);
  const proc = Bun.spawn(args, { env: cleanEnv(env), cwd: opts?.cwd, ...io });
  const watch = opts?.onStdoutLine ? pumpLines(proc.stdout as ReadableStream, opts.onStdoutLine) : undefined;
  // Same deadline discipline as runShellAsync, so the documented cap holds for every engine-owned
  // argv invocation — the callers most able to block forever.
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
  const [stderr] = await Promise.all([opts?.silent ? readAll(proc.stderr) : undefined, watch]);
  await proc.exited;
  if (timer) clearTimeout(timer);
  return { code: exitOf(proc), timedOut, ...(opts?.silent ? { stderr: stderr?.trim() ?? "" } : {}) };
}

export async function captureArgvAsync(args: string[], env: Env, opts?: RunOptions): Promise<CaptureResult> {
  // Same missing-executable → {code:-1} contract as captureArgv, so an awaited git call degrades
  // rather than crashing its caller.
  try {
    const proc = Bun.spawn(args, { env: cleanEnv(env), cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([proc.stdout.text(), proc.stderr.text()]);
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
//
// Right for a PACKAGE MANAGER, whose output is long, templated, and worst-first-line: the tail is
// the actionable part. Wrong for a purpose-written command — see failureDetail below.
export function lastLine(s?: string): string {
  return s?.trim().split("\n").filter(Boolean).at(-1) ?? "";
}

// Env var NAMES whose VALUES must never survive into a report. Matched on the name, not on
// the value's shape: a token that happens to look like a word is still a token, and a
// value-shape heuristic would both miss those and mangle innocent output.
const SECRET_NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY|APIKEY|API_KEY|SESSION)/i;

// Shortest value worth substituting. Below this, a "secret" is more likely to be a flag value
// or an empty placeholder, and blanket-replacing a 3-character string would corrupt the very
// output someone is reading to debug the failure.
const MIN_REDACT_LEN = 8;

// Replace any secret-shaped env VALUE appearing in text with a named marker.
//
// A `run` step inherits the invoking environment, which on this project's own consumer carries
// OP_SERVICE_ACCOUNT_TOKEN, NPM_TOKEN and friends. `run.ts` captures BOTH channels (a step may
// explain itself on either) and hands them here on failure, so a step that echoed its
// environment — `set -x`, a curl that prints its own headers, a tool dumping config on error —
// put a live credential into the report and into `--json`. Losing the step's explanation is not
// an acceptable fix; scrubbing the values that could only have come from the environment is.
export function redactSecrets(text: string, env: Env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_REDACT_LEN || !SECRET_NAME_RE.test(name)) continue;
    // A function replacer: a string replacement is subject to `$&`/`$$` expansion, and this is
    // the one path where re-inserting the match would put the secret back.
    out = out.replaceAll(value, () => `«redacted:${name}»`);
  }
  return out;
}

// Every line a failing command emitted, indented under the fail message.
//
// WHY NOT lastLine HERE. A `run` step is somebody's own script, and a script states its most
// specific complaint FIRST and then adds context — the opposite shape to a package manager. Taking
// the last line therefore keeps the least useful one, systematically.
//
// Measured, on a nine-line vault-audit failure: the reported line was `- gninety`, naming an item
// that was present and correctly declared, while the finding — an undeclared item in a vault an
// agent can read — sat in the eight lines that were dropped. The check was right and the report
// was worse than useless, because it sent the operator to look at the wrong thing.
//
// stdout is included because a script is free to explain itself there, and under `silent` it is
// hidden too; a step reporting only on stdout would otherwise fail with a bare "(exit N)".
export function failureDetail(stderr?: string, stdout?: string, env?: Env): string {
  const body = [stderr, stdout]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join("\n");
  if (!body) return "";
  const safe = env ? redactSecrets(body, env) : body;
  return `\n${safe
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n")}`;
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

// Run a tool by argv and capture its output — for callers that need the text (git plumbing:
// remote URLs, commit counts, changed-file lists), not just a pass/fail exit code.
export function captureArgv(args: string[], env: Env, opts?: RunOptions): CaptureResult {
  // Bun.spawnSync throws (missing executable, nonexistent cwd) rather than returning a failed
  // result. Callers treat the tool as a black box with exit codes — sync must degrade to
  // "reconcile from the local clone" — so map the throw onto that contract instead of crashing.
  try {
    const p = Bun.spawnSync(args, { env: cleanEnv(env), cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
    return { code: exitOf(p), stdout: p.stdout.toString().trim(), stderr: p.stderr.toString().trim() };
  } catch (e) {
    return { code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}
