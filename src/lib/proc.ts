// Process helpers. Bun.spawnSync (not Bun.$) so the engine controls exit codes
// without throw semantics; `sh -c` so botufile `run` strings expand ~ and globs.
type Env = Record<string, string | undefined>;

function cleanEnv(env: Env): Record<string, string> {
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

export function hasCommand(name: string, env: Env): boolean {
  const p = Bun.spawnSync(["sh", "-c", `command -v ${name}`], {
    env: cleanEnv(env),
    stdout: "ignore",
    stderr: "ignore",
  });
  return p.exitCode === 0;
}
