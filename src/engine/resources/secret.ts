// The `secret` resource: render a 1Password secret to a file at sync time, so a machine's
// secret-bearing config is declared like every other resource instead of living out of band.
// The op-native counterpart to `copy` — `ref` is a single `op://vault/item/field` reference
// (`op read`), `template` a repo-relative file whose embedded `op://…` references are filled
// in (`op inject`). Two disciplines set it apart from `copy`:
//   • the plaintext boom RENDERS is never journaled or backed up — a fresh render's undo is a
//     plain remove, so undoing it deletes the rendered secret rather than restoring a copy of
//     it from the backup tree, which would leave plaintext on disk outside the vault. A file
//     boom did NOT render is the user's, so displacing it into the backup tree leaks nothing
//     boom introduced and is what makes `--fix` recoverable. Accepted cost: secrets carry no
//     ownership record, so a `--fix` over boom's own PRIOR render (bytes since rotated) does
//     put that older plaintext under `…/backups/<run-id>/` for the retained window — which is
//     why that tree is created 0700 (lib/fs.ts `backupTo`). An ownership ledger would remove
//     the residual; destroying an unknown file to avoid it would be worse;
//   • the file is written 0600 by default (a secret only its owner can read).
// Secrets are deliberately kept out of the owned-destinations manifest, so orphan reaping never
// auto-deletes one — dropping a secret from the config leaves the rendered file in place;
// `uninstall` is the one path that removes it.
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Secret } from "../../config/schema.ts";
import { chmod, displayPath, expandTilde, mkdir, pathExists, rm, stat } from "../../lib/fs.ts";
import { journalWrite } from "../journal.ts";
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

// Write the rendered secret with a restrictive mode. This function only WRITES: the caller has
// already decided — and journalled — what happens to anything at `dst`, and by the time we get
// here nothing is in the way. So there is deliberately no `rm` (it would destroy a file boom
// never owned, with no journal row and no backup). `writeFile`'s `mode` is honored only when it
// creates the file, so the trailing `chmod` is what actually pins the mode regardless of umask.
async function writeSecret(dst: string, value: string, mode: number): Promise<void> {
  await mkdir(dirname(dst), { recursive: true });
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
      // tool present (or a reachable vault). It still stats `dst`, because which of the three
      // branches below a real run would take is exactly what a plan is for — a plan that always
      // says "would be rendered" hides the skip that `--fix` exists to unblock.
      if (ctx.dryRun) {
        if (!(await pathExists(dst))) {
          report.plan(`${disp} would be rendered from ${entry.ref ?? entry.template}`);
        } else if (ctx.linkMode === "overwrite") {
          report.plan(`${disp} would overwrite an existing file`);
        } else {
          report.plan(`${disp} would be left alone (boom source --fix replaces it)`);
        }
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
      // Never destroy a file boom doesn't own. Secrets carry no ownership record, so boom cannot
      // distinguish its own earlier render from something the user put here — under the safe
      // default it therefore leaves it alone and names the flag that overrides. This gate is the
      // SKIP ARM ONLY: it deliberately has no overwrite branch of its own, so an `--fix` run
      // falls THROUGH to the content-equality check below. Giving it one would make that check
      // unreachable whenever a file exists, and every `boom source --fix` on a converged machine
      // would displace the current, unchanged secret into that run's backup tree and re-render
      // it — one fresh copy of boom-rendered plaintext per run, on a flag the orphan warning
      // tells people to run. New plaintext persistence on the steady-state path is exactly what
      // this file's header discipline exists to prevent.
      const conflict = await pathExists(dst);
      if (conflict && ctx.linkMode !== "overwrite") {
        report.skip(`${disp} exists — left alone (boom source --fix replaces it)`);
        return;
      }
      // Already the intended content? Skip the rewrite (and the journal churn) — the same
      // change-gate `copy` uses. But still enforce the mode: a secret whose content is current
      // yet whose permissions drifted looser (a prior umask, a manual chmod) must be tightened,
      // or the 0600 guarantee is silently broken. Re-chmod without rewriting the plaintext.
      // Reachable only when the user asked for `--fix` or nothing was in the way — a foreign
      // file whose bytes happen to equal the secret used to get chmod'ed to 0600 under the
      // DEFAULT, which is a mutation of someone else's file. It still runs under `overwrite`
      // on purpose: that is what makes `--fix` over boom's own current render a no-op instead
      // of a plaintext-copying displace.
      if (conflict && (await Bun.file(dst).text()) === r.value) {
        if (((await stat(dst)).mode & 0o777) === mode) {
          report.skip(`${disp} already current`);
        } else {
          await chmod(dst, mode);
          report.ok(`${disp} mode tightened to 0${mode.toString(8)}`);
        }
        return;
      }
      // One shared helper, not a fourth hand-inlined copy of the invariant — and its
      // `pathExists ? displace : {kind:"remove"}` is exactly this resource's discipline: a fresh
      // render journals a remove-only undo, so boom's own plaintext never reaches the backup
      // tree and the undo is to delete it; an overwrite (only reachable under `--fix`, and only for
      // content that actually differs) displaces first, because that file is the user's, not
      // something boom put there. The whole undo record lands BEFORE the write either way.
      await journalWrite("secret", dst, ctx);
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
        // --fix, not a plain source: after this layer a plain `boom source` leaves an existing
        // file alone, so it would never reach the chmod that fixes this.
        report.warn(
          `${disp} mode 0${curMode.toString(8)}, expected 0${mode.toString(8)} — run: boom source --fix`,
        );
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
      // Same reason as the mode warning above: refreshing a stale secret now means replacing a
      // file that already exists, which only `--fix` does. The not-rendered warning at the top
      // of this arm stays on plain `boom source` — a first render clobbers nothing.
      else report.warn(`${disp} secret stale — run: boom source --fix`);
      return;
    }
    case "uninstall": {
      if (!(await pathExists(dst))) return;
      if (ctx.dryRun) report.note(`would remove ${disp}`);
      else {
        // Deliberately a plain rm, NOT journalRemove — the one resource that must not route
        // through it. Every other uninstall arm now displaces into the run's backup tree so
        // what it removes stays recoverable; doing that here would write the rendered plaintext to disk
        // under `backups/<run-id>/` and leave it there, which is exactly the persistence this
        // file's header discipline exists to prevent. A secret is re-renderable from its
        // backend, so it needs no backup: `boom source` puts it back.
        await rm(dst, { force: true });
        report.ok(`${disp} removed`);
      }
      return;
    }
  }
}
