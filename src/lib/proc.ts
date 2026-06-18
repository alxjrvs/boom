// Process helpers. Bun.spawnSync (not Bun.$) so the engine controls exit codes
// without throw semantics; `sh -c` so botufile `run` strings expand ~ and globs.
type Env = Record<string, string | undefined>;

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
}

// fd 2 = the parent's stderr; Bun.spawn routes a child stream to a parent fd by number.
const childStdout = (opts?: RunOptions): "inherit" | 2 => (opts?.quietStdout ? 2 : "inherit");

export function runShell(cmd: string, env: Env, opts?: RunOptions): ShellResult {
  const p = Bun.spawnSync(["sh", "-c", cmd], {
    env: cleanEnv(env),
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
  const p = Bun.spawnSync(args, { env: cleanEnv(env), stdout: childStdout(opts), stderr: "inherit" });
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
