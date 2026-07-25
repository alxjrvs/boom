// `boom askpass <ref>` — resolve one secret reference and print it, nothing else. This is the
// program `sudo -A` runs when a spawned tool (Homebrew, apt) needs a password mid-reconcile; the
// generated shim that names it lives in engine/secrets/askpass.ts, which explains why the
// indirection is necessary at all.
//
// Deliberately a real, documented command rather than a hidden one: it's the same registry every
// other command uses ("commands are discovered, never a hardcoded dispatch"), and hiding it would
// buy nothing — it grants no capability its caller didn't already have, since anyone who can run
// `boom askpass op://…` can run `op read op://…` directly.
//
// Output discipline: the plaintext goes to stdout with NO trailing newline (sudo reads the whole
// line as the password — a newline is fine, but a trailing one is what a stray blank could be
// confused for, and `op read --no-newline` already gives us the exact bytes). Failures go to
// stderr and exit non-zero so sudo reports "no password was provided" instead of trying "".
import { buildCommand } from "@stricli/core";
import { resolveConfigDir } from "../config/load.ts";
import type { BoomContext } from "../context.ts";
import { resolveRef } from "../engine/secrets/backends.ts";
import { str } from "./flags.ts";

export const askpassCommand = buildCommand<Record<never, never>, [string], BoomContext>({
  docs: {
    brief: "Resolve a secret ref to stdout (the SUDO_ASKPASS helper — not for interactive use)",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ parse: str, placeholder: "ref", brief: "op://vault/item/field, env:VAR, or pass:path" }],
    },
  },
  async func(_flags, ref) {
    // A repo anchor is only load-bearing for the file-based backends (age/sops resolve a
    // repo-relative path); an op/env/pass ref never touches it. So a machine with no config repo
    // still answers a sudo prompt rather than failing on an unrelated lookup.
    const repo = (await resolveConfigDir(this.env, this.cwd)) ?? this.cwd;
    const r = await resolveRef(ref, { env: this.env, repo });
    if (!r.ok) return new Error(`askpass: ${r.err}`);
    this.process.stdout.write(r.value);
    return;
  },
});
