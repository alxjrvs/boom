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

export function runShell(cmd: string, env: Env): ShellResult {
  const p = Bun.spawnSync(["sh", "-c", cmd], {
    env: cleanEnv(env),
    stdout: "inherit",
    stderr: "inherit",
  });
  return { code: p.exitCode };
}

// Run a tool by argv (no shell). Preferred for the engine's own invocations
// (brew/mise/defaults) — passing a path as an argument needs no quoting and can't be
// re-parsed by sh, unlike interpolating it into a `runShell` string. `runShell` stays
// for user `run` strings, which deliberately want shell ~/glob expansion.
export function runArgv(args: string[], env: Env): ShellResult {
  const p = Bun.spawnSync(args, { env: cleanEnv(env), stdout: "inherit", stderr: "inherit" });
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
