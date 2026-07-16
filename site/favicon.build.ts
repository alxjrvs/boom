// Generates the favicon PNG fallbacks from the canonical mark (site/favicon.svg — the locked
// hex-tunnel "Boom Tube" portal). The SVG is the primary favicon (rel="icon" type=svg+xml);
// these PNGs are the fallbacks a browser without SVG-favicon support (and many tab renderers)
// use, plus the iOS home-screen apple-touch-icon. They have no other source — so without a
// generator they drift silently from the SVG, which is exactly how favicon-32.png went blank
// and apple-touch-icon.png ended up cropped. Rerun after editing favicon.svg:
//   bun run site/favicon.build.ts     (needs rsvg-convert on PATH, like og.build.ts)
import { dirname, join } from "node:path";

const dir = dirname(new URL(import.meta.url).pathname);
const src = join(dir, "favicon.svg");

// size → output file. favicon-32 is the classic <link rel=icon> tab fallback; apple-touch-icon
// is the iOS home-screen tile at Apple's expected 180×180. Both are the sizes index.html links.
const TARGETS: ReadonlyArray<{ size: number; out: string }> = [
  { size: 32, out: "favicon-32.png" },
  { size: 180, out: "apple-touch-icon.png" },
];

let ok = true;
for (const { size, out } of TARGETS) {
  const outPath = join(dir, out);
  const r = Bun.spawnSync(["rsvg-convert", "-w", String(size), "-h", String(size), src, "-o", outPath]);
  if (r.success) console.log(`favicon: built ${out} (${size}×${size}) ← favicon.svg`);
  else {
    ok = false;
    console.warn(`rsvg-convert unavailable or failed; ${out} not regenerated`);
  }
}
if (!ok) process.exitCode = 1;
