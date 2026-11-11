// Generates the landing page's office art from the design modules.
//
//   node landing/gen-img.mjs
//
// Writes static SVGs into landing/img/. Commit the output — the site has no
// build step on deploy, so what is checked in is what airoom.dev serves.
// When design/ changes, re-run this and commit the diff.
import { officeSVG, deskUnit, bench, pinboard, ghostDesk, plantRects, tones, carpetPattern } from '../design/scenes.mjs';
import { robot, rect, DIRECTIONS } from '../design/art.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The floor shown on the page. Same plan as design/preview.mjs, rendered at a
// tighter origin so the app frame isn't mostly grass.
const ZONES = [
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
// Only the night shot keeps walkers baked into the SVG. By day the corridors
// are crossed by the HTML .walker sprites index.html animates over the image —
// baking them in as well would double them up.
const WALKERS = [[330, 214, 'working'], [712, 436, 'done'], [664, 214, 'waiting_input']];

// The phone composition is not the wide floor scaled down — fractional scaling
// destroys pixel art. It is three zones stacked in portrait.
const NARROW = [
  { x: 1, y: 1,  w: 16, h: 9, name: 'stickyboard', theme: 'forest', agents: ['working', 'waiting_input'], board: 1 },
  { x: 1, y: 11, w: 16, h: 8, name: 'applyai',     theme: 'plum',   agents: ['working'] },
  { x: 1, y: 20, w: 16, h: 9, name: 'pepsi',       theme: 'ocean',  agents: ['working', 'idle'], shelf: 1 },
];

const DIR = 'bold';
const TILE = 16;

const wrap = (scene, w, h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges">` +
  (scene.defs ? `<defs>${scene.defs}</defs>` : '') + scene.body + '</svg>';

const office = (zones, cols, rows, origin, walkers, opts) =>
  wrap(officeSVG(DIR, zones, cols, rows, origin, walkers, { zoneStatus: false, ...opts }),
    cols * TILE + origin.x * 2, rows * TILE + origin.y * 2);

// One desk close-up per status, for the legend. 80x70 art px on the sage
// backdrop the design reference uses.
const legend = (status) =>
  wrap({ body: `<rect x="0" y="0" width="80" height="70" fill="#96ae85"/>` +
    `<g transform="translate(0,34)">${deskUnit(DIR, 40, 0, status)}</g>` }, 80, 70);

// A standing agent, 22x32, transparent ground — the hero overlay's walkers.
const walker = (status) => wrap({ body: robot(DIR, status, 1, 0, 0) }, 22, 32);

// The team rug, cropped inside a forest zone: lead, builder and reviewer on
// one bench with role bars under their seats (the teamAtTable badge pattern),
// and the ghost desk that hires the next agent. Role bar colours match the
// caption dots in index.html.
const TEAM_ROLES = [
  { color: '#5eead4', status: 'waiting_input' }, // lead — asking for your go-ahead
  { color: '#38bdf8', status: 'working' },       // builder — the only writer
  { color: '#a78bfa', status: 'idle' },          // reviewer — between reads
];
const teamScene = () => {
  const d = DIRECTIONS[DIR];
  const th = tones('forest', DIR);
  const W = 336, H = 148, cx = 124, top = 78;
  let o = rect(0, 0, W, H, `url(#${th.pid})`);
  for (const [x, y, w, h] of [[0, 0, W, 2], [0, H - 2, W, 2], [0, 0, 2, H], [W - 2, 0, 2, H]])
    o += rect(x, y, w, h, th.seam); // the rug's bound edge
  o += rect(0, 0, W, 1, 'rgba(255,255,255,0.10)');
  o += pinboard(d, cx, 8, ['export flow', 'round cap 2', 'notes']);
  o += bench(DIR, cx, top, TEAM_ROLES.map((r) => r.status));
  TEAM_ROLES.forEach(({ color }, i) => {
    const sx = cx - 92 + 5 + 58 * i + 29; // bench seat pitch
    o += rect(sx - 17, top + 34, 34, 11, d.K);
    o += rect(sx - 16, top + 35, 32, 9, '#0f131c');
    o += rect(sx - 16, top + 35, 32, 1, color);
  });
  o += plantRects(d, 18, H - 8);
  o += ghostDesk(d, 282, 84);
  return wrap({ defs: carpetPattern(th), body: o }, W, H);
};

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'img');
mkdirSync(OUT, { recursive: true });

const FILES = {
  'office-day.svg':          office(ZONES, 64, 40, { x: 36, y: 36 }, [], {}),
  'office-night.svg':        office(ZONES, 64, 40, { x: 36, y: 36 }, WALKERS, { night: true }),
  'office-narrow.svg':       office(NARROW, 18, 30, { x: 20, y: 20 }, [], {}),
  'office-narrow-night.svg': office(NARROW, 18, 30, { x: 20, y: 20 }, [], { night: true }),
  'walker-working.svg':      walker('working'),
  'walker-done.svg':         walker('done'),
  'team-pod.svg':            teamScene(),
  'legend-working.svg':      legend('working'),
  'legend-waiting.svg':      legend('waiting_input'),
  'legend-blocked.svg':      legend('error'),
  'legend-idle.svg':         legend('idle'),
};

for (const [name, svg] of Object.entries(FILES)) {
  writeFileSync(join(OUT, name), svg);
  console.log(`wrote img/${name} (${(svg.length / 1024).toFixed(1)} KB)`);
}
