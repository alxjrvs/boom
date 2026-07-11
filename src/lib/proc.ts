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
}

export interface RunOptions {
  // Keep the parent's stdout clean for a `--json` envelope by routing the child's
  // stdout to fd 2 (the parent's stderr) — diagnostics stay visible, off the JSON
  // channel. Default: inherit the parent's stdout.
  readonly quietStdout?: boolean;
  // Working directory for the child. Default: inherit the parent's cwd. The engine
  // sets this to the dotfiles repo so a `run` step (or `mise install`) operates on
  // the configured machine, not on wherever `boom` happened to be invoked from.
  readonly cwd?: string;
}

// fd 2 = the parent's stderr; Bun.spawn routes a child stream to a parent fd by number.
const childStdout = (opts?: RunOptions): "inherit" | 2 => (opts?.quietStdout ? 2 : "inherit");

export function runShell(cmd: string, env: Env, opts?: RunOptions): ShellResult {
  const p = Bun.spawnSync(["sh", "-c", cmd], {
    env: cleanEnv(env),
    cwd: opts?.cwd,
    stdout: childStdout(opts),
    stderr: "inherit",
  });
  return { code: p.exitCode };
}

// Run a tool by argv (no shell). Preferred for the engine's own invocations
// (brew/mise/defaults) — passing a path as an argument needs no quoting and can't be
// re-parsed by sh, unlike interpolating it into a `runShell` string. `runShell` stays
// for user `run` strings, which deliberately want shell ~/glob expansion.
export function runArgv(args: string[], env: Env, opts?: RunOptions): ShellResult {
  const p = Bun.spawnSync(args, {
    env: cleanEnv(env),
    cwd: opts?.cwd,
    stdout: childStdout(opts),
    stderr: "inherit",
  });
  return { code: p.exitCode };
}

export function hasCommand(name: string, env: Env): boolean {
  const p = Bun.spawnSync(["sh", "-c", `command -v ${name}`], {
    env: cleanEnv(env),
    stdout: "ignore",
    stderr: "ignore",
  });
  return p.exitCode === 0;
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
    return { code: p.exitCode, stdout: p.stdout.toString().trim(), stderr: p.stderr.toString().trim() };
  } catch (e) {
    return { code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}
