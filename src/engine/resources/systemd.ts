// The `systemd` resource: the Linux twin of `launchd`. Where launchd links a user-authored
// plist, systemd *renders* a `.service` (and, when `timer` is set, a `.timer`) unit from the
// boomfile stanza and writes it into ~/.config/systemd/user under the same journaled-mutation
// discipline the filesystem + `[boom]` scheduler resources use (so rollback reverses it like
// any file write), then owns the unit's `systemctl --user` lifecycle on top: daemon-reload +
// enable --now on sync, disable --now + remove on uninstall. The rendered text is
// deterministic, so an unchanged stanza re-renders byte-identical and sync is a no-op.
// OS-gated to linux; a missing `systemctl` is a reported failure, not a throw.
import { dirname, join } from "node:path";
import { detectOs } from "../../config/profile.ts";
import type { Systemd } from "../../config/schema.ts";
import { displayPath, mkdir, pathExists } from "../../lib/fs.ts";
import { captureArgv, type Env, hasCommand } from "../../lib/proc.ts";
import { displace, type UndoToken } from "../journal.ts";
import type { ReconcileCtx } from "../types.ts";

// ~/.config/systemd/user — where per-user units live (honoring XDG_CONFIG_HOME). Undefined
// without a resolvable config home, so a caller can refuse rather than write to a relative path.
function userUnitDir(env: Env): string | undefined {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : undefined);
  return base ? join(base, "systemd", "user") : undefined;
}

// Render a minimal, well-formed user `.service` unit. Deterministic — env vars are emitted in
// sorted key order — so an unchanged stanza re-renders byte-identical and the sync is a no-op.
function renderService(entry: Systemd): string {
  const lines = [
    "[Unit]",
    `Description=${entry.description ?? entry.name}`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${entry.exec}`,
  ];
  for (const key of Object.keys(entry.env ?? {}).sort()) lines.push(`Environment=${key}=${entry.env?.[key]}`);
  lines.push("", "[Install]", "WantedBy=default.target", "");
  return lines.join("\n");
}

// Render the companion `.timer` unit when the stanza schedules the service. Persistent=true so
// a run missed while the machine was off fires at next boot, matching launchd's catch-up feel.
function renderTimer(entry: Systemd): string {
  return [
    "[Unit]",
    `Description=${entry.description ?? entry.name} timer`,
    "",
    "[Timer]",
    `OnCalendar=${entry.timer}`,
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

// captureArgv (not runArgv): it maps a missing/erroring `systemctl` onto a failed result
// instead of throwing, so a stripped env degrades to "enable failed" rather than crashing the
// reconcile. The command gate above already rejects the truly-absent case; this covers the rest.
function systemctl(args: string[], env: Env): number {
  return captureArgv(["systemctl", "--user", ...args], env).code;
}

interface Unit {
  readonly name: string; // e.g. "backup.service"
  readonly path: string;
  readonly text: string;
}

// Journal + write a unit file, but only when its content actually changed (byte-identical →
// skip, keeping an unchanged sync a true no-op). The undo token is recorded BEFORE the write
// (displaced original into the backup tree, or a plain remove for a fresh file) so a crash
// mid-write is still reversible — the filesystem resource's undo-before-create discipline.
async function writeUnit(unit: Unit, ctx: ReconcileCtx): Promise<boolean> {
  if ((await pathExists(unit.path)) && (await Bun.file(unit.path).text()) === unit.text) return false;
  await ctx.journal?.intent("systemd", unit.path);
  const undo: UndoToken = (await pathExists(unit.path))
    ? await displace(unit.path, ctx.backupRoot)
    : { kind: "remove" };
  await mkdir(dirname(unit.path), { recursive: true });
  await Bun.write(unit.path, unit.text);
  await ctx.journal?.done("systemd", unit.path, undo);
  return true;
}

export async function reconcileSystemd(entry: Systemd, ctx: ReconcileCtx): Promise<void> {
  const { report } = ctx;
  const dir = userUnitDir(ctx.env);
  if (!dir) {
    report.skip(`systemd ${entry.name} — HOME unset, can't resolve the user unit dir`);
    return;
  }

  if (detectOs(ctx.env) !== "linux") {
    // Non-linux: systemd user units don't exist. Report on verify so a Linux-only unit doesn't
    // silently pass on macOS, but don't fail — the section may legitimately target both.
    if (ctx.verb === "verify") report.skip(`systemd ${entry.name} — systemd is Linux-only`);
    return;
  }
  if (!hasCommand("systemctl", ctx.env)) {
    report.fail(`systemd ${entry.name} — systemctl not found`);
    return;
  }

  // The unit files this stanza owns: always the service; the timer too when scheduled. When a
  // timer is set it (not the service) is the unit that gets enabled — the timer pulls the
  // service in on its schedule.
  const service: Unit = {
    name: `${entry.name}.service`,
    path: join(dir, `${entry.name}.service`),
    text: renderService(entry),
  };
  const units: Unit[] = [service];
  if (entry.timer)
    units.push({
      name: `${entry.name}.timer`,
      path: join(dir, `${entry.name}.timer`),
      text: renderTimer(entry),
    });
  const primary = entry.timer ? `${entry.name}.timer` : `${entry.name}.service`;
  const enable = entry.enable !== false;
  const disp = displayPath(service.path, ctx.env);

  switch (ctx.verb) {
    case "sync": {
      if (ctx.dryRun) {
        report.plan(`would install ${primary}${enable ? " + enable" : ""}`);
        return;
      }
      let changed = false;
      for (const u of units) if (await writeUnit(u, ctx)) changed = true;
      // A daemon-reload picks up written/changed units; harmless (and cheap) when nothing moved.
      systemctl(["daemon-reload"], ctx.env);
      if (!enable) {
        report.skip(changed ? `${disp} installed (not enabled)` : `${disp} present`);
        return;
      }
      // enable --now is idempotent, so run it every sync as a steady-state confirmation (like
      // launchd's reload): a change reports ok, an unchanged already-enabled unit is a quiet skip.
      if (systemctl(["enable", "--now", primary], ctx.env) === 0) {
        if (changed) report.ok(`${disp} installed + enabled`);
        else report.skip(`${primary} enabled`);
      } else {
        report.fail(`${disp} written but systemctl enable failed`);
      }
      return;
    }
    case "verify": {
      for (const u of units) {
        const current = (await pathExists(u.path)) ? await Bun.file(u.path).text() : undefined;
        if (current === undefined) {
          report.warn(`${u.name} not installed — sync installs it`);
          return;
        }
        if (current !== u.text) {
          report.warn(`${u.name} outdated — sync refreshes it`);
          return;
        }
      }
      if (enable && systemctl(["is-enabled", primary], ctx.env) !== 0)
        report.warn(`${primary} installed but not enabled`);
      else report.skip(enable ? `${primary} (enabled)` : `${primary} installed`);
      return;
    }
    case "uninstall": {
      // Nothing to do if we never wrote the service.
      if (!(await pathExists(service.path))) return;
      if (ctx.dryRun) {
        report.note(`would disable + remove ${primary}`);
        return;
      }
      // Disable (best-effort — a not-enabled unit is already in the desired state) before
      // removing the files, then journal each removal as a displaced-original restore so
      // rollback can put the unit back.
      systemctl(["disable", "--now", primary], ctx.env);
      for (const u of units) {
        if (!(await pathExists(u.path))) continue;
        await ctx.journal?.intent("systemd-rm", u.path);
        const undo = await displace(u.path, ctx.backupRoot);
        await ctx.journal?.done("systemd-rm", u.path, undo);
      }
      systemctl(["daemon-reload"], ctx.env);
      report.ok(`${primary} disabled + removed`);
      return;
    }
  }
}
