// The `pkg` resource: satisfy a package manager. One array entry per manager, dispatched
// here — so a new manager is one `case` plus one picklist member in the schema, not a fresh
// top-level section key + registry row. Three are supported, and the schema's picklist
// (`brew|mise|gh`, config/schema.ts) is the list: `brew bundle`, `mise install`, and
// `gh extension`. Shells out to the stock tools ("native over special"); an absent tool is
// reported, not fatal — matching engine/run.
import { join } from "node:path";
import { detectOs } from "../../config/profile.ts";
import type { Pkg } from "../../config/schema.ts";
import type { Env } from "../../lib/paths.ts";
import { captureArgv, hasCommand, lastLine, runArgvAsync, toolIo } from "../../lib/proc.ts";
import type { ReconcileCtx } from "../types.ts";

export async function reconcilePkg(entry: Pkg, ctx: ReconcileCtx): Promise<void> {
  switch (entry.manager) {
    case "brew":
      return reconcileBrew(entry.file ?? "Brewfile", entry.cleanup, ctx);
    case "mise":
      return reconcileMise(ctx);
    // The whole `entry` goes down (not just `file`) so the arm can read `remove_on_uninstall`;
    // the narrowed manager literal still rides alongside it, because that is what keys the typed
    // USER_MGR lookup.
    case "gh":
      return reconcileUserPkgs(entry.manager, entry, ctx);
  }
}

// Can this Brewfile pull `sudo` into a Bundle run? Only a cask can: its `launchctl`/`pkgutil`
// stanzas escalate, and cask installation is what creates the Caskroom. A formula-only Brewfile
// never prompts, so it keeps the animated spinner rather than permanently wearing a "may ask for
// your password" line that will never come true — a warning that cries wolf on every sync teaches
// people to ignore it. An unreadable Brewfile assumes it *can* escalate: guessing wrong in that
// direction costs a persistent line, guessing wrong the other way restores the invisible hang.
async function declaresCask(brewfile: string): Promise<boolean> {
  try {
    return /^\s*cask\s/m.test(await Bun.file(brewfile).text());
  } catch {
    return true;
  }
}

// Tell sudo who is asking and why. `SUDO_PROMPT` replaces the bare "Password:" — which, arriving
// mid-run with no referent, is indistinguishable from any other program on the machine deciding to
// ask. sudo reads this from the invoking environment and it survives into a tool's own sudo calls
// (Homebrew execs /usr/bin/sudo with -E and never scrubs it), so one variable relabels every prompt
// the step can produce. `%p` is sudo's escape for the user whose password is wanted — the only
// substitution worth having here; sudoers' escape set has nothing for the command, which is exactly
// why the *what* has to come from the tool's own output instead (see relayProgress).
function sudoPrompt(what: string): string {
  return `[boom] ${what} needs administrator rights — password for %p: `;
}

// Relay a tool's progress headers as live boom lines, so the thing directly above a password prompt
// says what is about to escalate. Homebrew prefixes every headline with "==>"
// (Library/Homebrew/utils/formatter.rb) — "==> Upgrading cask tuple" is precisely the answer to
// "what is asking?", and piping stdout strips its colors, so the match stays a plain prefix test.
// Everything else brew says (download byte counts, pour progress) stays hidden under the band.
function relayProgress(ctx: ReconcileCtx): ((line: string) => void) | undefined {
  if (ctx.json || ctx.verbose) return undefined; // envelope stays clean; verbose already streams it
  return (line) => {
    const m = /^==>\s+(.*\S)/.exec(line);
    if (m?.[1]) ctx.report.live(m[1]);
  };
}

// What `brew bundle cleanup` would remove: the installed-but-undeclared set. Without `--force`
// it only LISTS, which is what makes `cleanup = "check"` safe to run on every verify.
//
// Parsed rather than trusted to exit code: `brew bundle cleanup` exits 0 whether or not it found
// anything, so the presence of output is the signal. Lines look like "Would uninstall formulae:"
// followed by names, so anything non-empty means drift.
async function brewCleanupList(path: string, env: Env): Promise<string[]> {
  const r = captureArgv(["brew", "bundle", "cleanup", `--file=${path}`], env);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.endsWith(":"));
}

async function reconcileBrew(
  file: string,
  cleanup: "check" | "uninstall" | undefined,
  ctx: ReconcileCtx,
): Promise<void> {
  const { report } = ctx;
  if (!hasCommand("brew", ctx.env)) {
    // A dry run changes nothing and cannot install anything, so an absent package manager is a
    // fact about THIS machine rather than a defect in the config. Failing here made `--dry-run`
    // unusable as a config validator anywhere the manager is missing — a CI runner, a fresh
    // box, a Linux checkout of a macOS config — which is exactly where you most want to preview
    // a boomfile before trusting it. `verify` still fails: there, a missing brew IS drift.
    if (ctx.dryRun) {
      report.skip("brew not installed — cannot preview its plan");
      return;
    }
    report.fail("brew not installed");
    return;
  }
  // argv array, not a shell string: a repo path with a space or quote is just an argument
  // here, never re-parsed by sh.
  const path = join(ctx.repo, file);
  // ALWAYS `--no-upgrade`, on every verb. Homebrew Bundle upgrades outdated packages by default,
  // and that governs *casks* as well as formulae: observed on Homebrew 6.0.12, dropping the flag
  // had Bundle run `brew upgrade --cask` on an outdated cask that set no `greedy: true` in the
  // Brewfile and is `auto_updates: true` — so `greedy` is not the opt-out it reads as (this
  // comment used to claim it was, and that cost a ten-minute mystery hang). Upgrading a cask
  // replaces the `.app`, so Homebrew quits the running program to do it. **A reconcile that
  // closes your browser is not a reconcile**, so boom no longer has a way to ask for one:
  // `boom source --update` opted into exactly this and is gone in 0.38. Upgrading is
  // `brew upgrade --formula` and `mise upgrade` — each its own tool's verb, with a blast radius
  // that tool defines, and neither one boom has to hold a second opinion about.
  // See docs/MIGRATING-0.38.md.
  //
  // Cask *installation* still escalates — a `launchctl`/`pkgutil` stanza reaches for `sudo` the
  // first time a cask lands, which is why the prompt machinery below is not going anywhere. See
  // `withAskpass` for what happens when the caller has exported SUDO_ASKPASS.
  switch (ctx.verb) {
    case "sync": {
      if (ctx.dryRun) {
        report.plan(`would run: brew bundle --file=${path} --no-upgrade`);
        return;
      }
      {
        // Bundle may want the terminal for a password when a cask is in play — unless an askpass
        // helper is answering for it, in which case nothing will prompt and the animated spinner is
        // safe. SUDO_ASKPASS is sudo's own variable: boom no longer installs a helper of its own,
        // but it still reads one the user has exported, so the presentation follows whatever is
        // actually going to happen.
        const mayPrompt = !ctx.env.SUDO_ASKPASS && (await declaresCask(path));
        // When a prompt is possible, name the asker: label the prompt itself via SUDO_PROMPT, and
        // relay Homebrew's own "==> …" headers so the line above it says which cask is escalating.
        // Neither is worth doing when a shim is answering — nothing will ask.
        const env = mayPrompt ? { ...ctx.env, SUDO_PROMPT: sudoPrompt("brew bundle") } : ctx.env;
        const r = await report.spin(
          "brew bundle",
          () =>
            runArgvAsync(["brew", "bundle", `--file=${path}`, "--no-upgrade"], env, {
              ...toolIo(ctx.json, ctx.verbose),
              ...(mayPrompt ? { onStdoutLine: relayProgress(ctx) } : {}),
            }),
          { mayPrompt },
        );
        if (r.code === 0) report.skip("brew bundle satisfied");
        else report.fail(`brew bundle failed${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ""}`);
      }
      if (cleanup) {
        const extra = await brewCleanupList(path, ctx.env);
        if (extra.length === 0) {
          report.skip("brew bundle cleanup: nothing undeclared");
        } else if (cleanup === "check") {
          // `check` never removes, on either verb. Naming them on sync too is the point: this is
          // where you find out the list is longer than you thought, while it is still only a list.
          report.warn(`${extra.length} installed but undeclared: ${extra.join(", ")}`);
        } else {
          const c = await report.spin("brew bundle cleanup", () =>
            runArgvAsync(
              ["brew", "bundle", "cleanup", `--file=${path}`, "--force"],
              ctx.env,
              toolIo(ctx.json, ctx.verbose),
            ),
          );
          if (c.code === 0) report.ok(`removed ${extra.length} undeclared: ${extra.join(", ")}`);
          else
            report.fail(`brew bundle cleanup failed${lastLine(c.stderr) ? `: ${lastLine(c.stderr)}` : ""}`);
        }
      }
      return;
    }
    case "verify": {
      // Mirrors sync's --no-upgrade: otherwise a plain `verify` would flag merely-outdated
      // (but still declared) packages as drift that `boom source` then won't reconcile, since
      // sync never upgrades. Drift is "declared and not installed", never "installed and old".
      const check = await report.spin("brew bundle check", () =>
        runArgvAsync(
          ["brew", "bundle", "check", `--file=${path}`, "--no-upgrade"],
          ctx.env,
          toolIo(ctx.json, ctx.verbose),
        ),
      );
      if (check.code === 0) report.skip("brew bundle satisfied");
      else report.warn("brew bundle missing deps — run: boom source");
      // The other direction, and the one `brew bundle check` structurally cannot see: it asks
      // "is everything declared installed?", never "is everything installed declared?". So a
      // package added by hand is invisible to it forever, and a fresh machine reproduces the
      // machine minus that package — which is the drift that only shows up when you need the box
      // you no longer have.
      if (cleanup) {
        const extra = await brewCleanupList(path, ctx.env);
        if (extra.length === 0) report.skip("brew bundle cleanup: nothing undeclared");
        else if (cleanup === "uninstall")
          report.warn(`${extra.length} installed but undeclared — boom source removes: ${extra.join(", ")}`);
        else report.warn(`${extra.length} installed but undeclared: ${extra.join(", ")}`);
      }
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

// Parse a newline-separated package list: one name per line, `#` comments and blank lines
// dropped. The declarative form of a package list piped into an installer.
async function readPackages(file: string, ctx: ReconcileCtx): Promise<string[]> {
  const text = await Bun.file(join(ctx.repo, file)).text();
  return text
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter((l) => l.length > 0);
}

// The user-scoped managers: they read a newline package list and install into the *user*
// toolchain (no sudo, not the OS package set). `gh` is the only one today; the table shape is
// kept because it is what makes adding a second one a data change rather than a code change.
// Two query disciplines are supported: a per-package "is it installed" probe whose exit code is
// the answer, or — for a tool with no such probe — one list command parsed into an installed set
// and membership-tested. `gh extension list` is the list-parsing kind.
type UserMgrName = "gh";

// A per-package probe (its exit code is the answer) vs. a one-shot list parsed into an installed
// set (for tools with no per-package query). `parse` returns the set of installed package names.
type PkgQuery =
  | { readonly each: (p: string) => string[] }
  | { readonly list: string[]; readonly parse: (out: string) => Set<string> };

interface UserMgr {
  readonly cli: string;
  // A manager that only exists on Linux is a reported no-op on mac rather than a failure. No
  // current entry sets it; it is the hook a Linux-only manager would need.
  readonly linuxOnly?: boolean;
  readonly install: string[]; // base argv; the package name is appended
  readonly uninstall: string[]; // base argv; the package name is appended
  // How a declared entry is spelled in the query set. `gh` lowercases: GitHub treats `owner/repo`
  // case-insensitively, so a declaration that differs only in case would otherwise miss the
  // installed set and reinstall on every sync — precisely the non-idempotence this arm exists to fix.
  readonly key?: (declared: string) => string;
  // What the uninstall argv takes, when it isn't what `install` took. `gh extension remove` wants
  // the bare extension *name* (`stack`), never the `owner/repo` that installed it.
  readonly uninstallArg?: (declared: string) => string;
  readonly query: PkgQuery;
}

// The `owner/repo` column of `gh extension list`. There is no `--json` for this command, and piped
// (which is how captureArgv reads it) gh prints one TSV row per extension —
// "gh stack\tgithub/gh-stack\tv0.1.0" — so the repo is picked **by shape** (the only token holding
// a `/`) rather than by column index, which survives padding and column-order churn. With nothing
// installed gh prints nothing and exits non-zero; the list-query call site ignores the exit code and
// parses stdout, so that lands as the empty set. The query is local (it reads the extensions dir):
// no network, no auth, so verify stays cheap and offline.
const isRepoRef = (token: string): boolean => token.includes("/");

function ghExtensions(out: string): Set<string> {
  const repos = new Set<string>();
  for (const line of out.split("\n")) {
    const repo = line.trim().split(/\s+/).find(isRepoRef);
    if (repo) repos.add(repo.toLowerCase());
  }
  return repos;
}

const USER_MGR: Record<UserMgrName, UserMgr> = {
  gh: {
    cli: "gh",
    install: ["gh", "extension", "install"],
    uninstall: ["gh", "extension", "remove"],
    // github/gh-stack → stack: gh strips the conventional `gh-` prefix when it names the command.
    uninstallArg: (p) => (p.split("/").pop() ?? p).replace(/^gh-/, ""),
    key: (p) => p.toLowerCase(),
    query: { list: ["gh", "extension", "list"], parse: ghExtensions },
  },
};

async function reconcileUserPkgs(mgr: UserMgrName, entry: Pkg, ctx: ReconcileCtx): Promise<void> {
  const { report } = ctx;
  const { file } = entry;
  const spec = USER_MGR[mgr];

  // A Linux-only manager on a mac is a reported no-op, not a fail.
  if (spec.linuxOnly && detectOs(ctx.env) !== "linux") {
    if (ctx.verb === "verify") report.skip(`${mgr} — Linux-only`);
    return;
  }
  if (!file) {
    report.fail(`${mgr} pkg requires a \`file\` listing packages`);
    return;
  }
  if (!hasCommand(spec.cli, ctx.env)) {
    // Same reasoning as brew above: a dry run cannot install, so an absent CLI is machine state.
    if (ctx.dryRun) {
      report.skip(`${spec.cli} not installed — cannot preview its plan`);
      return;
    }
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
  // output into a set (this is `gh`'s discipline); an `each` manager probes each name's exit code.
  const q = spec.query;
  const installed = "list" in q ? q.parse(captureArgv([...q.list], ctx.env).stdout) : undefined;
  // `key` normalizes a declared entry into the spelling the parsed set uses (gh: case-folded).
  // Only the list discipline needs it — the `each` probes hand the name straight to the tool.
  const norm = spec.key ?? ((p: string) => p);
  const isInstalled = (p: string): boolean =>
    installed
      ? installed.has(norm(p))
      : captureArgv((q as { each: (p: string) => string[] }).each(p), ctx.env).code === 0;

  switch (ctx.verb) {
    case "sync": {
      // These managers reinstall a package even when it's current, rather than treating an
      // already-satisfied name as a no-op, so install only the misses.
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
      // The opt-*out* direction: these managers reclaim by default, so `= false` is how you keep a
      // global tool boom installed but doesn't own the lifecycle of (an editor's language server
      // the rest of your shell depends on, say). Only an explicit `false` opts out — an absent key
      // is today's behavior, unchanged.
      if (entry.remove_on_uninstall === false) {
        report.skip(`${mgr}: kept (remove_on_uninstall = false)`);
        return;
      }
      // These user-scoped managers can cleanly remove what boom installed (unlike system packages,
      // which survive uninstall by default), so uninstall reverses the declared set.
      const present = packages.filter((p) => isInstalled(p));
      if (present.length === 0) {
        report.skip(`${mgr}: nothing to remove`);
        return;
      }
      // The removal argv can spell a package differently from the one that installed it (gh:
      // `remove stack` undoes `install github/gh-stack`). Resolve it once so the dry-run plan
      // prints the command that would actually run, rather than a plausible-looking near miss.
      const arg = spec.uninstallArg ?? ((p: string) => p);
      if (ctx.dryRun) {
        report.plan(`would run: ${spec.uninstall.join(" ")} ${present.map(arg).join(" ")}`);
        return;
      }
      for (const p of present) {
        const r = await report.spin(`${mgr} uninstall ${p}`, () =>
          runArgvAsync([...spec.uninstall, arg(p)], ctx.env, toolIo(ctx.json, ctx.verbose)),
        );
        if (r.code === 0) report.ok(`${mgr}: removed ${p}`);
        else
          report.fail(`${mgr} uninstall ${p} failed${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ""}`);
      }
      return;
    }
  }
}
