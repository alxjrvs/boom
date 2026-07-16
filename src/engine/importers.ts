// Migration importers — read a competing dotfile manager's on-disk layout and translate it into
// the same intermediate shape `boom adopt` already renders (link/copy entries), so `boom adopt
// --from <manager>` can migrate someone onto boom in one command. Each importer knows one
// manager's well-known layout: where its source tree lives (`detect`) and how its file-naming
// convention maps to `$HOME` targets (`collect`).
//
// The translation is deliberately honest: mechanical, fully-specified conventions (stow's mirror,
// chezmoi's `dot_`/attribute prefixes, dotbot's `link:` map) become real link/copy entries; the
// parts a manager expresses as templates, scripts, or a whole Nix evaluation are surfaced as
// `notes` (scaffold comments in the proposal) rather than silently dropped or wrongly guessed.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { displayPath, pathExists } from "../lib/fs.ts";
import { captureArgv, hasCommand } from "../lib/proc.ts";

type Env = Record<string, string | undefined>;

// One translated file: a `link` (symlink into the manager's tree) or `copy` (materialize the
// content) whose `src` is a tilde-relative path into the manager's source and `dst` the `$HOME`
// target. This is exactly what `renderBoomfile` turns into `[[section.link]]` / `[[section.copy]]`.
export interface ImportedEntry {
  readonly kind: "link" | "copy";
  readonly src: string; // tilde-relative path into the manager's source tree
  readonly dst: string; // tilde-relative target under $HOME
}

// A `collect` result: the mechanical entries plus any scaffold notes (templates, scripts, or
// whole-manager caveats) that couldn't be translated cleanly and need a human. Notes render as
// comment lines in the proposal — never as unappliable config.
export interface ImportResult {
  readonly entries: ImportedEntry[];
  readonly notes: string[];
}

export interface Importer {
  readonly name: string;
  // The manager's source dir if this machine has it, else undefined. Cheap existence probe.
  detect(env: Env): Promise<string | undefined> | string | undefined;
  // Walk that source dir and translate it. Async: importers read directory trees / shell out.
  collect(sourceDir: string, env: Env): Promise<ImportResult>;
}

function home(env: Env): string {
  return env.HOME ?? "";
}

// readdir with file-types, swallowing errors (missing/unreadable dir → empty). Kept as its own
// helper so callers infer `Dirent[]` without an explicit annotation (the `Awaited<ReturnType…>`
// form resolves to the wrong Buffer overload under the repo's strict TS config).
async function readdirSafe(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Recursively list files (not directories) under `root`, returned as paths relative to `root`
// with forward slashes. Symlinks are followed as files (their target is what the manager tracks).
async function walkFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await readdirSafe(join(root, rel))) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...(await walkFiles(root, childRel)));
    } else {
      out.push(childRel);
    }
  }
  return out;
}

// --- stow ---------------------------------------------------------------------------------
// GNU Stow: a package dir under the stow root (conventionally ~/.dotfiles) whose contents mirror
// $HOME. `~/.dotfiles/vim/.vimrc` → symlink `~/.vimrc`; `~/.dotfiles/git/.config/git/config` →
// `~/.config/git/config`. We emit one link per file (stow itself links directories when it can,
// but per-file links are an equivalent, more explicit translation). The top level is packages;
// everything below a package mirrors home. `.git`/`.stow-*` metadata is skipped.
const STOW_ROOTS = ["~/.dotfiles", "~/dotfiles", "~/.stow"] as const;
const STOW_SKIP = new Set([".git", ".github", ".stow-local-ignore", ".stow-global-ignore"]);

const stow: Importer = {
  name: "stow",
  async detect(env) {
    for (const r of STOW_ROOTS) {
      const abs = join(home(env), r.slice(2));
      if (await pathExists(join(abs, ".git"))) return abs; // a dotfiles repo, not just any ~/.dotfiles
    }
    for (const r of STOW_ROOTS) {
      const abs = join(home(env), r.slice(2));
      if (await pathExists(abs)) return abs;
    }
    return undefined;
  },
  async collect(sourceDir, env) {
    const entries: ImportedEntry[] = [];
    for (const pkg of await readdirSafe(sourceDir)) {
      if (!pkg.isDirectory() || STOW_SKIP.has(pkg.name)) continue;
      const pkgDir = join(sourceDir, pkg.name);
      for (const rel of await walkFiles(pkgDir)) {
        if (rel.split("/").some((seg) => STOW_SKIP.has(seg))) continue;
        entries.push({
          kind: "link",
          src: displayPath(join(pkgDir, rel), env),
          dst: `~/${rel}`,
        });
      }
    }
    return { entries, notes: [] };
  },
};

// --- chezmoi ------------------------------------------------------------------------------
// chezmoi: source at ~/.local/share/chezmoi. File/dir names encode the target via prefixes:
// `dot_` → leading `.`; attribute prefixes `private_`/`readonly_`/`executable_`/`empty_`/
// `encrypted_` are permission/state hints stripped from the name. `*.tmpl` are Go templates,
// `symlink_*` are managed symlinks, `run_*`/`.chezmoiscripts` are scripts — none translate to a
// static link, so they become notes. Everything mechanical becomes a `copy` (chezmoi's model is
// "render/materialize into place", which `copy` matches better than a symlink to a `dot_`-named
// source).
const CHEZMOI_ATTR_PREFIXES = [
  "private_",
  "readonly_",
  "executable_",
  "empty_",
  "encrypted_",
  "once_",
  "onchange_",
];

// Translate one chezmoi source path segment to its target segment, stripping attribute prefixes
// and mapping `dot_` → leading `.`.
function chezmoiSegment(seg: string): string {
  let s = seg;
  for (;;) {
    const p = CHEZMOI_ATTR_PREFIXES.find((pre) => s.startsWith(pre));
    if (!p) break;
    s = s.slice(p.length);
  }
  if (s.startsWith("dot_")) s = `.${s.slice(4)}`;
  return s;
}

const chezmoi: Importer = {
  name: "chezmoi",
  async detect(env) {
    const abs = join(home(env), ".local/share/chezmoi");
    return (await pathExists(abs)) ? abs : undefined;
  },
  async collect(sourceDir, env) {
    const entries: ImportedEntry[] = [];
    const notes: string[] = [];
    for (const rel of await walkFiles(sourceDir)) {
      const base = rel.split("/").pop() ?? rel;
      // chezmoi's own metadata + scripts: never a target file.
      if (base.startsWith(".chezmoi") || rel.split("/").some((s) => s === ".chezmoiscripts")) continue;
      if (base.startsWith("run_")) {
        notes.push(`chezmoi script ${rel} — port to a \`run\` step or hook`);
        continue;
      }
      const isSymlink = rel.split("/").some((s) => s.startsWith("symlink_"));
      const isTemplate = base.endsWith(".tmpl");
      const target = rel
        .split("/")
        .map((s) => chezmoiSegment(s.startsWith("symlink_") ? s.slice("symlink_".length) : s))
        .join("/")
        .replace(/\.tmpl$/, "");
      if (isTemplate) {
        notes.push(`chezmoi template ${rel} → ~/${target} — render manually or use a \`copy\` + expand`);
        continue;
      }
      if (isSymlink) {
        notes.push(`chezmoi managed symlink ${rel} → ~/${target} — recreate as a \`link\``);
        continue;
      }
      entries.push({ kind: "copy", src: displayPath(join(sourceDir, rel), env), dst: `~/${target}` });
    }
    return { entries, notes };
  },
};

// --- yadm ---------------------------------------------------------------------------------
// yadm: a bare git repo at ~/.local/share/yadm/repo.git whose work-tree IS $HOME — tracked files
// already sit at their destinations. `yadm ls-files` enumerates them. Because the files are
// already in place (no separate source tree), boom's cleanest equivalent is to move them into a
// config repo and link — which a human must do — so we emit the file list as best-effort `copy`
// entries (src == the in-place file) plus a note flagging the manual step. If `yadm` isn't on
// PATH we can't enumerate, so we say so.
const yadm: Importer = {
  name: "yadm",
  async detect(env) {
    const abs = join(home(env), ".local/share/yadm/repo.git");
    return (await pathExists(abs)) ? abs : undefined;
  },
  async collect(_sourceDir, env) {
    const entries: ImportedEntry[] = [];
    const notes: string[] = [];
    if (!hasCommand("yadm", env)) {
      notes.push(
        "yadm repo found but `yadm` is not on PATH — install yadm, then re-run to enumerate tracked files",
      );
      return { entries, notes };
    }
    const r = captureArgv(["yadm", "ls-files"], env, { cwd: home(env) });
    const files = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const f of files) {
      entries.push({ kind: "copy", src: displayPath(join(home(env), f), env), dst: `~/${f}` });
    }
    notes.push(
      "yadm's work-tree is $HOME itself: the `src` paths above are the live files — move them into this config repo, then flip these to `link`.",
    );
    return { entries, notes };
  },
};

// --- dotbot -------------------------------------------------------------------------------
// dotbot: an install.conf.yaml with a `link:` directive mapping dst → src (src relative to the
// dotfiles repo). We hand-parse the `link:` block (the repo has no YAML dep, and this block is
// simple: an indented `dst: src` map, or `dst:` followed by an indented `path: src`). Anything
// else (other directives, anchors, flow syntax) is left to a note.
const DOTBOT_DIRS = ["~/.dotfiles", "~/dotfiles", "~"] as const;

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Parse the `link:` map out of a dotbot install.conf.yaml. Returns dst→src pairs. Deliberately
// small: handles `- link:` / `link:` headers, `dst: src` scalars, and `dst:` + nested `path:`.
function parseDotbotLinks(yaml: string): { pairs: Array<[string, string]>; complex: boolean } {
  const pairs: Array<[string, string]> = [];
  let complex = false;
  let inLink = false;
  let baseIndent = -1;
  let pendingDst: string | undefined;
  const indentOf = (l: string): number => l.length - l.trimStart().length;
  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const header = trimmed.replace(/^-\s*/, "");
    if (!inLink) {
      if (header === "link:" || header.startsWith("link:")) {
        inLink = true;
        baseIndent = -1;
        pendingDst = undefined;
      }
      continue;
    }
    const indent = indentOf(line);
    // A new top-level directive (link:, create:, shell:, etc.) or dedent ends the link block.
    if (baseIndent >= 0 && indent < baseIndent) {
      inLink = false;
      continue;
    }
    if (baseIndent < 0) baseIndent = indent;
    // Nested `path: src` (and ignorable flags) under a bare `dst:` key.
    if (pendingDst && indent > baseIndent) {
      const m = trimmed.match(/^path:\s*(.+)$/);
      if (m?.[1] !== undefined) {
        pairs.push([pendingDst, unquote(m[1])]);
        pendingDst = undefined;
      } else if (/^(create|relink|force|glob|prefix|if):/.test(trimmed)) {
        // a link option we don't model — keep the pending dst, ignore the flag
      } else {
        complex = true;
      }
      continue;
    }
    pendingDst = undefined;
    const kv = trimmed.match(/^(.+?):\s*(.*)$/);
    if (!kv || kv[1] === undefined || kv[2] === undefined) {
      complex = true;
      continue;
    }
    const dst = unquote(kv[1]);
    const val = kv[2].trim();
    if (val === "" || val === "|" || val === ">") {
      pendingDst = dst; // value is on following indented lines (nested map)
    } else {
      pairs.push([dst, unquote(val)]);
    }
  }
  return { pairs, complex };
}

const dotbot: Importer = {
  name: "dotbot",
  async detect(env) {
    for (const d of DOTBOT_DIRS) {
      const abs = d === "~" ? home(env) : join(home(env), d.slice(2));
      if (await pathExists(join(abs, "install.conf.yaml"))) return abs;
    }
    return undefined;
  },
  async collect(sourceDir, env) {
    const conf = join(sourceDir, "install.conf.yaml");
    const yaml = await Bun.file(conf)
      .text()
      .catch(() => "");
    const { pairs, complex } = parseDotbotLinks(yaml);
    const entries: ImportedEntry[] = pairs.map(([dst, src]) => ({
      kind: "link",
      // dotbot dsts are already ~/-relative or absolute; srcs are relative to the dotbot repo.
      dst: dst.startsWith("~") || dst.startsWith("/") ? dst : `~/${dst}`,
      src: src.startsWith("~") || src.startsWith("/") ? src : displayPath(join(sourceDir, src), env),
    }));
    const notes: string[] = [];
    if (complex) {
      notes.push(
        `dotbot ${conf} has directives beyond a simple \`link:\` map — review it by hand for the rest.`,
      );
    }
    return { entries, notes };
  },
};

// --- nix-darwin ---------------------------------------------------------------------------
// nix-darwin: a whole Nix flake (~/.config/nix-darwin or a flake.nix with a darwinConfiguration)
// that evaluates to system + home-manager state. There is no file-name convention to walk — the
// mapping is the result of a Nix evaluation — so an honest one-command translation isn't possible.
// We detect it and emit a scaffold note pointing at the manual path, rather than guessing entries.
const nixDarwin: Importer = {
  name: "nix-darwin",
  async detect(env) {
    const candidates = [
      join(home(env), ".config/nix-darwin"),
      join(home(env), ".config/nix-darwin/flake.nix"),
      join(home(env), ".nixpkgs/darwin-configuration.nix"),
      join(home(env), ".config/nixpkgs/flake.nix"),
    ];
    for (const c of candidates) if (await pathExists(c)) return c;
    return undefined;
  },
  async collect(sourceDir, _env) {
    return {
      entries: [],
      notes: [
        `nix-darwin config detected at ${sourceDir}.`,
        "Manual migration needed: nix-darwin's file layout is the result of a Nix evaluation, not a",
        "name convention boom can walk. Port each home-manager `home.file`/`xdg.configFile` entry to a",
        "[[section.link]]/[[section.copy]], and each system package to a `pkg`/`run` step, by hand.",
      ],
    };
  },
};

export const IMPORTERS: readonly Importer[] = [stow, chezmoi, yadm, dotbot, nixDarwin];

export function importerNames(): string {
  return IMPORTERS.map((i) => i.name).join(", ");
}

export function findImporter(name: string): Importer | undefined {
  return IMPORTERS.find((i) => i.name === name.toLowerCase());
}
