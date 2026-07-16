// Pluggable secret backends. The `secret` resource used to be hardwired to 1Password (`op`);
// this file is the seam that lets a boomfile source a secret's plaintext from 1Password OR a
// plain env var OR `pass` OR an age/sops-encrypted file. Everything the resource does with the
// resolved plaintext (0600 write, never-journal-the-plaintext, remove-only undo, keep-out-of-
// manifest) is backend-agnostic and lives in resources/secret.ts — a backend's ONLY job is
// `ref`/`template` → plaintext.
//
// Backend selection: an explicit `backend = "…"` wins; otherwise it's inferred from the ref's
// scheme (`op://` → op, `env:` → env, `pass:` → pass) or a file extension (`.age` → age,
// `.sops.*`/`.enc` → sops), defaulting to op so every existing `op://…` boomfile keeps working
// untouched. See pickBackend().
import { isAbsolute, join } from "node:path";
import type { Secret } from "../../config/schema.ts";
import { captureArgvAsync, type Env, hasCommand, lastLine } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

export type SecretResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly err: string };

export interface SecretBackend {
  // Short id (op/env/pass/age/sops) — used in spinner + freshness messages.
  readonly name: string;
  // Human label for the underlying tool, folded into the "not installed" failure so a missing
  // backend names the thing to install (e.g. "pass not installed").
  readonly tool: string;
  // Is the backend usable on this machine? (op/pass/age/sops need their CLI on PATH; env never
  // does — that's the CI / airgapped / no-vault path.)
  available(env: Env): boolean;
  // Resolve the secret's plaintext. Never logs or returns anything but the value on success.
  read(entry: Secret, ctx: ReconcileCtx): Promise<SecretResult>;
}

// The file a file-based backend (age/sops) decrypts: a `template` is repo-relative (like the op
// backend's `op inject -i`); a `ref` may be absolute or repo-relative. Resolved against the
// config repo so an encrypted secret committed beside the boomfile is addressed by its repo path.
function filePath(entry: Secret, ctx: ReconcileCtx): string {
  const p = entry.template ?? entry.ref ?? "";
  return isAbsolute(p) ? p : join(ctx.repo, p);
}

// Strip a scheme prefix (`env:`, `pass:`) if present, so a ref works written either way
// ("env:MY_TOKEN" or a bare "MY_TOKEN").
function unscheme(ref: string, scheme: string): string {
  return ref.startsWith(`${scheme}:`) ? ref.slice(scheme.length + 1) : ref;
}

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

const pass: SecretBackend = {
  name: "pass",
  tool: "pass",
  available: (e) => hasCommand("pass", e),
  // `pass show <path>` — a ref of "pass:foo/bar" (or a bare "foo/bar") names the store entry.
  // captureArgvAsync trims, so a single-line secret lands without pass's trailing newline;
  // a multi-line entry is returned whole (its first line is the conventional password).
  async read(entry, ctx) {
    if (!entry.ref) return { ok: false, err: "pass backend needs a `ref` (pass:path), not a template" };
    const path = unscheme(entry.ref, "pass");
    const r = await captureArgvAsync(["pass", "show", path], ctx.env);
    if (r.code !== 0) return { ok: false, err: lastLine(r.stderr) || "pass show failed" };
    return { ok: true, value: r.stdout };
  },
};

const age: SecretBackend = {
  name: "age",
  tool: "age",
  available: (e) => hasCommand("age", e),
  // Decrypt an age-encrypted file with an identity from $BOOM_AGE_IDENTITY (a path to an age
  // identity/key file). Best-effort: identity discovery is deliberately env-var driven rather
  // than probing the many places age keys can live.
  async read(entry, ctx) {
    const identity = ctx.env.BOOM_AGE_IDENTITY;
    if (!identity) return { ok: false, err: "BOOM_AGE_IDENTITY not set (path to an age identity file)" };
    const r = await captureArgvAsync(["age", "-d", "-i", identity, filePath(entry, ctx)], ctx.env);
    if (r.code !== 0) return { ok: false, err: lastLine(r.stderr) || "age -d failed" };
    return { ok: true, value: r.stdout };
  },
};

const sops: SecretBackend = {
  name: "sops",
  tool: "sops",
  available: (e) => hasCommand("sops", e),
  // `sops -d <file>` — key discovery is sops's own (SOPS_AGE_KEY_FILE, KMS/GPG env, etc.), so
  // boom just invokes it and surfaces its stderr on failure. Best-effort, same as age.
  async read(entry, ctx) {
    const r = await captureArgvAsync(["sops", "-d", filePath(entry, ctx)], ctx.env);
    if (r.code !== 0) return { ok: false, err: lastLine(r.stderr) || "sops -d failed" };
    return { ok: true, value: r.stdout };
  },
};

const BACKENDS: Record<Secret["backend"] & string, SecretBackend> = { op, env, pass, age, sops };

// Infer the backend from the ref scheme / file extension when a boomfile doesn't state one, so
// `op://…` (and a committed `.age`/`.sops.yaml`) route themselves and existing configs need no
// `backend =` key. Kept in one place so the seam is a single, testable decision.
function pickBackend(entry: Secret): SecretBackend {
  const src = entry.ref ?? entry.template ?? "";
  if (src.startsWith("op://")) return op;
  if (src.startsWith("env:")) return env;
  if (src.startsWith("pass:")) return pass;
  if (src.endsWith(".age")) return age;
  if (/\.sops\.[^.]+$|\.enc$/.test(src)) return sops;
  return op; // back-compat default: a bare ref/template is a 1Password reference.
}

// The backend for an entry: an explicit `backend =` wins, else inferred from the ref/template.
export function getBackend(entry: Secret): SecretBackend {
  return entry.backend ? BACKENDS[entry.backend] : pickBackend(entry);
}
