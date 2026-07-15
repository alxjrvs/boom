// The docs-site generator. Turns the repo's own markdown (SPEC.md) into HTML
// pages that share the landing page's design system. "Operate as a docs site" =
// add a markdown file to PAGES and it becomes a page — no hand-authored HTML per doc.
//
// The landing (site/index.html) is SELF-CONTAINED: its design system is an inline
// <style> block and its marks are canvas-drawn by an inline <script>. This generator
// lifts BOTH verbatim, plus the footer and favicon, so index.html stays the single
// source of truth for the shared chrome — edit index.html, every page follows. Doc
// pages add only a prose stylesheet (DOC_CSS) for long-form markdown. Run:
// `bun run site/build.ts` (also runs in the Pages workflow).
//
// Output HTML is written next to index.html and is git-ignored — a build artifact,
// regenerated on every deploy.

import { marked } from "marked";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SITE = import.meta.dir; // .../site
const ROOT = resolve(SITE, ".."); // repo root

// Version for the header pill — read from package.json so generated doc pages stay in
// lockstep with the release (the hand-authored landing hardcodes the same pill).
const VERSION = (JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version: string }).version;

// --- lift the shared chrome out of the landing page (single source of truth) ---
const index = readFileSync(resolve(SITE, "index.html"), "utf8");
const grab = (re: RegExp, what: string): string => {
  const m = index.match(re);
  if (!m) throw new Error(`build: could not find ${what} in index.html`);
  return m[0];
};
const styleBlock = grab(/<style>[\s\S]*?<\/style>/, "inline <style> design system");
const scriptBlock = grab(/<script>[\s\S]*?<\/script>/, "inline <script> (marks + theme)");
const footerHtml = grab(/<footer>[\s\S]*?<\/footer>/, "footer");
const faviconLink = grab(/<link rel="icon"[^>]*>/, "favicon link");

// Prose styling for long-form markdown, layered on top of the landing's tokens. Doc
// headings drop the landing's uppercase shout so long documents stay readable.
const DOC_CSS = `
  .brand{text-decoration:none;color:inherit;}
  main.wrap{padding-bottom:8px;}
  article.doc{max-width:840px;margin:34px auto 0;padding:30px 40px;}
  .doc>:first-child{margin-top:0;}
  .doc h1,.doc h2,.doc h3,.doc h4,.doc h5,.doc h6{text-transform:none;letter-spacing:0;color:var(--panel-text);line-height:1.18;margin:1.7em 0 .5em;}
  .doc h1{font-size:34px;} .doc h2{font-size:25px;margin-top:2em;padding-bottom:.3em;border-bottom:2px solid var(--panel-line);}
  .doc h3{font-size:20px;} .doc h4{font-size:17px;}
  .doc p,.doc li{color:var(--panel-muted);font-size:16.5px;line-height:1.7;}
  .doc p{margin:0 0 1em;} .doc ul,.doc ol{margin:0 0 1.1em;padding-left:1.35em;} .doc li{margin:.32em 0;}
  .doc a{color:var(--s-key);font-weight:600;} .doc strong{color:var(--panel-text);}
  .doc code{font-family:var(--font-mono);font-size:.9em;color:var(--s-key);
    background:color-mix(in srgb,var(--s-key) 12%,transparent);border:1px solid var(--panel-line);border-radius:4px;padding:.08em .38em;}
  .doc pre{background:var(--ink);border:1px solid var(--panel-line);border-radius:8px;padding:16px 18px;overflow-x:auto;margin:0 0 1.2em;}
  .doc pre code{color:#d8d1ee;background:none;border:none;padding:0;font-size:13.5px;line-height:1.75;}
  .doc blockquote{margin:0 0 1.2em;padding:2px 16px;border-left:3px solid var(--cyan);color:var(--panel-muted);}
  .doc hr{border:none;border-top:2px solid var(--panel-line);margin:2em 0;}
  .tablewrap{overflow-x:auto;margin:0 0 1.2em;}
  .doc table{border-collapse:collapse;width:100%;font-size:14.5px;min-width:520px;}
  .doc th,.doc td{border:1px solid var(--panel-line);padding:8px 12px;text-align:left;color:var(--panel-muted);vertical-align:top;}
  .doc th{color:var(--panel-text);background:var(--panel-2);}
  .docnav{display:flex;gap:12px;flex-wrap:wrap;max-width:840px;margin:26px auto 0;}
`;

// --- the pages: one entry per markdown doc ---
type Page = { slug: string; src: string; title: string; desc: string };
const PAGES: Page[] = [
  {
    slug: "spec",
    src: "SPEC.md",
    title: "The Design Spec — BoomTube",
    desc: "BoomTube's design of record: the reconcile model, config-repo git sync, the typed boomfile.toml schema, the hook extension contract, the transaction journal, and the stack.",
  },
];

// Rewrite in-repo .md links to their built pages, wrap tables so they scroll inside
// their own box, and make fenced code blocks keyboard-scrollable. (Trusted,
// first-party markdown — no sanitization needed.)
const rewrite = (html: string): string =>
  html
    .replace(/href="[^"]*?SPEC\.md"/g, 'href="spec.html"')
    .replace(/href="[^"]*?README\.md"/g, 'href="index.html"')
    .replace(/<table>/g, '<div class="tablewrap"><table>')
    .replace(/<\/table>/g, "</table></div>")
    .replace(/<pre>/g, '<pre tabindex="0" role="region" aria-label="Code sample">');

const navItem = (href: string, slug: string, label: string, active: string): string =>
  `<a href="${href}"${active === slug ? ' aria-current="page"' : ""}>${label}</a>`;

// Masthead in the new design system: the canvas hex-tunnel mark (rendered by the
// lifted script), the wordmark, doc links, and the shared theme toggle.
const masthead = (active: string): string => `<header class="bar">
  <div class="wrap bar-in">
    <a class="brand" href="index.html">
      <canvas data-mark="master" width="90" height="90" style="width:30px;height:30px" aria-hidden="true"></canvas>
      <span class="wm">BoomTube</span>
    </a>
    <nav class="bar-nav" aria-label="Docs">
      ${navItem("index.html", "home", "Home", active)}
      ${navItem("spec.html", "spec", "Spec", active)}
      <a href="https://github.com/alxjrvs/boom">GitHub</a>
    </nav>
    <div class="bar-sp"></div>
    <span class="bar-ver" aria-label="Version ${VERSION}">v${VERSION}</span>
    <button class="toggle" id="theme" type="button" aria-pressed="false">Light</button>
  </div>
</header>`;

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// Deployed at GitHub project Pages: https://alxjrvs.github.io/boom/ (no custom domain).
const SITE_URL = "https://alxjrvs.github.io/boom";

// Per-page <head>: the same SEO surface the landing carries (canonical, Open Graph,
// Twitter card, theme-color) so a shared link to ANY page renders a card. og:image is
// the one committed social card (site/og.png); only title/description/url vary. No
// stylesheet link — the design system is the lifted inline <style> block.
const head = (o: { title: string; desc: string; slug: string; ogType?: string }): string => {
  const url = o.slug === "index" ? `${SITE_URL}/` : `${SITE_URL}/${o.slug}.html`;
  const d = escapeAttr(o.desc);
  const t = escapeAttr(o.title);
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index,follow">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#08060F">
<meta property="og:type" content="${o.ogType ?? "website"}">
<meta property="og:site_name" content="BoomTube">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE_URL}/og.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The BOOMTUBE wordmark beside a Kirby boom-tube portal: declarative dev-machine setup — the file goes in, the machine comes out.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${SITE_URL}/og.png">
${faviconLink}
<link rel="apple-touch-icon" href="apple-touch-icon.png">`;
};

const render = (p: Page): string => {
  const md = readFileSync(resolve(ROOT, p.src), "utf8");
  const body = rewrite(marked.parse(md, { gfm: true, async: false }) as string);
  return `<!doctype html>
<html lang="en">
<head>
${head({ title: p.title, desc: p.desc, slug: p.slug, ogType: "article" })}
${styleBlock}
<style>${DOC_CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${masthead(p.slug)}
<main id="main" class="wrap">
  <article class="panel doc lead-c">
${body}
  </article>
  <nav class="docnav" aria-label="More">
    <a class="btn btn-line" href="index.html">← Home</a>
    <a class="btn btn-solar" href="https://github.com/alxjrvs/boom">Source on GitHub</a>
  </nav>
</main>
${footerHtml}
${scriptBlock}
</body>
</html>
`;
};

for (const p of PAGES) {
  const out = resolve(SITE, `${p.slug}.html`);
  writeFileSync(out, render(p));
  console.log(`site: built ${p.slug}.html  ← ${p.src}`);
}

// sitemap + robots (git-ignored build artifacts, rebuilt each deploy): the homepage
// plus every generated doc page.
const pageUrls = ["", ...PAGES.map((p) => `${p.slug}.html`)];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pageUrls.map((u) => `  <url><loc>${SITE_URL}/${u}</loc></url>`).join("\n")}
</urlset>
`;
writeFileSync(resolve(SITE, "sitemap.xml"), sitemap);
writeFileSync(resolve(SITE, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
console.log("site: built sitemap.xml + robots.txt");

console.log(`site: ${PAGES.length} doc page(s) generated in ${SITE}`);
