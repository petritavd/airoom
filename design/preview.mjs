/**
 * Renders every piece of the redesign into design/preview.html.
 *
 *   node design/preview.mjs && open design/preview.html
 *
 * This is the visual reference for the implementation. When you port a piece
 * into web/src/render, render this beside the app and compare.
 */
import * as A from './art.mjs';
import * as S from './scenes.mjs';
import * as D from './decor.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = 'bold'; // the chosen direction
const STATUSES = ['working', 'waiting_input', 'idle', 'error', 'done'];

/** The zone plan the open floor is drawn from. 64x40 tiles of 16 art px. */
export const COLS = 64, ROWS = 40, OFF = { x: 55, y: 55 };
export const ZONES = [
  { x: 2,  y: 2,  w: 17, h: 11, name: 'tmp',             theme: 'oak',    agents: ['working', 'idle'], shelf: 1 },
  { x: 22, y: 2,  w: 20, h: 11, name: 'stickyboard',     theme: 'forest', agents: ['working', 'working', 'waiting_input'], board: 1 },
  { x: 46, y: 2,  w: 16, h: 11, name: 'stickyboard/web', theme: 'forest', agents: ['working', 'idle'] },
  { x: 2,  y: 16, w: 17, h: 11, name: 'applyai',         theme: 'plum',   agents: ['error'], board: 1 },
  { x: 22, y: 16, w: 20, h: 11, name: 'lounge',          kind: 'lounge' },
  { x: 46, y: 16, w: 16, h: 11, name: 'meeting',         kind: 'meeting' },
  { x: 2,  y: 29, w: 17, h: 9,  name: 'applyai/api',     theme: 'plum',   agents: ['working', 'idle'] },
  { x: 22, y: 29, w: 20, h: 9,  name: 'pepsi',           theme: 'ocean',  agents: ['working', 'waiting_input', 'idle'], shelf: 1 },
  { x: 46, y: 30, w: 16, h: 5,  name: 'kitchen',         kind: 'kitchen' },
];
const WALKERS = [[330, 214, 'working'], [712, 436, 'done'], [664, 214, 'waiting_input']];

const svg = (sc, w, h, z) =>
  `<svg viewBox="0 0 ${w} ${h}" width="${w * z}" height="${h * z}" shape-rendering="crispEdges">` +
  (sc.defs ? `<defs>${sc.defs}</defs>` : '') + (sc.body ?? sc) + '</svg>';
const sect = (t, note, inner) =>
  `<section><h2>${t}</h2>${note ? `<p>${note}</p>` : ''}<div class=row>${inner}</div></section>`;
const cell = (label, inner) => `<div class=c><span class=l>${label}</span>${inner}</div>`;

const parts = [];

const FW = COLS * S.TILE + OFF.x * 2, FH = ROWS * S.TILE + OFF.y * 2;

parts.push(sect('The open floor — this is the build target',
  'drawShell replacement: carpet + waist-high glass on three sides, open onto the corridor. Keep the Cell model — a zone is a cell.',
  svg(S.officeSVG(DIR, ZONES, COLS, ROWS, OFF, WALKERS, { zoneStatus: false }), FW, FH, 1)));

parts.push(sect('At night — also in scope',
  'ambiance veil on the ROOM, then lamp pools, then agents — so they stay readable after dark.',
  svg(S.officeSVG(DIR, ZONES, COLS, ROWS, OFF, WALKERS, { night: true, zoneStatus: false }), FW, FH, 1)));

parts.push(sect('Zone status halos — FOLLOW-UP, not in the first pass',
  'The zone haloes when something in it needs you, so you scan the floor rather than hunting 22px sprites. Pass { zoneStatus: true } (the default) to officeSVG. Ship the floor first.',
  svg(S.officeSVG(DIR, ZONES, COLS, ROWS, OFF, WALKERS), FW, FH, 1)));

parts.push(sect('Agent sprite — 4x, and today at 2x for comparison',
  '22x32. Status sits on the antenna bulb, the visor brow + eyes, and the chest plate — all inside dark fields.',
  STATUSES.map((st) => cell(st,
    svg(A.robot(DIR, st, 1, 0, 0), 22, 32, 4) +
    svg(A.robotOld(st, 1, 0, 0), 22, 40, 2))).join('')));

parts.push(sect('Seated, and the shared bench', 'One bench per zone, seat pitch 58, width n*58+10.',
  cell('seated', svg(A.robot(DIR, 'working', 1, 0, 0, { seated: true }), 22, 26, 4)) +
  cell('bench x3', svg(`<rect x="0" y="0" width="220" height="90" fill="#96ae85"/>` +
    `<g transform="translate(0,58)">${S.bench(DIR, 110, 0, ['working', 'waiting_input', 'idle'])}</g>`, 220, 90, 2))));

parts.push(sect('Screen states', 'Full status-colour panel, dark #141925 content. Each state differs by SHAPE, not only hue.',
  STATUSES.map((st) => cell(st, svg(`<rect x="0" y="0" width="80" height="70" fill="#96ae85"/>` +
    `<g transform="translate(0,34)">${S.deskUnit(DIR, 40, 0, st)}</g>`, 80, 70, 3))).join('')));

parts.push(sect('Decor — 31 kept', 'Same keyline, same sun, same contact shadow as the agents. Footprints unchanged.',
  Object.entries(D.DECOR).map(([k, it]) => {
    const pad = 8, w = it.w + pad * 2, h = it.h + pad * 2 + 6, z = w <= 63 ? 3 : 2;
    const glow = it.glow ? S.pool(w / 2, h - pad - 6, 30, '#ffd68c', 0.34)
      : it.light ? S.pool(w / 2, h - pad + 4, 26, '#fff0c8', 0.26) : '';
    return cell(`${it.label} · ${it.w}x${it.h}`,
      svg(`<rect x="0" y="0" width="${w}" height="${h}" fill="#96ae85"/>` + glow +
        `<g transform="translate(${w / 2},${h - pad})">${it.draw()}</g>`, w, h, z));
  }).join('')));

parts.push(sect('Decor — 8 cut', '', `<table>${D.DROPPED.map(([k, why]) =>
  `<tr><td><s>${k}</s></td><td>${why}</td></tr>`).join('')}</table>`));

const html = `<!doctype html><meta charset=utf-8><title>airoom redesign reference</title><style>
 body{background:#0b0e14;color:#e6ebf3;font:13px/1.6 system-ui,sans-serif;margin:0;padding:26px}
 h1{font:600 20px ui-monospace,monospace;letter-spacing:.5px;margin:0 0 6px}
 h2{font:600 11px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;
    color:#8494ad;margin:34px 0 8px}
 p{color:#b7c2d4;max-width:70ch;margin:0 0 12px}
 .row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end}
 .c{display:flex;flex-direction:column;gap:6px;align-items:center;background:#0f131c;
    border:1px solid #202736;border-radius:9px;padding:11px}
 .c svg{display:block;border-radius:4px}
 .l{font:10px ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:#7b8aa3}
 table{border-collapse:collapse;font-size:13px;color:#b7c2d4}
 td{border-top:1px solid #202736;padding:7px 16px 7px 0;vertical-align:top}
 td:first-child{font-family:ui-monospace,monospace;color:#f0a8a8;white-space:nowrap}
</style>
<h1>airoom — redesign reference</h1>
<p>Generated by <code>design/preview.mjs</code>. Direction: <b>Bold 16-bit</b>.
   These are the exact values to port — read the modules, don't eyeball the pixels.</p>
${parts.join('')}`;

const out = join(dirname(fileURLToPath(import.meta.url)), 'preview.html');
writeFileSync(out, html);
console.log('wrote', out, `(${(html.length / 1024).toFixed(0)} KB)`);
