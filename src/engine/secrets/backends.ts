// Pluggable secret backends. The `secret` resource used to be hardwired to 1Password (`op`);
// this file is the seam that lets a boomfile source a secret's plaintext from somewhere else.
// Two backends exist: 1Password (`op`) and the process environment (`env:`). Everything the
// resource does with the resolved plaintext (0600 write, never-journal-the-plaintext,
// remove-only undo, keep-out-of-manifest) is backend-agnostic and lives in resources/secret.ts
// — a backend's ONLY job is `ref`/`template` → plaintext.
//
// Backend selection: an explicit `backend = "…"` wins; otherwise it is inferred from the ref's
// scheme. See getBackend() at the bottom.
import { join } from "node:path";
import type { Secret } from "../../config/schema.ts";
import type { Env } from "../../lib/paths.ts";
import { captureArgvAsync, hasCommand, lastLine } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

export type SecretResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly err: string };

// What a backend actually reads off an entry, and off the run. Narrower than `Secret` /
// `ReconcileCtx` on purpose: resolving a reference needs the ref itself plus somewhere to
// anchor a repo-relative encrypted file — nothing about a destination, a mode, or a verb.
// A full `Secret`/`ReconcileCtx` still satisfies both structurally, so the `secret` resource
// passes its own values through unchanged; the narrowing is what lets a non-resource caller
// resolve a bare ref without fabricating a fake destination.
type SecretSource = Pick<Secret, "ref" | "template" | "backend">;
type SecretCtx = Pick<ReconcileCtx, "env" | "repo">;

interface SecretBackend {
  // Short id — used in spinner + freshness messages.
  readonly name: string;
  // Human label for the underlying tool, folded into the "not installed" failure so a missing
  // backend names the thing to install (e.g. "op (1Password CLI) not installed").
  readonly tool: string;
  // Is the backend usable on this machine? (op needs its CLI on PATH; env never does —
  // that's the CI / airgapped / no-vault path.)
  available(env: Env): boolean;
  // Resolve the secret's plaintext. Never logs or returns anything but the value on success.
  read(entry: SecretSource, ctx: SecretCtx): Promise<SecretResult>;
}

// Strip a scheme prefix (`env:`) if present, so a ref works written either way
// ("env:MY_TOKEN" or a bare "MY_TOKEN").
function unscheme(ref: string, scheme: string): string {
  return ref.startsWith(`${scheme}:`) ? ref.slice(scheme.length + 1) : ref;
}

const env: SecretBackend = {
  name: "env",
  tool: "env",
  available: () => true,
  // The no-tool path: read the plaintext straight from the process env. A `ref` of "env:VARNAME"
  // (or a bare "VARNAME") names the variable — a missing var is a clean failure, not a crash.
  // Returned verbatim (no trim) so a value with deliberate whitespace survives byte-for-byte.
  async read(entry, ctx) {
    if (!entry.ref) return { ok: false, err: "env backend needs a `ref` (env:VARNAME), not a template" };
    const name = unscheme(entry.ref, "env");
    const value = ctx.env[name];
    if (value === undefined) return { ok: false, err: `$${name} not set` };
    return { ok: true, value };
  },
};

const op: SecretBackend = {
  name: "op",
  tool: "op (1Password CLI)",
  available: (env) => hasCommand("op", env),
  // A `ref` is one field (`op read --no-newline` strips only op's trailing newline, so a bare
  // key lands without one); a `template` is a whole file rendered by `op inject`.
  async read(entry, ctx) {
    const argv = entry.ref
      ? ["op", "read", "--no-newline", entry.ref]
      : ["op", "inject", "-i", join(ctx.repo, entry.template as string)];
    const r = await captureArgvAsync(argv, ctx.env);
    if (r.code !== 0) return { ok: false, err: lastLine(r.stderr) || "op failed" };
    return { ok: true, value: r.stdout };
  },
};

const BACKENDS: Record<Secret["backend"] & string, SecretBackend> = { op, env };

// Infer from the ref scheme when a boomfile doesn't state one, so `op://…` and `env:…` route
// themselves and no config needs a `backend =` key. A bare ref stays 1Password, which is the
// back-compat default every existing boomfile relies on.
export function getBackend(entry: SecretSource): SecretBackend {
  if (entry.backend) return BACKENDS[entry.backend];
  return (entry.ref ?? entry.template ?? "").startsWith("env:") ? env : op;
}
