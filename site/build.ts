// The docs-site generator. Turns the repo's own markdown (SPEC.md) into
// Kirby-styled HTML pages that share the landing page's design
// system. "Operate as a docs site" = add a markdown file here and it becomes a
// page — no hand-authored HTML per doc.
//
// The shared chrome (SVG krackle symbols, footer, favicon, copy-to-clipboard
// script) is lifted verbatim from site/index.html so the hand-authored landing
// page stays the single source of truth for it — edit index.html, every page
// follows. Only the <head> title/description and the active nav item vary per
// page. Run: `bun run site/build.ts` (also runs in the Pages workflow).
//
// Output HTML is written next to index.html and is git-ignored — it is a build
// artifact, regenerated on every deploy.

import { marked } from "marked";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SITE = import.meta.dir; // .../site
const ROOT = resolve(SITE, ".."); // repo root

// --- lift the shared chrome out of the landing page (single source of truth) ---
const index = readFileSync(resolve(SITE, "index.html"), "utf8");
const grab = (re: RegExp, what: string): string => {
  const m = index.match(re);
  if (!m) throw new Error(`build: could not find ${what} in index.html`);
  return m[0];
};
const symbolsSvg = grab(/<svg width="0" height="0"[\s\S]*?<\/svg>/, "SVG symbol defs");
const footerHtml = grab(/<footer class="cosmic section">[\s\S]*?<\/footer>/, "footer");
const copyScript = grab(/<script>[\s\S]*?<\/script>/, "copy-to-clipboard script");
const faviconLink = grab(/<link rel="icon"[^>]*>/, "favicon link");

// --- the pages: one entry per markdown doc ---
type Page = { slug: string; src: string; title: string; desc: string; caption: string };
const PAGES: Page[] = [
  {
    slug: "spec",
    src: "SPEC.md",
    title: "The Design Spec — boom",
    desc: "BoomTube's design of record: the reconcile model, config-repo git sync, the typed boomfile.toml schema, the hook extension contract, transaction/journal, and the stack.",
    caption: "The blueprint of the Fourth World!",
  },
];

// Rewrite in-repo .md links to their built pages, and wrap tables so they scroll
// inside their own box instead of the page. (Trusted, first-party markdown — no
// sanitization needed.)
const rewrite = (html: string): string =>
  html
    .replace(/href="[^"]*?SPEC\.md"/g, 'href="spec.html"')
    .replace(/href="[^"]*?README\.md"/g, 'href="index.html"')
    .replace(/<table>/g, '<div class="tablewrap"><table>')
    .replace(/<\/table>/g, "</table></div>")
    // Make fenced code blocks keyboard-scrollable (they overflow-x): a focusable
    // region is the only way keyboard-only users can reach clipped content.
    .replace(/<pre>/g, '<pre tabindex="0" role="region" aria-label="Code sample">');

const navItem = (href: string, slug: string, label: string, active: string): string =>
  `<a href="${href}"${active === slug ? ' aria-current="page"' : ""}>${label}</a>`;

const masthead = (active: string): string => `<header class="masthead">
  <div class="wrap">
    <a class="logo" href="index.html">BOOM<span class="bang">!</span></a>
    <nav aria-label="Pages">
      ${navItem("index.html", "home", "Home", active)}
      ${navItem("guide.html", "guide", "Guide", active)}
      ${navItem("spec.html", "spec", "Spec", active)}
    </nav>
    <a class="btn gold" href="https://github.com/alxjrvs/boom">GitHub</a>
  </div>
</header>`;

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const render = (p: Page): string => {
  const md = readFileSync(resolve(ROOT, p.src), "utf8");
  const body = rewrite(marked.parse(md, { gfm: true, async: false }) as string);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${p.title}</title>
<meta name="description" content="${escapeAttr(p.desc)}">
${faviconLink}
<link rel="stylesheet" href="styles.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${symbolsSvg}
${masthead(p.slug)}
<main id="main" class="section cosmic docmain">
  <div class="docwrap">
    <div class="doc-hero"><p class="caption">${p.caption}</p></div>
    <article class="doc panel">
${body}
    </article>
    <nav class="docnav" aria-label="More docs">
      <a class="btn" href="index.html">&larr; Home</a>
      <a class="btn blue" href="guide.html">The Guide</a>
      <a class="btn gold" href="https://github.com/alxjrvs/boom">View source on GitHub</a>
    </nav>
  </div>
</main>
${footerHtml}
${copyScript}
</body>
</html>
`;
};

// The Guide is bespoke HTML (comic panels, syntax-tinted codeboxes) that markdown
// can't express, so it isn't a Page above — but it still shouldn't hand-duplicate
// the chrome. We author only its body fragment (guide.body.html: the subnav + the
// reference <main>) and wrap it in the same lifted chrome as the landing, so a nav
// or footer edit in index.html propagates here too. Uses the landing's panel system,
// not the .doc long-form column.
const renderGuide = (): string => {
  const body = readFileSync(resolve(SITE, "guide.body.html"), "utf8");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guide — boom</title>
<meta name="description" content="How to use boom: install, bootstrap a machine, the reconcile loop (apply / verify / repair, and rollback), the boomfile.toml reference, config-repo git, code portals, and housekeeping.">
${faviconLink}
<link rel="stylesheet" href="styles.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${symbolsSvg}
${masthead("guide")}
${body}
${footerHtml}
${copyScript}
</body>
</html>
`;
};

for (const p of PAGES) {
  const out = resolve(SITE, `${p.slug}.html`);
  writeFileSync(out, render(p));
  console.log(`site: built ${p.slug}.html  ← ${p.src}`);
}
writeFileSync(resolve(SITE, "guide.html"), renderGuide());
console.log("site: built guide.html  ← guide.body.html");
console.log(`site: ${PAGES.length + 1} page(s) generated in ${SITE}`);
