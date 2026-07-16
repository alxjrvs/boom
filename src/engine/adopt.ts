// `boom adopt` — the reverse of reconcile: read an already-configured machine and emit a
// reviewable boomfile.toml + supporting files, so the cold-start problem (author a whole config
// from a blank file) becomes "review what boom found." It reuses the same tools the `pkg`/`link`
// resources shell out to, run in the other direction: `brew bundle dump` for packages, `mise
// current` for tool versions, and a curated sweep of common top-level dotfiles.
//
// The output is a *proposal* written to a fresh directory (default ./boom-config) — never the
// live machine, never auto-committed. What boom can't infer from the outside (which macOS
// defaults you changed from their factory value; whole `~/.config` trees) is left as a scaffold
// comment for the user, rather than guessed at.
import { join, resolve } from "node:path";
import type { BoomContext } from "../context.ts";
import { copyFile, linkTarget, mkdir, pathExists, stat } from "../lib/fs.ts";
import { captureArgv, captureArgvAsync, hasCommand } from "../lib/proc.ts";
import { bandsReporter, type Reporter } from "../lib/reporter.ts";
import { findImporter, type ImportedEntry, importerNames } from "./importers.ts";

// Common top-level dotfiles worth adopting when present. Deliberately files, not directories —
// a bounded, legible set that copies cleanly, rather than dragging in a whole `~/.config` tree
// whose structure boom would have to guess at. A candidate that's already a symlink is skipped
// (something else already manages it — likely another dotfiles tool).
const DOTFILE_CANDIDATES = [
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".gitconfig",
  ".gitignore_global",
  ".vimrc",
  ".tmux.conf",
  ".inputrc",
  ".editorconfig",
  ".aliases",
] as const;

interface LinuxPkgs {
  readonly mgr: "apt" | "dnf";
  readonly file: string;
  readonly count: number;
}

interface Detected {
  readonly label: string;
  readonly count: number;
  readonly hint: string;
}

interface Adopted {
  readonly brewCount: number;
  readonly miseTools: Record<string, string>;
  readonly linux?: LinuxPkgs;
  readonly dotfiles: string[]; // basenames copied into home/
  readonly others: Detected[]; // popular managers boom can't reconcile yet — surfaced, not applied
  // Populated only by `--from <manager>`: a competing manager's layout translated into link/copy
  // entries (+ scaffold notes for what couldn't be translated cleanly). Mutually exclusive with
  // the live-machine sweep above — an import proposes exactly what that manager owned.
  readonly imported?: { manager: string; entries: ImportedEntry[]; notes: string[] };
}

// System package managers boom's `pkg` resource CAN reconcile (apt/dnf), each with the query
// that lists only *manually*-installed packages — the analog of `brew leaves`. Dumping the full
// dependency closure (`dpkg -l`) would bury the handful you chose under thousands of auto-pulled
// deps, so adopt captures the user-requested set the way it captures brew formulae, not casks.
const LINUX_ADOPT = {
  apt: { probe: "apt-mark", list: ["apt-mark", "showmanual"] },
  dnf: { probe: "dnf", list: ["dnf", "repoquery", "--userinstalled", "--qf", "%{name}"] },
} as const;

// Popular managers boom's `pkg` resource does NOT (yet) reconcile. adopt can't honestly emit a
// `pkg` entry for these — it would write config boom can't apply — so it detects their presence,
// counts what they hold, and leaves a scaffold note pointing at a `run` step / hook. The list is
// deliberately broad (this is where "what else is popular?" lives): one row per manager, each a
// best-effort count from that tool's own list command. asdf is omitted — mise reads its
// `.tool-versions`, so it's already covered by the mise capture; mas rides brew bundle dump.
const OTHER_MANAGERS: ReadonlyArray<{
  cmd: string;
  label: string;
  argv: string[];
  count: (out: string) => number;
  hint: string;
}> = [
  {
    cmd: "npm",
    label: "npm (global)",
    argv: ["npm", "ls", "-g", "--depth=0", "--parseable"],
    count: (o) => Math.max(0, o.split("\n").filter(Boolean).length - 1), // first line is the prefix root
    hint: "run step: npm install -g …, or manage node via mise",
  },
  {
    cmd: "pipx",
    label: "pipx",
    argv: ["pipx", "list", "--short"],
    count: (o) => o.split("\n").filter(Boolean).length,
    hint: "run step: pipx install …",
  },
  {
    cmd: "cargo",
    label: "cargo (installed bins)",
    argv: ["cargo", "install", "--list"],
    count: (o) => o.split("\n").filter((l) => /^\S/.test(l)).length, // top-level lines are crates
    hint: "run step: cargo install …",
  },
  {
    cmd: "volta",
    label: "volta",
    argv: ["volta", "list", "--format", "plain"],
    count: (o) => o.split("\n").filter(Boolean).length,
    hint: "run step: volta install …",
  },
  {
    cmd: "gem",
    label: "gem (user)",
    argv: ["gem", "list", "--no-versions", "--local"],
    count: (o) => o.split("\n").filter((l) => l.trim() && !l.startsWith("***")).length,
    hint: "run step: gem install …",
  },
  {
    cmd: "nix",
    label: "nix profile",
    argv: ["nix", "profile", "list"],
    count: (o) => o.split("\n").filter((l) => /^\d|^Name:/.test(l.trim())).length,
    hint: "manage via a nix profile / home-manager, invoked from a run step",
  },
  {
    cmd: "flatpak",
    label: "flatpak (apps)",
    argv: ["flatpak", "list", "--app", "--columns=application"],
    count: (o) => o.split("\n").filter(Boolean).length,
    hint: "run step: flatpak install …",
  },
  {
    cmd: "snap",
    label: "snap",
    argv: ["snap", "list"],
    count: (o) => Math.max(0, o.split("\n").filter(Boolean).length - 1), // header row
    hint: "run step: snap install …",
  },
];

// Capture the machine's Homebrew set as a Brewfile (`brew bundle dump --file=-` → stdout),
// writing it beside the proposal. Returns how many `brew`/`cask`/`tap`/`mas` lines it holds
// (for the summary), or 0 when brew is absent or the dump is empty.
async function adoptBrew(out: string, ctx: BoomContext, report: Reporter): Promise<number> {
  if (!hasCommand("brew", ctx.env)) {
    report.skip("brew not on PATH — no Brewfile captured");
    return 0;
  }
  const r = await report.spin("brew bundle dump", () =>
    captureArgvAsync(["brew", "bundle", "dump", "--file=-"], ctx.env),
  );
  if (r.code !== 0 || r.stdout.trim() === "") {
    report.skip("brew: nothing to capture");
    return 0;
  }
  await Bun.write(join(out, "Brewfile"), `${r.stdout}\n`);
  const count = r.stdout.split("\n").filter((l) => /^\s*(brew|cask|tap|mas)\s/.test(l)).length;
  report.ok(`captured ${count} Homebrew entr${count === 1 ? "y" : "ies"} → Brewfile`);
  return count;
}

// Capture active mise tool versions (`mise current` → "<tool> <version>" per line) and write a
// `mise.toml` the `pkg` mise resource can install from. Empty when mise is absent or defines no
// current tools.
function adoptMise(ctx: BoomContext): Record<string, string> {
  const tools: Record<string, string> = {};
  if (!hasCommand("mise", ctx.env)) return tools;
  const r = captureArgv(["mise", "current"], ctx.env, { cwd: ctx.env.HOME });
  if (r.code !== 0) return tools;
  for (const line of r.stdout.split("\n")) {
    const [tool, version] = line.trim().split(/\s+/);
    if (tool && version) tools[tool] = version;
  }
  return tools;
}

// Capture the manually-installed apt/dnf set (the first manager present) into a newline list
// the `pkg` apt/dnf resource can install from. Only the user-requested packages, not the full
// dependency closure — see LINUX_ADOPT.
async function adoptLinuxPkgs(
  out: string,
  ctx: BoomContext,
  report: Reporter,
): Promise<LinuxPkgs | undefined> {
  for (const mgr of ["apt", "dnf"] as const) {
    const spec = LINUX_ADOPT[mgr];
    if (!hasCommand(spec.probe, ctx.env)) continue;
    const r = captureArgv([...spec.list], ctx.env);
    const pkgs = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (pkgs.length === 0) continue;
    const file = "packages.txt";
    await Bun.write(join(out, file), `${pkgs.join("\n")}\n`);
    report.ok(`captured ${pkgs.length} ${mgr} package(s) → ${file}`);
    return { mgr, file, count: pkgs.length };
  }
  return undefined;
}

// Probe the popular managers boom can't reconcile (OTHER_MANAGERS) and return the ones present
// with entries — surfaced in the report + as a scaffold note, never emitted as an unappliable
// `pkg`. Best-effort: a probe that errors just contributes nothing.
function detectOthers(ctx: BoomContext, report: Reporter): Detected[] {
  const found: Detected[] = [];
  for (const m of OTHER_MANAGERS) {
    if (!hasCommand(m.cmd, ctx.env)) continue;
    const count = m.count(captureArgv([...m.argv], ctx.env).stdout);
    if (count <= 0) continue;
    found.push({ label: m.label, count, hint: m.hint });
    report.skip(`detected ${count} ${m.label} — boom doesn't manage these (see the scaffold)`);
  }
  return found;
}

// Copy the present, non-symlinked dotfile candidates into `<out>/home/`, returning their
// basenames (for `link` entries in the boomfile). A candidate that's already a symlink is left
// alone — adopting it would fold another tool's management into boom's.
async function adoptDotfiles(out: string, ctx: BoomContext, report: Reporter): Promise<string[]> {
  const home = ctx.env.HOME;
  if (!home) return [];
  const copied: string[] = [];
  const homeDir = join(out, "home");
  for (const name of DOTFILE_CANDIDATES) {
    const src = join(home, name);
    if (!(await pathExists(src))) continue;
    if ((await linkTarget(src)) !== undefined) {
      report.skip(`${name} is a symlink (already managed) — skipped`);
      continue;
    }
    if (!(await stat(src)).isFile()) continue;
    await mkdir(homeDir, { recursive: true });
    await copyFile(src, join(homeDir, name));
    copied.push(name);
  }
  if (copied.length > 0) report.ok(`copied ${copied.length} dotfile(s) → home/`);
  return copied;
}

// Assemble the boomfile.toml text from what was adopted. Hand-written (not a TOML serializer)
// so it can carry the explanatory comments + the scaffold for what boom can't infer — the file
// is meant to be read and edited, not just parsed.
function renderBoomfile(a: Adopted, host: string, stamp: string): string {
  const lines: string[] = [
    `# boomfile.toml — generated by \`boom adopt\` from ${host} on ${stamp}.`,
    "# A proposal: review it, then turn this directory into your config repo",
    "# (git init && git remote add … && boom source set <owner/repo>).",
    "",
  ];

  // `--from <manager>` path: render the imported layout as its own dotfiles section (link/copy
  // entries) plus any scaffold notes, and return — an import proposes exactly what that manager
  // owned, not a fresh machine sweep.
  if (a.imported) {
    lines.push(
      `# Imported from ${a.imported.manager}. \`src\` paths point into that manager's existing tree —`,
      "# review each, then move the files into this repo (or keep the paths) before reconciling.",
      "",
    );
    if (a.imported.entries.length > 0) {
      lines.push("[[section]]", `name = "${a.imported.manager}"`, "");
      for (const e of a.imported.entries) {
        lines.push(`[[section.${e.kind}]]`, `src = "${e.src}"`, `dst = "${e.dst}"`, "");
      }
    } else {
      lines.push(`# No link/copy entries could be translated automatically from ${a.imported.manager}.`, "");
    }
    if (a.imported.notes.length > 0) {
      lines.push("# Needs a human — not translated automatically:");
      for (const n of a.imported.notes) lines.push(`#   • ${n}`);
      lines.push("");
    }
    return `${lines.join("\n")}\n`;
  }

  const pkg: string[] = [];
  if (a.brewCount > 0) pkg.push('[[section.pkg]]\nmanager = "brew"\nfile = "Brewfile"\n');
  if (Object.keys(a.miseTools).length > 0) pkg.push('[[section.pkg]]\nmanager = "mise"\n');
  if (a.linux) pkg.push(`[[section.pkg]]\nmanager = "${a.linux.mgr}"\nfile = "${a.linux.file}"\n`);
  if (pkg.length > 0) {
    lines.push("[[section]]", 'name = "packages"', "", pkg.join("\n"));
  }

  if (a.dotfiles.length > 0) {
    lines.push("[[section]]", 'name = "dotfiles"', "");
    for (const name of a.dotfiles) {
      lines.push("[[section.link]]", `src = "home/${name}"`, `dst = "~/${name}"`, "");
    }
  }

  lines.push(
    "# Not auto-detected — add these by hand:",
    "#   • macOS defaults you've changed (boom can't tell a changed value from a factory one):",
    "#       [[section.osx_default]]",
    '#       domain = "com.apple.dock"',
    '#       key = "autohide"',
    "#       value = true",
    "#   • ~/.config trees (nvim, etc.): add [[section.link]] entries pointing into this repo.",
  );
  if (a.others.length > 0) {
    lines.push(
      "#",
      "# Detected package managers boom doesn't reconcile yet — nothing was captured for these.",
      "# Wire each up with a `run` step (or a hook) if you want boom to manage it:",
    );
    for (const o of a.others) lines.push(`#   • ${o.count} × ${o.label} — ${o.hint}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function adopt(
  ctx: BoomContext,
  opts: { out?: string; force?: boolean; from?: string },
): Promise<number> {
  const report = bandsReporter(ctx.process, ctx.env, "adopt", { setup: "READING THE MACHINE…" });
  const out = resolve(ctx.cwd, opts.out ?? "boom-config");

  if ((await pathExists(join(out, "boomfile.toml"))) && !opts.force) {
    report.fail(`${out}/boomfile.toml already exists — pass --force to overwrite, or choose --out`);
    return report.finish({ ok: "adopt done", fail: (f) => `adopt: ${f} failure(s)` });
  }

  // `--from <manager>`: import a competing dotfile manager's layout instead of sweeping the live
  // machine. An unknown name fails loudly with the supported set; a missing source dir warns.
  if (opts.from !== undefined) {
    const importer = findImporter(opts.from);
    if (!importer) {
      report.fail(`unknown --from "${opts.from}" — supported: ${importerNames()}`);
      return report.finish({ ok: "adopt done", fail: (f) => `adopt: ${f} failure(s)` });
    }
    await mkdir(out, { recursive: true });
    report.header("Importing");
    const host = ctx.env.BOOM_HOST ?? "this machine";
    const stamp = new Date().toISOString().slice(0, 10);
    const sourceDir = await importer.detect(ctx.env);
    if (sourceDir === undefined) {
      report.warn(`no ${importer.name} config found — nothing to import`);
      await Bun.write(
        join(out, "boomfile.toml"),
        renderBoomfile(
          {
            brewCount: 0,
            miseTools: {},
            dotfiles: [],
            others: [],
            imported: { manager: importer.name, entries: [], notes: [] },
          },
          host,
          stamp,
        ),
      );
      report.ok(`empty proposal → ${out}`);
      return report.finish({ ok: "adopt: nothing imported", fail: (f) => `adopt: ${f} failure(s)` });
    }
    const { entries, notes } = await report.spin(`reading ${importer.name}`, () =>
      importer.collect(sourceDir, ctx.env),
    );
    report.ok(`imported ${entries.length} entr${entries.length === 1 ? "y" : "ies"} from ${importer.name}`);
    for (const n of notes) report.note(n);
    await Bun.write(
      join(out, "boomfile.toml"),
      renderBoomfile(
        {
          brewCount: 0,
          miseTools: {},
          dotfiles: [],
          others: [],
          imported: { manager: importer.name, entries, notes },
        },
        host,
        stamp,
      ),
    );
    report.header("Proposal written");
    report.ok(`boom config proposal → ${out}`);
    report.note("review it, then: cd into it, git init, and `boom source set <owner/repo>`");
    return report.finish({ ok: "adopt: config proposed", fail: (f) => `adopt: ${f} failure(s)` });
  }

  await mkdir(out, { recursive: true });

  report.header("Scanning");
  const brewCount = await adoptBrew(out, ctx, report);
  const miseTools = adoptMise(ctx);
  if (Object.keys(miseTools).length > 0) {
    const body = Object.entries(miseTools)
      .map(([t, v]) => `${t} = "${v}"`)
      .join("\n");
    await Bun.write(join(out, "mise.toml"), `[tools]\n${body}\n`);
    report.ok(`captured ${Object.keys(miseTools).length} mise tool(s) → mise.toml`);
  }
  const linux = await adoptLinuxPkgs(out, ctx, report);
  const others = detectOthers(ctx, report);
  const dotfiles = await adoptDotfiles(out, ctx, report);

  const host = ctx.env.BOOM_HOST ?? "this machine";
  const stamp = new Date().toISOString().slice(0, 10);
  await Bun.write(
    join(out, "boomfile.toml"),
    renderBoomfile({ brewCount, miseTools, linux, dotfiles, others }, host, stamp),
  );

  report.header("Proposal written");
  report.ok(`boom config proposal → ${out}`);
  report.note("review it, then: cd into it, git init, and `boom source set <owner/repo>`");
  return report.finish({ ok: "adopt: config proposed", fail: (f) => `adopt: ${f} failure(s)` });
}
