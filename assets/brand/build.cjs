#!/usr/bin/env node
// flowpact brand, "Keyed Seal" v2: regenerates every logo file in this folder
// from the geometry below.
//
// Its packages are not project dependencies; install them outside the repository:
//   npm i --prefix /tmp/flowpact-brand @resvg/resvg-js@2.6.2 opentype.js@2.0.0 geist@1.7.2
//   NODE_PATH=/tmp/flowpact-brand/node_modules node assets/brand/build.cjs [outDir]   (outDir: this folder)
//
// Grid: the mark is drawn on 64 units. Every horizontal edge sits on a multiple
// of 4, so at 16 px (4 units per pixel) the white channel lands on whole rows.
// All mark coordinates are on the 0.5-unit grid; the wordmark is set at
// 1000 units per em, so the glyph outlines keep Geist's own integer points.
'use strict';
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const opentype = require('opentype.js');

const OUT = path.resolve(process.argv[2] || __dirname);
const GEIST = path.join(path.dirname(require.resolve('geist/font')), 'fonts', 'geist-sans');

// ---------------------------------------------------------------- colour
const C = {
  teal: '#0b8496',      // Seal teal: the mark on light backgrounds, the app-icon tile
  tealDark: '#16a2b6',  // Seal teal, dark: the mark on dark backgrounds
  tileTop: '#0d8fa2',   // app-icon gradient, top
  tileBottom: '#0a7889',// app-icon gradient, bottom
  ink: '#0a0a0a',       // wordmark text on light; dark background
  paper: '#fafafa',     // wordmark text on dark
  white: '#ffffff',
  muted: '#a1a1a1',     // social-preview tagline
};

// ---------------------------------------------------------------- geometry
// Seal: a 64-unit rounded square, corner radius 16.
const S = 64, R = 16;
// The channel (the data flow) enters 4 units in from the left edge (the rim),
// rises over the dovetail key and leaves 4 units before the right edge.
// Rows: socket ceiling 20, key crown 28, side runs 36-44 (key base 44).
// Left-half x positions, mirrored about x = 32:
//   foot:   where the side run meets the socket wall (y 36)
//   ceil:   where the socket wall meets the ceiling (y 20)
//   crown:  key corner at y 28        neck: key corner at y 44
const RIM = 4;
const MASTER = { foot: 15, ceil: 10, crown: 21, neck: 26 }; // key 12 -> 22 wide, walls lean 17.4 deg
const FAVICON = { foot: 16, ceil: 8, crown: 20, neck: 28 }; // hinted: corners on whole 16-px pixels, flare 2 px

function channel(h) {
  const m = (x) => S - x;
  return [
    [RIM, 36], [h.foot, 36], [h.ceil, 20], [m(h.ceil), 20], [m(h.foot), 36], [S - RIM, 36],
    [S - RIM, 44], [m(h.neck), 44], [m(h.crown), 28], [h.crown, 28], [h.neck, 44], [RIM, 44],
  ];
}

// ---------------------------------------------------------------- path writing
const num = (v, step = 0.5) => {
  const r = Math.round(v / step) * step;
  return (Object.is(r, -0) ? 0 : +r.toFixed(3)).toString();
};
// Polygon with H/V shorthands, absolute coordinates.
function polyD(pts, k = 1, ox = 0, oy = 0, step = 0.5) {
  const P = pts.map(([x, y]) => [num(ox + x * k, step), num(oy + y * k, step)]);
  let d = `M${P[0][0]} ${P[0][1]}`;
  for (let i = 1; i < P.length; i++) {
    const [x, y] = P[i], [px, py] = P[i - 1];
    if (y === py) d += `H${x}`;
    else if (x === px) d += `V${y}`;
    else d += `L${x} ${y}`;
  }
  return d + 'Z';
}
function squareD(size, r, k = 1, ox = 0, oy = 0, step = 0.5) {
  const n = (v) => num(v, step);
  const x0 = ox, y0 = oy, x1 = ox + size * k, y1 = oy + size * k, q = r * k;
  return `M${n(x0 + q)} ${n(y0)}H${n(x1 - q)}A${n(q)} ${n(q)} 0 0 1 ${n(x1)} ${n(y0 + q)}V${n(y1 - q)}`
    + `A${n(q)} ${n(q)} 0 0 1 ${n(x1 - q)} ${n(y1)}H${n(x0 + q)}A${n(q)} ${n(q)} 0 0 1 ${n(x0)} ${n(y1 - q)}`
    + `V${n(y0 + q)}A${n(q)} ${n(q)} 0 0 1 ${n(x0 + q)} ${n(y0)}Z`;
}
// One shape: the seal with the channel cut out of it.
const sealD = (h, k = 1, ox = 0, oy = 0, step = 0.5) => squareD(S, R, k, ox, oy, step) + polyD(channel(h), k, ox, oy, step);

// ---------------------------------------------------------------- marks
const svgMark = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="${fill}" fill-rule="evenodd" d="${sealD(MASTER)}"/>
</svg>
`;
const mark = svgMark(C.teal);
const markDark = svgMark(C.tealDark);
const markMono = svgMark('currentColor');

// App icon: the seal is the tile; the channel is drawn in white and stops at the rim,
// so the white never reaches the tile's edge.
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="t" x2="0" y2="1">
      <stop offset="0" stop-color="${C.tileTop}"/>
      <stop offset="1" stop-color="${C.tileBottom}"/>
    </linearGradient>
  </defs>
  <path fill="url(#t)" d="${squareD(S, R, 8)}"/>
  <path fill="${C.white}" d="${polyD(channel(MASTER), 8)}"/>
</svg>
`;

// Favicon: flat tile, key corners snapped to the 16-px grid and the flare deepened
// to 2 px so the dovetail survives in a browser tab.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="${C.teal}" d="${squareD(S, R)}"/>
  <path fill="${C.white}" d="${polyD(channel(FAVICON))}"/>
</svg>
`;

// ---------------------------------------------------------------- wordmark
const loadFont = (w) => {
  const b = fs.readFileSync(path.join(GEIST, `Geist-${w}.ttf`));
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const semibold = loadFont('SemiBold'), regular = loadFont('Regular'), medium = loadFont('Medium');

// opentype.js toPathData can emit NaN; serialise the commands ourselves.
function glyphD(cmds, step = 0.5) {
  const n = (v) => num(v, step);
  let d = '', last = null;
  for (const c of cmds) {
    if (c.type === 'Z') { d += 'Z'; last = null; continue; }
    if (c.type === 'L' && last && n(c.x) === n(last.x) && n(c.y) === n(last.y)) continue;
    if (c.type === 'M' || c.type === 'L') d += `${c.type}${n(c.x)} ${n(c.y)}`;
    else if (c.type === 'Q') d += `Q${[c.x1, c.y1, c.x, c.y].map(n).join(' ')}`;
    else if (c.type === 'C') d += `C${[c.x1, c.y1, c.x2, c.y2, c.x, c.y].map(n).join(' ')}`;
    last = c;
  }
  return d;
}

// Set at 1000 units per em (Geist's own grid). Baseline at y = 710 (top of f and l).
const EM = 1000, BASE = 710, XH = 534, DESC = 150;
const MARK_H = 672;                       // 0.84 of the v1 lockup's mark (800); 10.5 per grid unit keeps every corner on the 0.5 grid
const MARK_K = MARK_H / S;
const MARK_Y = BASE - XH / 2 - MARK_H / 2; // channel centre (y 32) on the x-height midline
const GAP = 120;                          // + f's 51-unit side bearing = 171 visible (about 1/4 of the mark)
const word = semibold.getPath('flowpact', MARK_H + GAP, BASE, EM, { letterSpacing: -0.01 });
const wordBox = word.getBoundingBox();
const WM_W = Math.ceil(wordBox.x2), WM_H = BASE + DESC;
const wordmarkSvg = (markFill, textFill) => `<svg xmlns="http://www.w3.org/2000/svg" width="${WM_W / 10}" height="${WM_H / 10}" viewBox="0 0 ${WM_W} ${WM_H}">
  <path fill="${markFill}" fill-rule="evenodd" d="${sealD(MASTER, MARK_K, 0, MARK_Y)}"/>
  <path fill="${textFill}" d="${glyphD(word.commands)}"/>
</svg>
`;
const wordmark = wordmarkSvg(C.teal, C.ink);
const wordmarkDark = wordmarkSvg(C.tealDark, C.paper);

// ---------------------------------------------------------------- rendering helpers
// No <text> anywhere, so skip resvg's system-font scan (it costs ~0.2 s per render).
const resvg = (svg, fitTo, background) => new Resvg(svg, { fitTo, font: { loadSystemFonts: false }, ...(background ? { background } : {}) }).render();
const render = (svg, width, background) => resvg(svg, { mode: 'width', value: width }, background);
const png = (svg, width, background) => render(svg, width, background).asPng();
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), data);
const uri = (buf) => 'data:image/png;base64,' + Buffer.from(buf).toString('base64');
const inner = (svg) => svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const textD = (font, s, x, y, size) => glyphD(font.getPath(s, x, y, size).commands, 0.1);
const textW = (font, s, size) => font.getAdvanceWidth(s, size);

// ---------------------------------------------------------------- social preview
function socialPreview() {
  const W = 1280, H = 640, lockW = 720;
  const k = lockW / WM_W, lockH = WM_H * k;
  const tag = 'workflow contracts for GitHub Actions', tagSize = 38;
  const tagW = textW(regular, tag, tagSize);
  const space = 72;                           // lockup box (incl. descender) -> tagline cap line
  const blockH = lockH + space + tagSize * 0.71;
  const top = (H - blockH) / 2;
  const tagY = top + lockH + space + tagSize * 0.71;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${C.ink}"/>
  <g transform="translate(${(W - lockW) / 2} ${top}) scale(${k})">${inner(wordmarkDark)}</g>
  <path fill="${C.muted}" d="${textD(regular, tag, (W - tagW) / 2, tagY, tagSize)}"/>
</svg>`;
}

// ---------------------------------------------------------------- contrast
function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const cr = (a, b) => ratio(a, b).toFixed(2);

// ---------------------------------------------------------------- contact sheet
function sheet() {
  const W = 1600, PW = 800, PH = 1088;
  const panels = [
    { bg: C.white, fg: C.ink, sub: '#6b6b6b', line: '#e5e5e5', mark, wm: wordmark, wmName: 'wordmark.svg', markName: 'mark.svg', title: 'Light  #ffffff' },
    { bg: C.ink, fg: C.paper, sub: '#a1a1a1', line: '#262626', mark: markDark, wm: wordmarkDark, wmName: 'wordmark-dark.svg', markName: 'mark-dark.svg', title: 'Dark  #0a0a0a' },
  ];
  let b = '';
  const label = (s, x, y, fill, size = 13, font = regular) => `<path fill="${fill}" d="${textD(font, s, x, y, size)}"/>`;
  const img = (svg, x, y, w, bg) => {
    const r = render(svg, w, bg);
    return `<image x="${x}" y="${y}" width="${r.width}" height="${r.height}" href="${uri(r.asPng())}"/>`;
  };
  const zoom = (svg, n, z, x, y, bg) => {
    const r = render(svg, n, bg);
    const p = r.pixels;
    let s = '';
    for (let j = 0; j < r.height; j++) for (let i = 0; i < r.width; i++) {
      const o = (j * r.width + i) * 4;
      s += `<rect x="${x + i * z}" y="${y + j * z}" width="${z}" height="${z}" fill="rgb(${p[o]},${p[o + 1]},${p[o + 2]})"/>`;
    }
    return s;
  };
  panels.forEach((t, i) => {
    const ox = i * PW;
    const mono = svgMark(t.fg);
    b += `<rect x="${ox}" y="0" width="${PW}" height="${PH}" fill="${t.bg}"/>`;
    b += label(t.title, ox + 48, 56, t.sub, 15, medium);

    b += img(t.wm, ox + 48, 92, 560);
    b += label(t.wmName, ox + 48, 220, t.sub);

    const row = [[t.mark, t.markName], [mono, 'mark-mono.svg'], [appIcon, 'app-icon.svg'], [favicon, 'favicon.svg']];
    row.forEach(([s, name], j) => {
      b += img(s, ox + 48 + j * 176, 256, 128);
      b += label(name, ox + 48 + j * 176, 410, t.sub);
    });

    b += label('app-icon.svg, real size: 128 / 64 / 32 / 16 px', ox + 48, 462, t.sub);
    let x = ox + 48;
    for (const n of [128, 64, 32, 16]) { b += img(appIcon, x, 480 + 128 - n, n); x += n + 24; }
    b += label('favicon.svg 32 / 16', ox + 424, 462, t.sub);
    b += img(favicon, ox + 424, 576, 32) + img(favicon, ox + 472, 592, 16);
    b += label('mark, mono 32 / 16', ox + 576, 462, t.sub);
    b += img(t.mark, ox + 576, 576, 32) + img(t.mark, ox + 624, 592, 16);
    b += img(mono, ox + 664, 576, 32) + img(mono, ox + 712, 592, 16);

    b += label('16 px renders at 8x, nearest-neighbour', ox + 48, 660, t.sub);
    b += zoom(appIcon, 16, 8, ox + 48, 676, t.bg);
    b += label('app-icon', ox + 48, 824, t.sub);
    b += zoom(favicon, 16, 8, ox + 200, 676, t.bg);
    b += label('favicon', ox + 200, 824, t.sub);
    b += zoom(t.mark, 16, 8, ox + 352, 676, t.bg);
    b += label(t.markName, ox + 352, 824, t.sub);
    b += label('32 px at 4x', ox + 528, 660, t.sub);
    b += zoom(favicon, 32, 4, ox + 528, 676, t.bg);
    b += label('favicon', ox + 528, 824, t.sub);

    b += label('navbar: wordmark at 24 px tall', ox + 48, 872, t.sub);
    b += `<rect x="${ox + 48.5}" y="888.5" width="703" height="56" rx="10" fill="none" stroke="${t.line}"/>`;
    b += img(t.wm, ox + 64, 904, Math.round((24 * WM_W) / WM_H));
    b += label('README header: wordmark at 48 px tall', ox + 48, 984, t.sub);
    b += img(t.wm, ox + 48, 1000, Math.round((48 * WM_W) / WM_H));
  });

  // Bottom band: colour tokens and the social preview.
  const by = PH;
  b += `<rect x="0" y="${by}" width="${W}" height="420" fill="#f4f4f5"/>`;
  const sw = [
    [C.teal, 'Seal teal', `${cr(C.teal, '#ffffff')}:1 on #ffffff   ${cr(C.teal, '#0a0a0a')}:1 on #0a0a0a`, 'mark, wordmark, favicon, tile'],
    [C.tealDark, 'Seal teal, dark', `${cr(C.tealDark, '#0a0a0a')}:1 on #0a0a0a`, 'mark-dark, wordmark-dark'],
    [[C.tileTop, C.tileBottom], 'App-icon tile', `white channel ${cr(C.white, C.tileTop)}:1 to ${cr(C.white, C.tileBottom)}:1`, `${C.tileTop} to ${C.tileBottom}`],
    [C.ink, 'Ink', `${cr(C.ink, '#ffffff')}:1 on #ffffff`, 'wordmark text, dark background'],
    [C.paper, 'Paper', `${cr(C.paper, '#0a0a0a')}:1 on #0a0a0a`, 'wordmark-dark text'],
    [C.muted, 'Muted', `${cr(C.muted, '#0a0a0a')}:1 on #0a0a0a`, 'social-preview tagline'],
  ];
  sw.forEach(([c, n, l1, l2], j) => {
    const sx = 48 + Math.floor(j / 3) * 420, sy = by + 48 + (j % 3) * 96;
    let fill = c;
    if (Array.isArray(c)) {
      b += `<linearGradient id="sw" x2="0" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient>`;
      fill = 'url(#sw)';
    }
    b += `<rect x="${sx + 0.5}" y="${sy + 0.5}" width="63" height="63" rx="12" fill="${fill}" stroke="#d4d4d8"/>`;
    b += label(Array.isArray(c) ? n : `${n}  ${c}`, sx + 80, sy + 20, C.ink, 15, medium);
    b += label(l1, sx + 80, sy + 42, '#52525b');
    b += label(l2, sx + 80, sy + 60, '#71717a');
  });
  b += label('social-preview.png, 1280 x 640 shown at 0.5x; dashed line = 64 px crop margin', 912, by + 40, '#52525b');
  b += img(socialPreview(), 912, by + 56, 640);
  b += `<rect x="912.5" y="${by + 56.5}" width="639" height="319" fill="none" stroke="#d4d4d8"/>`;
  b += `<rect x="944.5" y="${by + 88.5}" width="575" height="255" fill="none" stroke="#3f3f46" stroke-dasharray="4 4"/>`;

  const H = by + 420;
  const s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${b}</svg>`;
  return resvg(s, { mode: 'original' }).asPng();
}

// ---------------------------------------------------------------- checks
function check(name, svg, step) {
  if (/<(text|filter|mask|image|use|foreignObject)\b/.test(svg) || /href=/.test(svg)) throw new Error(`${name}: forbidden element`);
  for (const d of svg.match(/ d="[^"]+"/g)) {
    const nums = d.slice(4, -1).match(/-?\d+(\.\d+)?/g) || [];
    for (const v of nums) if (Math.abs(v / step - Math.round(v / step)) > 1e-9) throw new Error(`${name}: ${v} is off the ${step} grid`);
  }
}

// ---------------------------------------------------------------- write
fs.mkdirSync(OUT, { recursive: true });
const svgs = {
  'mark.svg': mark, 'mark-dark.svg': markDark, 'mark-mono.svg': markMono,
  'app-icon.svg': appIcon, 'favicon.svg': favicon,
  'wordmark.svg': wordmark, 'wordmark-dark.svg': wordmarkDark,
};
for (const [name, svg] of Object.entries(svgs)) { check(name, svg, 0.5); write(name, svg); }
for (const n of [128, 256, 512]) write(`app-icon-${n}.png`, png(appIcon, n));
for (const n of [16, 32]) write(`favicon-${n}.png`, png(favicon, n));
write('wordmark-light.png', png(wordmark, 1200));
write('wordmark-dark.png', png(wordmarkDark, 1200));
write('social-preview.png', resvg(socialPreview(), { mode: 'original' }).asPng());
write('sheet.png', sheet());

console.log('wrote', Object.keys(svgs).length, 'SVGs and PNGs to', OUT);
console.log('wordmark', WM_W, 'x', WM_H, '| mark', MARK_H, 'at y', MARK_Y, '| visible gap', GAP + 51);
for (const [a, an] of [[C.teal, 'teal'], [C.tealDark, 'tealDark'], [C.tileTop, 'tileTop'], [C.tileBottom, 'tileBottom'], [C.ink, 'ink'], [C.paper, 'paper'], [C.muted, 'muted']]) {
  console.log(an.padEnd(10), a, 'on #ffffff', cr(a, '#ffffff'), ' on #0a0a0a', cr(a, '#0a0a0a'), ' white on it', cr('#ffffff', a));
}
