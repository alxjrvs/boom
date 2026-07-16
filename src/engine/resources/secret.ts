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
import { dirname } from "node:path";
import type { Secret } from "../../config/schema.ts";
import { chmod, displayPath, expandTilde, mkdir, pathExists, rm, stat } from "../../lib/fs.ts";
import { getBackend, type SecretResult } from "../secrets/backends.ts";
import type { ReconcileCtx } from "../types.ts";

const DEFAULT_MODE = 0o600;

// Resolve the secret's plaintext through its backend (op/env/pass/age/sops — see backends.ts).
// Runs under the active-work spinner: a resolve may be a network round-trip (op) or a decrypt.
// The plaintext stays in this function's locals; nothing logs or journals it.
function render(entry: Secret, ctx: ReconcileCtx): Promise<SecretResult> {
  const backend = getBackend(entry);
  return ctx.report.spin(`secret (${backend.name})`, () => backend.read(entry, ctx));
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
      // A dry-run plan states intent without resolving anything, so it never needs the backend's
      // tool present (or a reachable vault).
      if (ctx.dryRun) {
        report.plan(`${disp} would be rendered from ${entry.ref ?? entry.template}`);
        return;
      }
      const backend = getBackend(entry);
      if (!backend.available(ctx.env)) {
        report.fail(`${disp} — ${backend.tool} not installed, can't render secret`);
        return;
      }
      const r = await render(entry, ctx);
      if (!r.ok) {
        report.fail(`${disp} — ${r.err}`);
        return;
      }
      // Already the intended content? Skip the rewrite (and the journal churn) — the same
      // change-gate `copy` uses. But still enforce the mode: a secret whose content is current
      // yet whose permissions drifted looser (a prior umask, a manual chmod) must be tightened,
      // or the 0600 guarantee is silently broken. Re-chmod without rewriting the plaintext.
      if ((await pathExists(dst)) && (await Bun.file(dst).text()) === r.value) {
        if (((await stat(dst)).mode & 0o777) === mode) {
          report.skip(`${disp} already current`);
        } else {
          await chmod(dst, mode);
          report.ok(`${disp} mode tightened to 0${mode.toString(8)}`);
        }
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
      // Mode drift is checkable without op (no network) — flag a secret that's readable by more
      // than its owner before even looking at content freshness.
      const curMode = (await stat(dst)).mode & 0o777;
      if (curMode !== mode) {
        report.warn(`${disp} mode 0${curMode.toString(8)}, expected 0${mode.toString(8)} — run: boom source`);
        return;
      }
      // Without the backend's tool (missing, or offline) we can still confirm the file is present
      // but can't check its freshness against the source — report that honestly rather than
      // passing it as current.
      const backend = getBackend(entry);
      if (!backend.available(ctx.env)) {
        report.skip(`${disp} present (${backend.name} unavailable — freshness unchecked)`);
        return;
      }
      const r = await render(entry, ctx);
      if (!r.ok) {
        report.skip(`${disp} present (couldn't resolve secret — freshness unchecked)`);
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
