// Best-effort converter from a bash `botufile` (the DSL) to the botufile.toml data
// model. Covers every prototype primitive; anything unrecognized is dropped with a
// warning, so the operator (or the migration prompt) can finish the messy parts.
import type { Botufile, Section } from "./schema.ts";

export interface MigrateResult {
  readonly config: Botufile;
  readonly warnings: string[];
}

// Append to an optional array field, creating it on first use. A statement (not an
// in-expression assignment) so it reads clearly and stays lint-clean.
function append<T>(arr: T[] | undefined, val: T): T[] {
  const a = arr ?? [];
  a.push(val);
  return a;
}

// Split a DSL line into tokens, honoring single/double quotes (so `section "a b"` and
// `glob 'p' d` tokenize correctly) and stripping the surrounding quotes.
function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null = re.exec(line);
  while (m !== null) {
    out.push(m[1] ?? m[2] ?? (m[3] as string));
    m = re.exec(line);
  }
  return out;
}

export function parseBashBotufile(text: string): MigrateResult {
  const warnings: string[] = [];
  const sections: Section[] = [];
  let cur: Section | undefined;
  const section = (): Section => {
    if (!cur) {
      cur = { name: "default" };
      sections.push(cur);
    }
    return cur;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const t = tokenize(line);
    switch (t[0]) {
      case "section": {
        cur = { name: t.slice(1).join(" ") };
        sections.push(cur);
        break;
      }
      case "link":
      case "copy": {
        let args = t.slice(1);
        let mode: string | undefined;
        if (args[0] === "--mode") {
          mode = args[1];
          args = args.slice(2);
        }
        const src = args[0];
        const dst = args[1];
        if (!src || !dst) {
          warnings.push(`skipped malformed ${t[0]}: ${line}`);
          break;
        }
        const entry = mode ? { src, dst, mode } : { src, dst };
        const s = section();
        if (t[0] === "link") s.link = append(s.link, entry);
        else s.copy = append(s.copy, entry);
        break;
      }
      case "glob": {
        const pattern = t[1];
        const into = t[2];
        if (!pattern || !into) {
          warnings.push(`skipped malformed glob: ${line}`);
          break;
        }
        const s = section();
        s.glob = append(s.glob, { pattern, into });
        break;
      }
      case "brewfile": {
        const file = t[1];
        if (!file) {
          warnings.push(`skipped brewfile without a file: ${line}`);
          break;
        }
        section().brewfile = file;
        break;
      }
      case "mise_install": {
        section().mise = true;
        break;
      }
      case "on": {
        const on = t[1];
        if (on !== "apply" && on !== "verify") {
          warnings.push(`skipped unsupported on-verb: ${line}`);
          break;
        }
        const s = section();
        s.run = append(s.run, { on, cmd: t.slice(2).join(" ") });
        break;
      }
      case "hook": {
        const name = t[1];
        if (!name) {
          warnings.push(`skipped hook without a name: ${line}`);
          break;
        }
        const withObj: Record<string, string> = {};
        for (const kv of t.slice(2)) {
          const i = kv.indexOf("=");
          if (i > 0) withObj[kv.slice(0, i)] = kv.slice(i + 1);
        }
        const s = section();
        s.hook = append(s.hook, Object.keys(withObj).length > 0 ? { name, with: withObj } : { name });
        break;
      }
      default:
        warnings.push(`skipped unrecognized line: ${line}`);
    }
  }
  return { config: { section: sections }, warnings };
}
