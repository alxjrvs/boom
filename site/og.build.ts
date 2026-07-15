#!/usr/bin/env bun
// Generates the social-share card (site/og.svg → og.png, 1200×630).
//
// Why a generator: OG crawlers don't render SVG, so the card must be rasterized
// to a committed PNG. And the portal on the card MUST be the real brand icon —
// the collapsing hex tunnel drawn by index.html's <canvas> `master`/`marktrans`
// mark — not a lookalike. So we reproduce that mark's exact geometry (the `P`
// params + hexPts/drawHex math, lifted from index.html, the source of truth) and
// emit it as static <polygon>s. Change the mark there → rerun this → icon and
// card stay in lockstep. Rerun:  bun run site/og.build.ts   (writes og.svg, and
// og.png if rsvg-convert is on PATH).

// ---- brand palette (mirrors index.html `C` / :root tokens) ----
const C = {
  void: "#0A0713",
  cyan: "#2BE8FF",
  magenta: "#FF2E86",
  violet: "#7A3CFF",
  solar: "#FFC93C",
  white: "#FBF7FF",
  ink: "#05040A",
} as const;

const TAU = Math.PI * 2;

// ---- master mark (locked hex tunnel) — verbatim params from index.html ----
const P = { n: 6, M: [0.5, 0.5], V: [0.64, 0.37], rm: 0.44, rd: 0.08, sq: 0.9, rot: -0.16 };

// one hexagon ring: 6 vertices at radius r about (cx,cy), twisted by `rot`,
// x-squished by P.sq — identical to index.html hexPts().
function hexPts(cx: number, cy: number, r: number, rot: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * TAU;
    const px = Math.cos(a) * r,
      py = Math.sin(a) * r;
    const rx = px * Math.cos(rot) - py * Math.sin(rot),
      ry = px * Math.sin(rot) + py * Math.cos(rot);
    out.push([cx + rx * P.sq, cy + ry]);
  }
  return out;
}

const f = (n: number) => Number(n.toFixed(2));
const ptsAttr = (pts: [number, number][]) => pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ");

// Emit the free-floating hex tunnel (drawHex's `marktrans` form: no clip tile),
// centered on the origin so it can be dropped into a translate() group. `S` is the
// mark's normalized square edge; the outermost ring spans radius P.rm * S.
function hexTunnel(S: number): string {
  const stroke = 0.045 * S; // lw = 0.045 * S, as in index.html drawHex
  const rings: string[] = [];
  // draw back-to-front like drawHex: outermost (i=0) last on top → iterate high→low.
  for (let i = P.n - 1; i >= 0; i--) {
    const p = i / (P.n - 1);
    const R = (P.rm - (P.rm - P.rd) * p) * S;
    const cx = (P.M[0] + (P.V[0] - P.M[0]) * p) * S - S / 2;
    const cy = (P.M[1] + (P.V[1] - P.M[1]) * p) * S - S / 2;
    const pts = ptsAttr(hexPts(cx, cy, R, P.rot));
    if (i === P.n - 1) {
      // the bright throat: solar fill with a thin ink casing for comic pop
      rings.push(`<polygon points="${pts}" fill="${C.solar}" stroke="${C.ink}" stroke-width="3"/>`);
    } else {
      const col = [C.cyan, C.magenta, C.violet][i % 3];
      // ink casing under each colored ring so it reads on the busy backdrop
      rings.push(
        `<polygon points="${pts}" fill="none" stroke="${C.ink}" stroke-width="${f(stroke + 6)}" stroke-linejoin="round"/>` +
          `<polygon points="${pts}" fill="none" stroke="${col}" stroke-width="${f(stroke)}" stroke-linejoin="round"/>`,
      );
    }
  }
  return rings.join("\n    ");
}

// burst rays behind the portal (mirrors index.html burstBig): two fans of thin
// triangles, solar over a rotated magenta pass, radiating from center.
function burst(S: number): string {
  const tri: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const col = pass ? C.magenta : C.solar;
    const n = 16,
      off = pass ? TAU / 32 : 0,
      ln = pass ? 0.3 : 0.46,
      op = pass ? 0.55 : 0.9;
    const spokes: string[] = [];
    for (let i = 0; i < n; i++) {
      const a = ((off + (i / n) * TAU) * 180) / Math.PI;
      spokes.push(
        `<polygon points="${f(S * 0.16)},${f(-S * 0.018)} ${f(S * ln)},0 ${f(S * 0.16)},${f(S * 0.018)}" transform="rotate(${f(a)})"/>`,
      );
    }
    tri.push(`<g fill="${col}" opacity="${op}">${spokes.join("")}</g>`);
  }
  return tri.join("\n    ");
}

// ---- the boomfile page + the machine terminal, verbatim from index.html's
// hero equation glyphs (the file→portal→machine story, its source of truth). A
// 64×64 glyph, centered at (cx,cy) and scaled to `s`×, tilted by `rot`°. ----
function fileGlyph(cx: number, cy: number, s: number, rot: number): string {
  return `<g transform="translate(${f(cx)} ${f(cy)}) rotate(${rot}) scale(${s}) translate(-32 -32)">
      <path d="M13 5 H39 L55 21 V57 Q55 60 52 60 H13 Q10 60 10 57 V8 Q10 5 13 5 Z" fill="${C.white}" stroke="${C.ink}" stroke-width="3.2" stroke-linejoin="round"/>
      <path d="M39 5 V18 Q39 21 42 21 H55 Z" fill="#DCD5EC" stroke="${C.ink}" stroke-width="3.2" stroke-linejoin="round"/>
      <rect x="17" y="30" width="24" height="3.6" rx="1.8" fill="${C.cyan}"/>
      <rect x="17" y="38" width="30" height="3.6" rx="1.8" fill="${C.magenta}"/>
      <rect x="17" y="46" width="19" height="3.6" rx="1.8" fill="${C.violet}"/>
    </g>`;
}
function machineGlyph(cx: number, cy: number, s: number, rot: number): string {
  return `<g transform="translate(${f(cx)} ${f(cy)}) rotate(${rot}) scale(${s}) translate(-32 -32)">
      <rect x="5" y="7" width="54" height="38" rx="4" fill="${C.void}" stroke="${C.ink}" stroke-width="3.2"/>
      <rect x="10" y="12" width="44" height="28" rx="2" fill="#161327"/>
      <path d="M10 14 a2 2 0 0 1 2 -2 h40 a2 2 0 0 1 2 2 v5 h-44 z" fill="#2A2442"/>
      <circle cx="16" cy="15.6" r="1.7" fill="${C.magenta}"/><circle cx="21.5" cy="15.6" r="1.7" fill="${C.solar}"/><circle cx="27" cy="15.6" r="1.7" fill="#3AE6A0"/>
      <rect x="14" y="25" width="27" height="3" rx="1.5" fill="${C.cyan}"/>
      <rect x="14" y="31" width="20" height="3" rx="1.5" fill="${C.violet}"/>
      <rect x="14" y="37" width="13" height="3" rx="1.5" fill="${C.magenta}"/>
      <rect x="28" y="45" width="8" height="6.5" fill="${C.ink}"/>
      <rect x="17" y="52" width="30" height="4.6" rx="2.3" fill="${C.ink}"/>
    </g>`;
}

// a chunky comic block-arrow (the equation's operator), centered at (cx,cy).
function arrow(cx: number, cy: number, s: number): string {
  return `<g transform="translate(${f(cx)} ${f(cy)}) scale(${s})" paint-order="stroke" stroke="${C.ink}" stroke-width="3" stroke-linejoin="round">
      <path d="M-26 -9 H6 V-22 L30 0 L6 22 V9 H-26 Z" fill="${C.solar}"/>
    </g>`;
}

const W = 1200,
  H = 630;
// The card now tells the tagline as a picture: a boomfile page feeds the BOOM
// portal, and the machine emerges. Portal sits dead-center as the transform.
const PORTAL_X = 600,
  PORTAL_Y = 372; // portal center — the middle beat of file → portal → machine
const MARK_S = 330; // outer ring radius ≈ P.rm * 330 ≈ 145 (a beat, not the whole card)
const BURST_S = 560;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- GENERATED by site/og.build.ts — do not edit by hand; rerun the generator.
     Social-share card (1200×630). OG crawlers don't render SVG, so this is
     rasterized to og.png at author time and committed. The card is the tagline
     drawn as an equation: a boomfile page feeds the real brand icon — the
     collapsing hex tunnel (index.html's canvas \`master\` mark, reproduced from
     the same P params) — and the machine comes out the far side. -->
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="vig" cx="50%" cy="58%" r="75%">
      <stop offset="0%" stop-color="#14111F"/>
      <stop offset="100%" stop-color="#08060F"/>
    </radialGradient>
    <radialGradient id="fuzz" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#FFF4D6" stop-opacity=".95"/>
      <stop offset="22%" stop-color="#FFC93C" stop-opacity=".72"/>
      <stop offset="50%" stop-color="#FF683C" stop-opacity=".34"/>
      <stop offset="78%" stop-color="#FF2E86" stop-opacity=".12"/>
      <stop offset="100%" stop-color="#FF2E86" stop-opacity="0"/>
    </radialGradient>
    <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse">
      <circle cx="4" cy="4" r="1.4" fill="#ECE8F7" opacity=".10"/>
    </pattern>
    <symbol id="krak" viewBox="0 0 240 120">
      <g fill="currentColor">
        <circle cx="60" cy="60" r="16"/><circle cx="84" cy="52" r="12"/>
        <circle cx="44" cy="44" r="10"/><circle cx="104" cy="64" r="9"/>
        <circle cx="70" cy="84" r="10"/><circle cx="28" cy="60" r="7"/>
        <circle cx="120" cy="50" r="6"/><circle cx="96" cy="86" r="6"/>
        <circle cx="52" cy="24" r="5"/><circle cx="132" cy="70" r="5"/>
        <circle cx="16" cy="40" r="4"/><circle cx="140" cy="86" r="4"/>
        <circle cx="110" cy="26" r="5"/><circle cx="150" cy="60" r="3"/>
        <circle cx="160" cy="44" r="2.5"/><circle cx="170" cy="72" r="2"/>
        <circle cx="80" cy="10" r="3"/><circle cx="126" cy="14" r="2"/>
      </g>
    </symbol>
    <symbol id="bolt" viewBox="0 0 80 110">
      <path fill="currentColor" stroke="#000" stroke-width="4" stroke-linejoin="round"
        d="M14 2 L66 2 L44 38 L72 38 L12 106 L30 52 L4 52 Z"/>
    </symbol>
    <symbol id="spark" viewBox="0 0 40 40">
      <path fill="currentColor" d="M20 0 L24 16 L40 20 L24 24 L20 40 L16 24 L0 20 L16 16 Z"/>
    </symbol>
  </defs>

  <!-- backdrop -->
  <rect width="${W}" height="${H}" fill="url(#vig)"/>
  <rect width="${W}" height="${H}" fill="url(#dots)"/>

  <!-- ===== the equation: boomfile → BOOM portal → machine ===== -->

  <!-- 1 · the file goes in -->
  ${fileGlyph(150, PORTAL_Y, 2.35, -4)}
  ${arrow(352, PORTAL_Y, 1.05)}

  <!-- 2 · the BOOM portal: the brand hex-tunnel icon imploding to a solar core -->
  <g transform="translate(${PORTAL_X} ${PORTAL_Y})">
    <!-- warm implosion glow -->
    <circle cx="0" cy="0" r="250" fill="url(#fuzz)"/>
    <!-- burst rays -->
    ${burst(BURST_S)}
    <!-- hex tunnel rings (the icon) -->
    ${hexTunnel(MARK_S)}
    <!-- krackle + comic sparks spilling over the rim -->
    <g style="color:#000">
      <use href="#krak" width="240" height="120" transform="translate(-232 -196) scale(.62)"/>
      <use href="#krak" width="240" height="120" transform="translate(118 116) rotate(180) scale(.58)"/>
    </g>
    <use href="#bolt" width="80" height="110" style="color:#FFC93C" transform="translate(-190 -120) rotate(-24) scale(.8)"/>
    <use href="#spark" width="40" height="40" style="color:#FBF7FF" transform="translate(150 -150)"/>
  </g>

  <!-- 3 · the machine comes out -->
  ${arrow(848, PORTAL_Y, 1.05)}
  ${machineGlyph(1035, PORTAL_Y, 2.85, 3)}

  <!-- ===== identity block, upper-left ===== -->
  <!-- solar kicker card: the site's category definer -->
  <g transform="translate(70 40) rotate(-1.4)">
    <rect x="0" y="0" width="486" height="54" fill="#FFC93C" stroke="#000" stroke-width="4" rx="4"/>
    <text x="22" y="37" font-family="'Arial Narrow', Impact, sans-serif" font-weight="700"
      font-size="25" letter-spacing="2" fill="#05040A">DECLARATIVE DEV-MACHINE SETUP</text>
  </g>
  <!-- BOOMTUBE wordmark: BOOM in the four brand signals, TUBE the calm cyan anchor -->
  <g font-family="Impact, 'Arial Narrow Bold', sans-serif" letter-spacing="1">
    <g fill="#05040A" transform="translate(6 6)"><text x="72" y="186" font-size="104">BOOMTUBE</text></g>
    <g paint-order="stroke" stroke="#000" stroke-width="5">
      <text x="72" y="186" font-size="104"><tspan fill="#FF2E86">B</tspan><tspan fill="#2BE8FF">O</tspan><tspan fill="#7A3CFF">O</tspan><tspan fill="#FFC93C">M</tspan><tspan fill="#2BE8FF">TUBE</tspan></text>
    </g>
  </g>

  <!-- ===== tagline, along the bottom ===== -->
  <text x="600" y="592" text-anchor="middle" font-family="'Trebuchet MS', Verdana, sans-serif"
    font-weight="700" font-size="34" fill="#ECE8F7">The file goes in <tspan fill="#FF2E86">&#8594;</tspan> the machine comes out</text>
</svg>
`;

const outSvg = new URL("./og.svg", import.meta.url).pathname;
await Bun.write(outSvg, svg);
console.log(`wrote ${outSvg}`);

// Rasterize to og.png when a rasterizer is available (rsvg-convert preferred).
const outPng = new URL("./og.png", import.meta.url).pathname;
const rsvg = Bun.spawnSync(["rsvg-convert", "-w", String(W), "-h", String(H), outSvg, "-o", outPng]);
if (rsvg.success) {
  console.log(`wrote ${outPng}`);
} else {
  console.warn("rsvg-convert unavailable or failed; og.png not regenerated");
}
