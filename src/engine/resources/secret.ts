// The `secret` resource: render a 1Password secret to a file at sync time, so a machine's
// secret-bearing config is declared like every other resource instead of living out of band.
// The op-native counterpart to `copy` — `ref` is a single `op://vault/item/field` reference
// (`op read`), `template` a repo-relative file whose embedded `op://…` references are filled
// in (`op inject`). Two disciplines set it apart from `copy`:
//   • the plaintext is NEVER journaled or backed up (the undo is a plain remove — a rollback
//     deletes the rendered secret rather than restoring a copy of it from the backup tree,
//     which would leave plaintext on disk outside the vault);
//   • the file is written 0600 by default (a secret only its owner can read).
// Secrets are deliberately kept out of the owned-destinations manifest, so orphan reaping never
// auto-deletes one — dropping a secret from the config leaves the rendered file in place;
// `uninstall` is the one path that removes it.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Secret } from "../../config/schema.ts";
import { chmod, displayPath, expandTilde, mkdir, pathExists, rm } from "../../lib/fs.ts";
import { captureArgvAsync, hasCommand } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

const DEFAULT_MODE = 0o600;

interface Rendered {
  readonly ok: boolean;
  readonly value?: string;
  readonly err?: string;
}

// Resolve the secret's plaintext via `op`. A `ref` is one field (`op read --no-newline` strips
// only the trailing newline op appends, so a bare API key lands without one); a `template` is a
// whole file rendered by `op inject`. Runs under the active-work spinner — an `op` call is a
// network round-trip. The plaintext stays in this function's locals; nothing logs or journals it.
async function render(entry: Secret, ctx: ReconcileCtx): Promise<Rendered> {
  const argv = entry.ref
    ? ["op", "read", "--no-newline", entry.ref]
    : ["op", "inject", "-i", join(ctx.repo, entry.template as string)];
  const r = await ctx.report.spin(`op ${entry.ref ? "read" : "inject"}`, () =>
    captureArgvAsync(argv, ctx.env),
  );
  if (r.code !== 0) return { ok: false, err: r.stderr.split("\n").filter(Boolean).at(-1) ?? "op failed" };
  return { ok: true, value: r.stdout };
}

// Write the rendered secret with a restrictive mode. Remove any prior file first so writeFile's
// `mode` applies on creation (mode is honored only when the file is created), then chmod to
// pin it exactly regardless of umask.
async function writeSecret(dst: string, value: string, mode: number): Promise<void> {
  await mkdir(dirname(dst), { recursive: true });
  await rm(dst, { force: true });
  await writeFile(dst, value, { mode });
  await chmod(dst, mode);
}

export async function reconcileSecret(entry: Secret, ctx: ReconcileCtx): Promise<void> {
  const dst = expandTilde(entry.dst, ctx.env);
  const disp = displayPath(dst, ctx.env);
  const mode = entry.mode ? Number.parseInt(entry.mode, 8) : DEFAULT_MODE;
  const { report } = ctx;

  switch (ctx.verb) {
    case "sync": {
      if (!hasCommand("op", ctx.env)) {
        report.fail(`${disp} — op (1Password CLI) not installed, can't render secret`);
        return;
      }
      if (ctx.dryRun) {
        report.plan(`${disp} would be rendered from ${entry.ref ?? entry.template}`);
        return;
      }
      const r = await render(entry, ctx);
      if (!r.ok || r.value === undefined) {
        report.fail(`${disp} — ${r.err}`);
        return;
      }
      // Already the intended content? Skip the rewrite (and the journal churn) — the same
      // change-gate `copy` uses, so a steady-state sync says nothing about an unchanged secret.
      if ((await pathExists(dst)) && (await Bun.file(dst).text()) === r.value) {
        report.skip(`${disp} already current`);
        return;
      }
      // Journal a remove-only undo: rollback deletes the rendered secret. We deliberately do NOT
      // displace the prior file into the backup tree — that would persist its plaintext on disk.
      await ctx.journal?.intent("secret", dst);
      await ctx.journal?.done("secret", dst, { kind: "remove" });
      await writeSecret(dst, r.value, mode);
      report.ok(`${disp} rendered (0${mode.toString(8)})`);
      return;
    }
    case "verify": {
      if (!(await pathExists(dst))) {
        report.warn(`${disp} secret not rendered — run: boom source`);
        return;
      }
      // Without op (missing, or offline) we can still confirm the file is present but can't check
      // its freshness against the vault — report that honestly rather than passing it as current.
      if (!hasCommand("op", ctx.env)) {
        report.skip(`${disp} present (op unavailable — freshness unchecked)`);
        return;
      }
      const r = await render(entry, ctx);
      if (!r.ok || r.value === undefined) {
        report.skip(`${disp} present (couldn't reach 1Password — freshness unchecked)`);
        return;
      }
      if ((await Bun.file(dst).text()) === r.value) report.skip(`${disp} (secret current)`);
      else report.warn(`${disp} secret stale — run: boom source`);
      return;
    }
    case "uninstall": {
      if (!(await pathExists(dst))) return;
      if (ctx.dryRun) report.note(`would remove ${disp}`);
      else {
        await rm(dst, { force: true });
        report.ok(`${disp} removed`);
      }
      return;
    }
  }
}
