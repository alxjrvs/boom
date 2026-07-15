// The `pkg` resource: satisfy a package manager. One array entry per manager, dispatched
// here — so a new manager is one `case` plus one picklist member in the schema, not a fresh
// top-level section key + registry row. Shells out to the stock tools ("native over
// special"); an absent tool is reported, not fatal — matching engine/run.
import { join } from "node:path";
import { detectOs } from "../../config/profile.ts";
import type { Pkg } from "../../config/schema.ts";
import { captureArgv, hasCommand, runArgv } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

export async function reconcilePkg(entry: Pkg, ctx: ReconcileCtx): Promise<void> {
  switch (entry.manager) {
    case "brew":
      return reconcileBrew(entry.file ?? "Brewfile", ctx);
    case "mise":
      return reconcileMise(ctx);
    case "apt":
      return reconcileLinuxPkgs("apt", entry.file, ctx);
    case "dnf":
      return reconcileLinuxPkgs("dnf", entry.file, ctx);
  }
}

function reconcileBrew(file: string, ctx: ReconcileCtx): void {
  const { report } = ctx;
  if (!hasCommand("brew", ctx.env)) {
    report.fail("brew not installed");
    return;
  }
  // argv array, not a shell string: a repo path with a space or quote is just an argument
  // here, never re-parsed by sh.
  const path = join(ctx.repo, file);
  // Homebrew Bundle upgrades outdated formulae by default — `sync` should only reconcile
  // declared state, not silently upgrade packages as a side effect, so it opts out unless the
  // caller asked for it (`boom source --update`). Casks are unaffected by this flag: Bundle
  // only upgrades a cask when its Brewfile entry sets `greedy: true`, update or not.
  const noUpgrade = ctx.update ? [] : ["--no-upgrade"];
  switch (ctx.verb) {
    case "sync": {
      if (ctx.dryRun) {
        report.plan(`would run: brew bundle --file=${path}${ctx.update ? "" : " --no-upgrade"}`);
        return;
      }
      if (
        runArgv(["brew", "bundle", `--file=${path}`, ...noUpgrade], ctx.env, { quietStdout: ctx.json })
          .code === 0
      )
        report.skip("brew bundle satisfied");
      else report.fail("brew bundle failed");
      return;
    }
    case "verify": {
      // Mirrors sync's --no-upgrade gate: otherwise a plain `verify` would flag
      // merely-outdated (but still declared) formulae as drift that `boom source` then
      // won't reconcile, since sync itself no longer upgrades by default.
      if (
        runArgv(["brew", "bundle", "check", `--file=${path}`, ...noUpgrade], ctx.env, {
          quietStdout: ctx.json,
        }).code === 0
      )
        report.skip("brew bundle satisfied");
      else report.warn("brew bundle missing deps — run: boom source");
      return;
    }
    case "uninstall":
      return; // brew packages survive uninstall (matches the bash engine)
  }
}

function reconcileMise(ctx: ReconcileCtx): void {
  const { report } = ctx;
  if (!hasCommand("mise", ctx.env)) return;
  switch (ctx.verb) {
    case "sync": {
      if (ctx.dryRun) {
        report.plan("would run: mise install");
        return;
      }
      // Run from the repo (cwd-independent sync), so mise resolves the repo's `mise.toml`
      // instead of whatever project tree `boom` was invoked from.
      if (runArgv(["mise", "install"], ctx.env, { quietStdout: ctx.json, cwd: ctx.repo }).code === 0)
        report.skip("mise tools installed");
      else report.fail("mise install failed");
      return;
    }
    case "verify": {
      // `mise install` is idempotent, so "present" told us nothing about drift. Ask mise
      // what's declared-but-not-installed: `mise ls --missing` lists those tools and still
      // exits 0, so the missing-tool signal is its stdout, not its code. captureArgv (not a
      // raw Bun.spawnSync) keeps the trim + throw-safety in one place.
      const r = captureArgv(["mise", "ls", "--missing"], ctx.env, { cwd: ctx.repo });
      if (r.code === 0 && r.stdout === "") report.skip("mise tools installed");
      else report.warn("mise tools missing — run: boom source");
      return;
    }
    case "uninstall":
      return;
  }
}

// The two system package managers differ only in their CLI and installed-query verb. Both
// need root to install, so the argv is prefixed with `sudo` — a boom on a Linux dev box is
// assumed to have passwordless sudo like every other system-touching step; a sudo that
// prompts and fails is reported, not silently swallowed.
const LINUX_MGR = {
  apt: {
    cli: "apt-get",
    install: ["sudo", "apt-get", "install", "-y"],
    query: (p: string) => ["dpkg", "-s", p],
  },
  dnf: { cli: "dnf", install: ["sudo", "dnf", "install", "-y"], query: (p: string) => ["rpm", "-q", p] },
} as const;

// Parse a newline-separated package list: one name per line, `#` comments and blank lines
// dropped. The declarative form of `xargs apt-get install < packages.txt`.
async function readPackages(file: string, ctx: ReconcileCtx): Promise<string[]> {
  const text = await Bun.file(join(ctx.repo, file)).text();
  return text
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter((l) => l.length > 0);
}

async function reconcileLinuxPkgs(
  mgr: "apt" | "dnf",
  file: string | undefined,
  ctx: ReconcileCtx,
): Promise<void> {
  const { report } = ctx;
  const { cli, install, query } = LINUX_MGR[mgr];

  // OS-gated like osx/launchd: a Linux-only manager on a mac is a no-op (reported on verify so
  // a cross-platform section doesn't silently pass), not a failure.
  if (detectOs(ctx.env) !== "linux") {
    if (ctx.verb === "verify") report.skip(`${mgr} — Linux-only`);
    return;
  }
  if (!file) {
    report.fail(`${mgr} pkg requires a \`file\` listing packages`);
    return;
  }
  if (!hasCommand(cli, ctx.env)) {
    report.fail(`${cli} not installed`);
    return;
  }

  let packages: string[];
  try {
    packages = await readPackages(file, ctx);
  } catch (e) {
    report.fail(`${mgr} package list ${file}: ${(e as Error).message}`);
    return;
  }
  if (packages.length === 0) {
    report.skip(`${mgr} — no packages listed in ${file}`);
    return;
  }

  switch (ctx.verb) {
    case "sync": {
      if (ctx.dryRun) {
        report.plan(`would run: ${install.join(" ")} ${packages.join(" ")}`);
        return;
      }
      if (runArgv([...install, ...packages], ctx.env, { quietStdout: ctx.json }).code === 0)
        report.skip(`${mgr}: ${packages.length} package(s) satisfied`);
      else report.fail(`${mgr} install failed`);
      return;
    }
    case "verify": {
      // Query each package's installed state; the manager's query exits non-zero for a
      // missing package. Collect the misses so the report names what's actually absent.
      const missing = packages.filter((p) => captureArgv(query(p), ctx.env).code !== 0);
      if (missing.length === 0) report.skip(`${mgr}: ${packages.length} package(s) installed`);
      else report.warn(`${mgr} missing: ${missing.join(", ")} — run: boom source`);
      return;
    }
    case "uninstall":
      return; // system packages survive uninstall, like brew
  }
}
