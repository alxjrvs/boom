// The `pkg` resource: satisfy a package manager. One array entry per manager, dispatched
// here — so a new manager is one `case` plus one picklist member in the schema, not a fresh
// top-level section key + registry row. Shells out to the stock tools ("native over
// special"); an absent tool is reported, not fatal — matching engine/run.
import { join } from "node:path";
import { detectOs } from "../../config/profile.ts";
import type { Pkg } from "../../config/schema.ts";
import { captureArgv, hasCommand, lastLine, runArgvAsync, toolIo } from "../../lib/proc.ts";
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
    case "cargo":
    case "npm":
    case "pipx":
    case "gem":
    case "flatpak":
      return reconcileUserPkgs(entry.manager, entry.file, ctx);
  }
}

async function reconcileBrew(file: string, ctx: ReconcileCtx): Promise<void> {
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
      {
        const r = await report.spin("brew bundle", () =>
          runArgvAsync(
            ["brew", "bundle", `--file=${path}`, ...noUpgrade],
            ctx.env,
            toolIo(ctx.json, ctx.verbose),
          ),
        );
        if (r.code === 0) report.skip("brew bundle satisfied");
        else report.fail(`brew bundle failed${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ""}`);
      }
      return;
    }
    case "verify": {
      // Mirrors sync's --no-upgrade gate: otherwise a plain `verify` would flag
      // merely-outdated (but still declared) formulae as drift that `boom source` then
      // won't reconcile, since sync itself no longer upgrades by default.
      const check = await report.spin("brew bundle check", () =>
        runArgvAsync(
          ["brew", "bundle", "check", `--file=${path}`, ...noUpgrade],
          ctx.env,
          toolIo(ctx.json, ctx.verbose),
        ),
      );
      if (check.code === 0) report.skip("brew bundle satisfied");
      else report.warn("brew bundle missing deps — run: boom source");
      return;
    }
    case "uninstall":
      return; // brew packages survive uninstall (matches the bash engine)
  }
}

async function reconcileMise(ctx: ReconcileCtx): Promise<void> {
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
      {
        const r = await report.spin("mise install", () =>
          runArgvAsync(["mise", "install"], ctx.env, { ...toolIo(ctx.json, ctx.verbose), cwd: ctx.repo }),
        );
        if (r.code === 0) report.skip("mise tools installed");
        else report.fail(`mise install failed${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ""}`);
      }
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
      {
        const r = await report.spin(`${mgr} install`, () =>
          runArgvAsync([...install, ...packages], ctx.env, toolIo(ctx.json, ctx.verbose)),
        );
        if (r.code === 0) report.skip(`${mgr}: ${packages.length} package(s) satisfied`);
        else report.fail(`${mgr} install failed${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ""}`);
      }
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

// The user-scoped managers: like apt/dnf they read a newline package list, but install into the
// *user* toolchain (no sudo, not the OS package set) — a language/app installer per manager. Two
// query disciplines: most expose a per-package "is it installed" probe whose exit code is the
// answer; cargo and pipx have no per-package query, so their installed set is parsed once from a
// list command and membership-tested. Every command shape mirrors adopt.ts's OTHER_MANAGERS so
// detection (`boom adopt`) and management (`boom sync`) agree on the exact CLIs.
type UserMgrName = "cargo" | "npm" | "pipx" | "gem" | "flatpak";

// A per-package probe (its exit code is the answer) vs. a one-shot list parsed into an installed
// set (for tools with no per-package query). `parse` returns the set of installed package names.
type PkgQuery =
  | { readonly each: (p: string) => string[] }
  | { readonly list: string[]; readonly parse: (out: string) => Set<string> };

interface UserMgr {
  readonly cli: string;
  // OS-gated like the Linux system managers: flatpak is a Linux desktop runtime, a no-op on mac.
  readonly linuxOnly?: boolean;
  readonly install: string[]; // base argv; the package name is appended
  readonly uninstall: string[]; // base argv; the package name is appended
  readonly query: PkgQuery;
}

// The first whitespace token of every non-indented line — the name column of `cargo install --list`
// ("ripgrep v13.0.0:" → "ripgrep") and `pipx list --short` ("black 24.1.0" → "black").
function firstTokens(out: string): Set<string> {
  const names = new Set<string>();
  for (const line of out.split("\n")) {
    if (!/^\S/.test(line)) continue; // indented lines are a crate's binaries / a detail row
    const name = line.trim().split(/\s+/)[0];
    if (name) names.add(name);
  }
  return names;
}

const USER_MGR: Record<UserMgrName, UserMgr> = {
  cargo: {
    cli: "cargo",
    install: ["cargo", "install"],
    uninstall: ["cargo", "uninstall"],
    query: { list: ["cargo", "install", "--list"], parse: firstTokens },
  },
  npm: {
    cli: "npm",
    install: ["npm", "install", "-g"],
    uninstall: ["npm", "rm", "-g"],
    query: { each: (p) => ["npm", "ls", "-g", "--depth=0", p] },
  },
  pipx: {
    cli: "pipx",
    install: ["pipx", "install"],
    uninstall: ["pipx", "uninstall"],
    query: { list: ["pipx", "list", "--short"], parse: firstTokens },
  },
  gem: {
    cli: "gem",
    install: ["gem", "install"],
    // -a removes every version, -x its executables — so uninstall is non-interactive (a bare
    // `gem uninstall` prompts when multiple versions are installed).
    uninstall: ["gem", "uninstall", "-a", "-x"],
    query: { each: (p) => ["gem", "list", "-i", p] },
  },
  flatpak: {
    cli: "flatpak",
    linuxOnly: true,
    install: ["flatpak", "install", "-y"],
    uninstall: ["flatpak", "uninstall", "-y"],
    query: { each: (p) => ["flatpak", "info", p] },
  },
};

async function reconcileUserPkgs(
  mgr: UserMgrName,
  file: string | undefined,
  ctx: ReconcileCtx,
): Promise<void> {
  const { report } = ctx;
  const spec = USER_MGR[mgr];

  // OS-gated like the apt/dnf arm: a Linux-only manager on a mac is a reported no-op, not a fail.
  if (spec.linuxOnly && detectOs(ctx.env) !== "linux") {
    if (ctx.verb === "verify") report.skip(`${mgr} — Linux-only`);
    return;
  }
  if (!file) {
    report.fail(`${mgr} pkg requires a \`file\` listing packages`);
    return;
  }
  if (!hasCommand(spec.cli, ctx.env)) {
    report.fail(`${spec.cli} not installed`);
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

  // Resolve "is this package installed" once per run: a list-query manager parses one command's
  // output into a set (cargo/pipx have no per-package probe); the rest probe each name's exit code.
  const q = spec.query;
  const installed = "list" in q ? q.parse(captureArgv([...q.list], ctx.env).stdout) : undefined;
  const isInstalled = (p: string): boolean =>
    installed
      ? installed.has(p)
      : captureArgv((q as { each: (p: string) => string[] }).each(p), ctx.env).code === 0;

  switch (ctx.verb) {
    case "sync": {
      // Unlike apt's batched, idempotent `install <all>`, these managers reinstall/rebuild a
      // package even when it's current (an expensive no-op for cargo), so install only the misses.
      const missing = packages.filter((p) => !isInstalled(p));
      if (missing.length === 0) {
        report.skip(`${mgr}: ${packages.length} package(s) satisfied`);
        return;
      }
      if (ctx.dryRun) {
        report.plan(`would run: ${spec.install.join(" ")} ${missing.join(" ")}`);
        return;
      }
      // One invocation per package (these installers take a single name), so one failure is
      // reported for that package without aborting the rest.
      let failed = 0;
      for (const p of missing) {
        const r = await report.spin(`${mgr} install ${p}`, () =>
          runArgvAsync([...spec.install, p], ctx.env, toolIo(ctx.json, ctx.verbose)),
        );
        if (r.code !== 0) {
          failed++;
          report.fail(`${mgr} install ${p} failed${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ""}`);
        }
      }
      if (failed < missing.length) report.ok(`${mgr}: installed ${missing.length - failed} package(s)`);
      return;
    }
    case "verify": {
      const missing = packages.filter((p) => !isInstalled(p));
      if (missing.length === 0) report.skip(`${mgr}: ${packages.length} package(s) installed`);
      else report.warn(`${mgr} missing: ${missing.join(", ")} — run: boom source`);
      return;
    }
    case "uninstall": {
      // These user-scoped managers can cleanly remove what boom installed (unlike system packages,
      // which survive uninstall), so uninstall reverses the declared set.
      const present = packages.filter((p) => isInstalled(p));
      if (present.length === 0) {
        report.skip(`${mgr}: nothing to remove`);
        return;
      }
      if (ctx.dryRun) {
        report.plan(`would run: ${spec.uninstall.join(" ")} ${present.join(" ")}`);
        return;
      }
      for (const p of present) {
        const r = await report.spin(`${mgr} uninstall ${p}`, () =>
          runArgvAsync([...spec.uninstall, p], ctx.env, toolIo(ctx.json, ctx.verbose)),
        );
        if (r.code === 0) report.ok(`${mgr}: removed ${p}`);
        else
          report.fail(`${mgr} uninstall ${p} failed${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ""}`);
      }
      return;
    }
  }
}
