// Room scenes at the renderer's real geometry: a 320x215 art-pixel cell with
// WALL_SIDE 7, WALL_TOP 9, WALL_FACE 13, WALL_BOT 12, interior (7,22) 306x181.
import { DIRECTIONS, STATUS, rect, robot, robotOld, floorTone, lift, desat } from './art.mjs';

export const CELL = { w: 320, h: 215 };
export const WALL = { side: 7, top: 9, face: 13, bot: 12 };
export const INT = { x: 7, y: 22, w: 306, h: 181 };

// their exact theme rows
export const THEMES = {
  oak:    { floor: '#b58a5e', alt: '#ab8054', seam: '#946a41', accent: '#b0680f', mat: 'wood' },
  forest: { floor: '#8ba679', alt: '#839e71', seam: '#6f8a60', accent: '#2f7d4a', mat: 'carpet' },
  ocean:  { floor: '#808fa8', alt: '#78879f', seam: '#66758d', accent: '#2f6cad', mat: 'carpet' },
  plum:   { floor: '#9a8a9f', alt: '#918196', seam: '#7c6d82', accent: '#7247ab', mat: 'carpet' },
  rose:   { floor: '#bf9784', alt: '#b58d7a', seam: '#9c7663', accent: '#b04a3e', mat: 'tile' },
  slate:  { floor: '#a9aeb3', alt: '#a0a5ab', seam: '#8a9096', accent: '#2f7099', mat: 'tile' },
};

const scat = (i, salt) => { const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453; return v - Math.floor(v); };
const R = (x, y, w, h, c, extra) => rect(x, y, w, h, c, extra);

/** Theme tones adjusted for a direction. */
export function tones(themeKey, dirKey) {
  const t = THEMES[themeKey], d = DIRECTIONS[dirKey];
  return { floor: floorTone(t.floor, d), alt: floorTone(t.alt, d), seam: floorTone(t.seam, d),
    accent: d.desat ? desat(t.accent, 0.35) : t.accent, mat: t.mat, pid: `cp-${themeKey}-${dirKey}` };
}

// ---- floor materials (their algorithms) ------------------------------------
export function carpetPattern(th) {
  let cells = '';
  for (let i = 0; i < 40; i++)
    cells += R(Math.floor(scat(i, 4) * 32), Math.floor(scat(i, 5) * 32), 1, 1, scat(i, 6) > 0.62 ? th.seam : th.alt);
  return `<pattern id="${th.pid}" width="32" height="32" patternUnits="userSpaceOnUse">` +
    R(0, 0, 32, 32, th.floor) + cells + '</pattern>';
}

export function floorRects(x, y, w, h, th, mat) {
  let o = R(x, y, w, h, th.floor);
  if (mat === 'wood') {
    const plank = 11, len = 170;
    for (let r = 0; r < Math.ceil(h / plank); r++) {
      const py = y + r * plank, ph = Math.min(plank, y + h - py), off = (r % 4) * 43;
      let c = 0;
      for (let bx = x - len + off; bx < x + w; bx += len, c++) {
        const bx0 = Math.max(x, bx), bw = Math.min(bx + len, x + w) - bx0;
        if (bw > 0 && scat(r * 17 + c, 11) > 0.74) o += R(bx0, py, bw, ph - 1, th.alt);
        if (bx > x && bx < x + w) o += R(bx, py, 1, ph - 1, th.seam);
      }
      o += R(x, py + ph - 1, w, 1, th.seam);
    }
  } else if (mat === 'carpet') {
    // Same fleck grain as the renderer, but as a 32px tile instead of 2000
    // single-pixel rects — identical on screen, a fiftieth of the markup.
    o = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${th.pid})"/>`;
  } else if (mat === 'tile') {
    const big = 34;
    for (let ty = 0; ty < Math.ceil(h / big); ty++)
      for (let tx = 0; tx < Math.ceil(w / big); tx++) {
        if ((tx + ty) % 2 === 0) continue;
        const px0 = x + tx * big, py0 = y + ty * big;
        o += R(px0, py0, Math.min(big, x + w - px0), Math.min(big, y + h - py0), th.alt);
      }
    for (let r = 1; r * big < h; r++) o += R(x, y + r * big, w, 1, th.seam);
    for (let c = 1; c * big < w; c++) o += R(x + c * big, y, 1, h, th.seam);
  }
  return o;
}

// ---- walls -----------------------------------------------------------------
export function wallRects(d, th, { doorAccent = false } = {}) {
  const { w, h } = CELL;
  let o = '';
  // top wall: lit top surface, front face, base lip, shadow onto the floor
  o += R(0, 0, w, WALL.top, d.wallTop);
  o += R(0, WALL.top, w, WALL.face, d.wallFace);
  o += R(0, WALL.top + WALL.face - 2, w, 2, d.wallLip);
  o += R(0, INT.y, w, 3, 'rgba(52,36,18,0.20)');
  // side walls
  for (const wx of [0, w - WALL.side]) {
    o += R(wx, 0, WALL.side, h, lift(d.wallFace, 1.04));
    o += R(wx, 0, 2, h, d.wallTop);
    o += R(wx + WALL.side - 1, 0, 1, h, d.wallLip);
  }
  o += R(WALL.side, INT.y, 2, INT.h, 'rgba(52,36,18,0.20)');
  o += R(w - WALL.side - 2, INT.y, 2, INT.h, 'rgba(52,36,18,0.20)');
  // bottom wall + doorway
  const by = h - WALL.bot, dw = 40, dx = w / 2 - dw / 2;
  for (const [sx, sw] of [[0, dx], [dx + dw, w - dx - dw]]) {
    o += R(sx, by, sw, WALL.bot, d.wallFace);
    o += R(sx, by, sw, 2, d.wallTop);
    o += R(sx, by + WALL.bot - 2, sw, 2, d.wallLip);
  }
  const post = doorAccent ? th.accent : d.wallLip;
  o += R(dx - 2, by - 2, 3, WALL.bot + 2, post);
  o += R(dx + dw - 1, by - 2, 3, WALL.bot + 2, post);
  o += R(dx + 1, by, dw - 2, WALL.bot, th.floor);
  return o;
}

/** A window set into the top wall — the room's daylight source. */
export function windowRects(d, cx) {
  const w = 46, h = 16, x = cx - w / 2, y = 3;
  let o = R(x - 2, y - 2, w + 4, h + 4, d.K);
  const glass = d.id === 'ops' ? '#aab6c2' : d.id === 'cozy' ? '#a8cfe0' : '#8fc4e8';
  const glassHi = d.id === 'ops' ? '#cbd4dd' : d.id === 'cozy' ? '#cfe6ef' : '#b6dcf4';
  o += R(x, y, w, h, glass);
  o += R(x, y, w, Math.round(h * 0.45), glassHi);
  o += R(x + w / 2 - 1, y, 2, h, d.wallFace);
  o += R(x, y + h / 2 - 1, w, 2, d.wallFace);
  o += R(x - 3, y + h + 2, w + 6, 3, d.wallTop);
  return o;
}

// ---- furniture --------------------------------------------------------------
/** Chair: sits BEHIND and BESIDE the agent, never above its head. */
export function chairRects(d, cx, top) {
  let o = '';
  o += R(cx - 15, top - 22, 30, 19, d.K);              // backrest keyline
  o += R(cx - 14, top - 21, 28, 17, d.seat);
  o += R(cx - 12, top - 20, 24, 2, d.seatHi);          // padded roll along the top
  o += R(cx - 11, top - 16, 22, 9, d.seatDark);        // recessed panel between bolsters
  o += R(cx - 14, top - 6, 28, 2, d.seatDark);
  for (const ax of [cx - 18, cx + 12]) {                // armrests, outboard of the arms
    o += R(ax - 1, top - 14, 8, 12, d.K);
    o += R(ax, top - 13, 6, 10, d.seatDark);
    o += R(ax, top - 13, 6, 2, d.seatHi);
  }
  o += R(cx - 2, top - 5, 4, 4, d.steelDark);          // gas lift
  return o;
}

/** Monitor + mug, standing on the desk. NO keyboard or mouse: the robot sits
 *  BEHIND the desk, so its input devices live on the far side of the monitor
 *  where we can't see them — drawn on the viewer's side they were out of
 *  anyone's reach. (Matches drawWorkstation in web/src/render/draw.ts.) */
export function workstationRects(d, cx, top, status) {
  const c = STATUS[status], on = status === 'working', sw = 30, sh = 16;
  let o = R(cx - sw / 2 - 3, top, sw + 6, sh + 5, d.bezel);
  o += R(cx - sw / 2 - 3, top, sw + 6, 1, d.bezelHi);
  const sx = cx - sw / 2, sy = top + 2;
  if (status === 'idle') {
    o += R(sx, sy, sw, sh, '#11151d');
    o += R(sx + 3, sy + sh - 4, 5, 2, '#2b3446');
  } else {
    // The panel is the signal: full status colour, so a lit desk is countable
    // across the screen. Content is DARK on it, which is what lets each state
    // differ by SHAPE and not only by hue.
    o += R(sx, sy, sw, sh, c);
    const ink = '#141925';
    if (on) {
      for (let i = 0; i < 4; i++) o += R(sx + 3, sy + 3 + i * 3, 4 + Math.floor(scat(i, 3) * (sw - 12)), 2, ink);
    } else if (status === 'waiting_input') {
      o += R(sx + 6, sy + 7, 7, 2, ink);            // a prompt line...
      o += R(sx + 16, sy + 5, 3, 6, ink);           // ...and a cursor block
    } else if (status === 'error') {
      o += R(sx + sw / 2 - 1, sy + 3, 2, 7, ink);   // "!"
      o += R(sx + sw / 2 - 1, sy + 12, 2, 2, ink);
    } else {
      const mx = sx + sw / 2 - 5, my = sy + sh / 2;  // a tick
      o += R(mx, my, 2, 2, ink); o += R(mx + 2, my + 2, 2, 2, ink);
      o += R(mx + 4, my, 2, 2, ink); o += R(mx + 6, my - 2, 2, 2, ink);
      o += R(mx + 8, my - 4, 2, 2, ink);
    }
  }
  o += R(sx, sy, sw, 1, 'rgba(255,255,255,0.28)');   // glass highlight
  o += R(sx, sy + sh - 1, sw, 1, 'rgba(0,0,0,0.30)'); // inner shadow, bottom of the glass
  o += R(cx - 5, top + sh + 5, 10, 2, d.bezelHi);    // stand foot
  const mug = d.id === 'ops' ? '#8d7f7c' : '#c4564a';
  const mugHi = d.id === 'ops' ? '#a89a97' : '#e07a6c';
  o += R(cx - 24, top + 17, 6, 6, mug);              // mug
  o += R(cx - 24, top + 17, 6, 1, mugHi);
  if (on) {
    o += R(cx + 19, top - 9, 3, 3, c);
    o += R(cx + 24, top - 9, 3, 3, c, ' opacity=".45"');
  }
  return o;
}

/** A whole workstation: chair, agent, desk, screen. */
export function deskUnit(dirKey, cx, top, status, { old = false } = {}) {
  const d = DIRECTIONS[dirKey];
  let o = '';
  const c = STATUS[status];
  if (status === 'working' || status === 'done')
    o += `<ellipse cx="${cx}" cy="${top - 2}" rx="46" ry="26" fill="${c}" opacity=".10"/>`;
  o += chairRects(d, cx, top);
  o += old ? robotOld(status, 1, cx - 11, top - 30, { seated: true })
           : robot(dirKey, status, 1, cx - 11, top - 28, { seated: true });
  o += `<ellipse cx="${cx}" cy="${top + 27}" rx="35" ry="4" fill="rgba(52,36,18,0.22)"/>`;
  if (d.outline) o += R(cx - 32, top - 1, 64, 29, d.K);   // desk keyline
  o += R(cx - 31, top, 62, 22, d.oak);
  o += R(cx - 31, top, 62, 3, d.oakHi);
  o += R(cx - 31, top + 22, 62, 4, d.oakEdge);
  o += R(cx - 28, top + 27, 3, 4, d.oakDark);
  o += R(cx + 25, top + 27, 3, 4, d.oakDark);
  o += workstationRects(d, cx, top + 1, status);
  return o;
}

/** Ghost desk — "hire an agent here". */
export function ghostDesk(d, cx, top) {
  let o = `<rect x="${cx - 31}" y="${top - 24}" width="62" height="42" rx="6" fill="none" stroke="${d.wallTop}" stroke-width="1.5" stroke-dasharray="4 3" opacity=".55"/>`;
  o += `<text x="${cx}" y="${top - 1}" text-anchor="middle" font-family="'Chakra Petch',monospace" font-size="20" font-weight="600" fill="${d.wallTop}" opacity=".6">+</text>`;
  return o;
}

export function plantRects(d, cx, base) {
  let o = R(cx - 6, base - 8, 12, 9, d.K);
  const pot = d.id === 'ops' ? '#8a7d76' : '#a8674a';
  const potHi = d.id === 'ops' ? '#a5988f' : '#c07d5c';
  o += R(cx - 5, base - 7, 10, 7, pot);
  o += R(cx - 5, base - 7, 10, 2, potHi);
  const leaf = d.id === 'ops' ? '#7d8a7e' : d.id === 'cozy' ? '#5d9159' : '#4e8a52';
  const leafHi = d.id === 'ops' ? '#96a297' : d.id === 'cozy' ? '#7cb373' : '#68a862';
  o += R(cx - 8, base - 24, 16, 16, d.K);
  o += R(cx - 7, base - 23, 14, 14, leaf);
  o += R(cx - 6, base - 22, 8, 5, leafHi);
  return o;
}

// ---- a whole room -----------------------------------------------------------
const SEATS = [[89, 88], [230, 88], [89, 164], [230, 164]];

/** One room cell, 320x215 art px. `plan` is 4 entries: a status, or 'ghost'/null. */
export function roomSVG(dirKey, themeKey, plan, { walker = null, label = null } = {}) {
  const d = DIRECTIONS[dirKey], th = tones(themeKey, dirKey);
  let defs = th.mat === 'carpet' ? carpetPattern(th) : '';
  let o = floorRects(0, INT.y, CELL.w, INT.h, th, th.mat);
  o += wallRects(d, th);
  o += windowRects(d, 160);
  // daylight through the glass, then night as a thin cool veil — not a blackout
  o += `<ellipse cx="160" cy="42" rx="46" ry="18" fill="#fff0c8" opacity=".07"/>`;
  o += R(0, INT.y, CELL.w, INT.h, `rgba(28,38,74,${d.veil})`);
  o += plantRects(d, 22, INT.y + INT.h - 4);
  plan.forEach((st, i) => {
    const [cx, top] = SEATS[i];
    if (!st) return;
    o += st === 'ghost' ? ghostDesk(d, cx, top) : deskUnit(dirKey, cx, top, st);
  });
  if (walker) {
    o += `<ellipse cx="${walker[0]}" cy="${walker[1] + 34}" rx="11" ry="3" fill="rgba(0,0,0,0.3)"/>`;
    o += robot(dirKey, walker[2], 1, walker[0] - 11, walker[1]);
  }
  return { defs, body: o };
}

/** The same room as the CURRENT renderer draws it: their tones, their 0.30 veil. */
export function roomBefore(themeKey, plan) {
  const t = THEMES[themeKey];
  const th = { floor: t.floor, alt: t.alt, seam: t.seam, mat: t.mat, pid: `cp-before-${themeKey}` };
  const W = { top: '#f2eade', face: '#d9cbb2', lip: '#96876f', side: '#e4d9c5' };
  let defs = th.mat === 'carpet' ? carpetPattern(th) : '';
  let o = floorRects(0, INT.y, CELL.w, INT.h, th, th.mat);
  o += R(0, 0, CELL.w, WALL.top, W.top);
  o += R(0, WALL.top, CELL.w, WALL.face, W.face);
  o += R(0, WALL.top + WALL.face - 2, CELL.w, 2, W.lip);
  o += R(0, INT.y, CELL.w, 3, 'rgba(52,36,18,0.20)');
  for (const wx of [0, CELL.w - WALL.side]) {
    o += R(wx, 0, WALL.side, CELL.h, W.side);
    o += R(wx, 0, 2, CELL.h, W.top);
    o += R(wx + WALL.side - 1, 0, 1, CELL.h, W.lip);
  }
  const by = CELL.h - WALL.bot, dw = 40, dx = CELL.w / 2 - dw / 2;
  for (const [sx, sw] of [[0, dx], [dx + dw, CELL.w - dx - dw]]) {
    o += R(sx, by, sw, WALL.bot, W.face);
    o += R(sx, by, sw, 2, W.top);
  }
  o += R(dx + 1, by, dw - 2, WALL.bot, th.floor);
  o += R(0, INT.y, CELL.w, INT.h, 'rgba(28,38,74,0.30)');   // their night veil
  const D = DIRECTIONS.bold;
  plan.forEach((st, i) => {
    const [cx, top] = SEATS[i];
    if (!st || st === 'ghost') return;
    const c = STATUS[st];
    if (st === 'working' || st === 'done') o += `<ellipse cx="${cx}" cy="${top - 4}" rx="34" ry="20" fill="#34d399" opacity=".14"/>`;
    // their chair: a purple mass that reaches above the head
    o += `<rect x="${cx - 12}" y="${top - 38}" width="24" height="15" rx="6" fill="#6a5c93"/>`;
    o += R(cx - 14, top - 22, 4, 17, '#4c4169');
    o += R(cx + 10, top - 22, 4, 17, '#4c4169');
    o += `<rect x="${cx - 11}" y="${top - 22}" width="22" height="15" rx="4" fill="#8878b5"/>`;
    o += robotOld(st, 1, cx - 11, top - 30, { seated: true });
    o += `<ellipse cx="${cx}" cy="${top + 27}" rx="35" ry="4" fill="rgba(52,36,18,0.22)"/>`;
    o += R(cx - 31, top, 62, 22, '#b3854f');
    o += R(cx - 31, top, 62, 2, '#c9a071');
    o += R(cx - 31, top + 22, 62, 4, '#8a6238');
    // their monitor: dark bezel, near-black screen
    o += R(cx - 17, top + 1, 34, 18, '#2b3140');
    o += R(cx - 15, top + 3, 30, 15, st === 'working' ? '#0a1a12' : st === 'waiting_input' ? '#1c1606' : '#0b0e15');
    if (st === 'working') for (let i2 = 0; i2 < 4; i2++) o += R(cx - 12, top + 6 + i2 * 4, 6 + i2 * 3, 2, c);
    o += R(cx - 12, top + 18, 20, 4, '#c6ccd6');
    o += R(cx - 22, top + 17, 5, 5, '#c4564a');
  });
  return { defs, body: o };
}

/** Wrap a scene in an SVG at ART_PIXEL=2 (art px -> 2 CSS px), crisp. */
export function svg(scene, w = CELL.w, h = CELL.h, zoom = 2) {
  return `<svg viewBox="0 0 ${w} ${h}" width="${w * zoom}" height="${h * zoom}" ` +
    `shape-rendering="crispEdges" style="display:block;image-rendering:pixelated">` +
    (scene.defs ? `<defs>${scene.defs}</defs>` : '') + scene.body + '</svg>';
}

/** Today's seat — their chair tones and sprite, for a side-by-side. */
export function oldSeat(cx, top) {
  let o = `<rect x="${cx - 12}" y="${top - 38}" width="24" height="15" rx="6" fill="#6a5c93"/>`;
  o += R(cx - 14, top - 22, 4, 17, '#4c4169');
  o += R(cx + 10, top - 22, 4, 17, '#4c4169');
  o += `<rect x="${cx - 11}" y="${top - 22}" width="22" height="15" rx="4" fill="#8878b5"/>`;
  o += robotOld('working', 1, cx - 11, top - 30, { seated: true });
  return o;
}

/** Wall cross-section: the lit top surface, the front face, the base lip and
 *  the shadow it throws onto the floor — the four bands that give a wall height. */
export function wallSection(d, th) {
  let o = R(0, 0, 120, WALL.top, d.wallTop);
  o += R(0, WALL.top, 120, WALL.face - 2, d.wallFace);
  o += R(0, WALL.top + WALL.face - 2, 120, 2, d.wallLip);
  o += R(0, WALL.top + WALL.face, 120, 3, 'rgba(52,36,18,0.20)');
  o += floorRects(0, WALL.top + WALL.face, 120, 26, th, th.mat);
  o += R(0, WALL.top + WALL.face, 120, 3, 'rgba(52,36,18,0.20)');
  return o;
}

// ---- the whole building -----------------------------------------------------
// Not a grid of rooms: ONE floor plan. Rooms tile edge to edge and SHARE a
// wall (each cell draws its own left wall; only the last in a row draws a
// right one), same-family rooms are joined by an archway with accent trim,
// and the lounge sits dead centre as the heart of the ring.

export const SHELL = 26;
export const ARCH_H = 56;
export const DOOR_W = 40;
const SLOTS = [
  [], [[0.26, 0.3]],
  [[0.26, 0.3], [0.74, 0.3]],
  [[0.26, 0.3], [0.74, 0.3], [0.26, 0.76]],
  [[0.26, 0.3], [0.74, 0.3], [0.26, 0.76], [0.74, 0.76]],
  [[0.26, 0.3], [0.5, 0.3], [0.74, 0.3], [0.26, 0.76], [0.74, 0.76]],
  [[0.26, 0.3], [0.5, 0.3], [0.74, 0.3], [0.26, 0.76], [0.5, 0.76], [0.74, 0.76]],
];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const G = (x, y, s, inner) => `<g transform="translate(${x},${y}) scale(${s.toFixed(3)})">${inner}</g>`;

/** Brick — warmer and darker than the interior plaster. */
function brick(d) {
  const warm = d.id === 'ops';
  return warm
    ? { top: '#8d8681', face: '#736c68', mortar: '#645d59', lip: '#4b4643', glass: '#aab6c2', glassHi: '#cbd4dd', bar: '#8b959e' }
    : { top: '#b47048', face: '#9c5a3c', mortar: '#89492e', lip: '#6f3a24', glass: '#a4c9da', glassHi: '#c9e2ee', bar: '#7ea9bd' };
}

/** Grass verge + the paved apron that lets the building meet the ground. */
function groundDefs(d) {
  const grass = d.id === 'ops' ? '#8d918a' : '#8f9a86';
  const g2 = d.id === 'ops' ? '#82867f' : '#849077';
  const g3 = d.id === 'ops' ? '#979b94' : '#9aa591';
  let blades = '';
  for (let i = 0; i < 36; i++)
    blades += R(Math.floor(scat(i, 21) * 32), Math.floor(scat(i, 22) * 32), 1, 2, scat(i, 23) > 0.5 ? g2 : g3);
  let grit = '';
  for (let i = 0; i < 46; i++)
    grit += R(Math.floor(scat(i, 24) * 32), Math.floor(scat(i, 25) * 32), 2, 1, '#9d998f');
  return `<pattern id="gr-${d.id}" width="32" height="32" patternUnits="userSpaceOnUse">` +
    R(0, 0, 32, 32, grass) + blades + '</pattern>' +
    `<pattern id="ap-${d.id}" width="32" height="32" patternUnits="userSpaceOnUse">` +
    R(0, 0, 32, 32, '#a8a49a') + grit + '</pattern>';
}
function ground(d, W, H, s) {
  const pad = 9;
  return R(0, 0, W, H, `url(#gr-${d.id})`) +
    R(s.x - pad, s.y - pad, s.w + pad * 2, s.h + pad * 2, `url(#ap-${d.id})`);
}

/** The outer brick wall, with windows along the north side. */
function outerWall(d, s) {
  const B = brick(d), T = SHELL, FACE = 10;
  let o = R(s.x - T, s.y - T, s.w + T * 2, T - FACE, B.top);
  o += R(s.x - T, s.y - FACE, s.w + T * 2, FACE - 2, B.face);
  for (let r = 0; r < 2; r++) {
    const py = s.y - FACE + r * 4;
    o += R(s.x - T, py, s.w + T * 2, 1, B.mortar);
    for (let bx = s.x - T + (r % 2) * 7; bx < s.x + s.w + T; bx += 14) o += R(bx, py, 1, 3, B.mortar);
  }
  o += R(s.x - T, s.y - 2, s.w + T * 2, 2, B.lip);
  o += R(s.x - T, s.y + s.h, s.w + T * 2, 3, B.lip);
  o += R(s.x - T, s.y + s.h + 3, s.w + T * 2, T - 3, B.top);
  for (const wx of [s.x - T, s.x + s.w]) {
    o += R(wx, s.y - T, T, s.h + T * 2, B.face);
    o += R(wx, s.y - T, 3, s.h + T * 2, B.top);
    o += R(wx + T - 2, s.y - T, 2, s.h + T * 2, B.lip);
  }
  return o;
}

/** Daylight the north windows throw onto the floor, in flat steps. */
function windowLight(s) {
  let o = '';
  const y0 = s.y + WALL.top + WALL.face;
  for (let wx = s.x + 60; wx < s.x + s.w - 80; wx += 240)
    for (const [inset, len] of [[-8, 26], [-2, 42], [5, 58], [12, 74]])
      o += R(wx + inset, y0, 40 - inset * 2, len, 'rgba(255,244,214,0.045)');
  return o;
}
function outerWindows(d, s) {
  const B = brick(d), T = SHELL;
  let o = '';
  for (let wx = s.x + 60; wx < s.x + s.w - 80; wx += 240) {
    o += R(wx - 2, s.y - T + 2, 44, T - 4, B.lip);
    o += R(wx, s.y - T + 4, 40, T - 8, B.glass);
    o += R(wx, s.y - T + 4, 40, 2, B.glassHi);
    o += R(wx + 19, s.y - T + 4, 2, T - 8, B.bar);
  }
  return o;
}

/** One cell's walls. Left wall always; right only when nothing else draws it. */
function cellWalls(c, d, th) {
  const iY = c.y + WALL.top + WALL.face, iH = c.h - (WALL.top + WALL.face) - WALL.bot;
  const up = c.doorUp;               // matching opening for the room above
  const uw = DOOR_W + 16, ux = up != null ? c.x + up - uw / 2 : 0;
  const topSegs = up != null
    ? [[c.x, ux - c.x], [ux + uw, c.x + c.w - (ux + uw)]]
    : [[c.x, c.w]];
  let o = '';
  for (const [sx, sw] of topSegs) {
    if (sw <= 0) continue;
    o += R(sx, c.y, sw, WALL.top, d.wallTop);
    o += R(sx, c.y + WALL.top, sw, WALL.face, d.wallFace);
    o += R(sx, c.y + WALL.top + WALL.face - 2, sw, 2, d.wallLip);
  }
  if (up != null) {
    o += R(ux, c.y, uw, WALL.top + WALL.face, th.floor);        // threshold
    o += R(ux - 2, c.y, 3, WALL.top + WALL.face, th.accent);
    o += R(ux + uw - 1, c.y, 3, WALL.top + WALL.face, th.accent);
    o += R(ux, c.y, uw, 2, 'rgba(52,36,18,0.28)');
  }
  o += R(c.x, iY, c.w, 3, 'rgba(52,36,18,0.20)');
  const archY0 = iY + iH * 0.5 - ARCH_H / 2, archY1 = archY0 + ARCH_H;
  const side = (wx, arch) => {
    let r = '';
    const seg = (sy, sh) => {
      if (sh <= 0) return;
      r += R(wx, sy, WALL.side, sh, lift(d.wallFace, 1.04));
      r += R(wx, sy, 2, sh, d.wallTop);
      r += R(wx + WALL.side - 1, sy, 1, sh, d.wallLip);
    };
    if (!arch) { seg(c.y, c.h); return r; }
    seg(c.y, archY0 - c.y);
    seg(archY1, c.y + c.h - archY1);
    r += R(wx, archY0, WALL.side, archY1 - archY0, th.floor);   // floor bridges the gap
    r += R(wx - 2, archY0 - 6, WALL.side + 4, 6, th.accent);    // lintel
    r += R(wx - 2, archY1, WALL.side + 4, 6, th.accent);        // sill
    r += R(wx - 2, archY0 - 6, WALL.side + 4, 1, lift(th.accent, 1.5));
    r += R(wx, archY0, WALL.side, 1, 'rgba(52,36,18,0.28)');    // threshold shadow
    return r;
  };
  o += side(c.x, !!c.archLeft);
  o += R(c.x + WALL.side, iY, 2, iH, 'rgba(52,36,18,0.20)');
  if (c.wallRight) {
    o += side(c.x + c.w - WALL.side, false);
    o += R(c.x + c.w - WALL.side - 2, iY, 2, iH, 'rgba(52,36,18,0.20)');
  }
  const by = c.y + c.h - WALL.bot;
  const dw = c.familyDoorDown ? DOOR_W + 16 : DOOR_W;
  const dx = c.x + c.w / 2 - dw / 2;
  for (const [sx, sw] of [[c.x, dx - c.x], [dx + dw, c.x + c.w - (dx + dw)]]) {
    o += R(sx, by, sw, WALL.bot, d.wallFace);
    o += R(sx, by, sw, 2, d.wallTop);
    o += R(sx, by + WALL.bot - 2, sw, 2, d.wallLip);
  }
  const post = c.familyDoorDown ? th.accent : d.wallLip;
  o += R(dx - 2, by - 2, 3, WALL.bot + 2, post);
  o += R(dx + dw - 1, by - 2, 3, WALL.bot + 2, post);
  o += R(dx + 1, by, dw - 2, WALL.bot, th.floor);
  return o;
}

/** The lounge: the heart of the ring. Sofa, low table, plant, coffee. */
function loungeGuts(d, c, s) {
  const iY = c.y + WALL.top + WALL.face, iH = c.h - (WALL.top + WALL.face) - WALL.bot;
  const cx = c.x + c.w / 2, cy = iY + iH * 0.52;
  const wood = d.id === 'ops' ? '#6b6a66' : '#8a4a3a';
  const woodHi = d.id === 'ops' ? '#828079' : '#a05a46';
  const rug = d.id === 'ops' ? '#7f858c' : d.id === 'cozy' ? '#b98b62' : '#6f7f96';
  const rugHi = d.id === 'ops' ? '#939aa2' : d.id === 'cozy' ? '#cfa079' : '#8695ac';
  // a rug, so the middle of the room is a place rather than an expanse
  let o = `<ellipse cx="${cx}" cy="${cy}" rx="104" ry="52" fill="${rug}"/>`;
  o += `<ellipse cx="${cx}" cy="${cy}" rx="104" ry="52" fill="none" stroke="${rugHi}" stroke-width="3"/>`;
  o += `<ellipse cx="${cx}" cy="${cy}" rx="86" ry="41" fill="none" stroke="${rugHi}" stroke-width="2" opacity=".55"/>`;
  const sx = cx - 30, sy = cy - 30;
  o += R(sx - 7, sy - 1, 74, 12, d.K);                  // sofa
  o += R(sx, sy, 60, 10, wood);
  o += R(sx, sy, 60, 3, woodHi);
  o += R(sx - 6, sy + 4, 8, 18, wood);
  o += R(sx + 58, sy + 4, 8, 18, wood);
  o += R(sx + 2, sy + 10, 27, 10, woodHi);
  o += R(sx + 31, sy + 10, 27, 10, woodHi);
  o += `<ellipse cx="${cx}" cy="${sy + 24}" rx="36" ry="5" fill="rgba(0,0,0,0.3)"/>`;
  o += R(cx - 15, cy + 7, 30, 10, d.K);                 // low table
  o += R(cx - 14, cy + 8, 28, 8, '#4a3b2c');
  o += R(cx - 14, cy + 8, 28, 2, '#5d4a37');
  o += R(cx - 12, cy + 16, 3, 4, '#32281d');
  o += R(cx + 9, cy + 16, 3, 4, '#32281d');
  o += R(cx - 3, cy + 4, 5, 4, '#e8edf6');              // mug
  for (const ox of [-84, 84]) {                          // a stool either side
    o += R(cx + ox - 9, cy - 6, 18, 14, d.K);
    o += R(cx + ox - 8, cy - 5, 16, 12, d.seat);
    o += R(cx + ox - 7, cy - 4, 14, 2, d.seatHi);
  }
  o += plantRects(d, c.x + WALL.side + 18, c.y + c.h - WALL.bot - 3);
  const mx = c.x + c.w - WALL.side - 22, my = c.y + c.h - WALL.bot - 3;
  o += R(mx - 9, my - 24, 18, 24, d.K);                 // coffee machine
  o += R(mx - 8, my - 23, 16, 22, d.steel);
  o += R(mx - 8, my - 23, 16, 3, d.steelHi);
  o += R(mx - 5, my - 16, 10, 6, '#2b2119');
  o += R(mx - 3, my - 8, 6, 2, '#c4564a');
  // wall clock, on the top wall where a clock would hang
  const kx = c.x + c.w - 26, ky = c.y + 11;
  o += `<circle cx="${kx}" cy="${ky}" r="7" fill="${d.K}"/>`;
  o += `<circle cx="${kx}" cy="${ky}" r="6" fill="${d.wallTop}"/>`;
  o += R(kx - 1, ky - 4, 2, 5, d.K);
  o += R(kx, ky, 4, 2, d.K);
  void s;
  return o;
}

/**
 * The whole floor plan. `cells` carry their own room content; the ring layout
 * (lounge dead centre) is the shape the renderer produces for >= 4 rooms.
 */
export function buildingSVG(dirKey, cells, W, H, origin) {
  const d = DIRECTIONS[dirKey];
  const shell = { x: origin.x, y: origin.y, w: W, h: H };
  let defs = groundDefs(d), body = ground(d, W + origin.x * 2, H + origin.y * 2, shell);
  const seen = new Set();
  for (const c of cells) {
    const th = c.lounge
      ? { floor: floorTone('#bfae92', d), alt: floorTone('#b5a488', d), seam: floorTone('#9c8c70', d),
          accent: '#8a7a63', mat: 'wood', pid: 'cp-lounge-' + dirKey }
      : tones(c.theme, dirKey);
    if (th.mat === 'carpet' && !seen.has(th.pid)) { defs += carpetPattern(th); seen.add(th.pid); }
    const g = { ...c, x: c.x + origin.x, y: c.y + origin.y };
    const iY = g.y + WALL.top + WALL.face, iH = g.h - (WALL.top + WALL.face) - WALL.bot;
    body += floorRects(g.x, iY, g.w, iH, th, th.mat);
    body += cellWalls(g, d, th);
    body += R(g.x, iY, g.w, iH, `rgba(28,38,74,${d.veil})`);
    const s = clamp(Math.min(g.w / 320, g.h / 215), 0.62, 1.08);
    if (c.lounge) { body += loungeGuts(d, g, s); continue; }
    const iX = g.x + WALL.side, iW = g.w - WALL.side * 2;
    const statuses = c.agents ?? [];
    const slots = SLOTS[Math.min(statuses.length + 1, 6)] ?? SLOTS[6];
    slots.forEach(([fx, fy], i) => {
      const cx = Math.round(iX + fx * iW);
      const seatY = iY + fy * iH - 26 * s;
      const top = Math.round(seatY + 30 * s);
      body += i < statuses.length
        ? G(cx, top, s, deskUnit(dirKey, 0, 0, statuses[i]))
        : G(cx, top, s, ghostDesk(d, 0, 0));
    });
    if (c.plant) body += plantRects(d, g.x + WALL.side + 14, g.y + g.h - WALL.bot - 3);
  }
  body += windowLight(shell);
  body += outerWall(d, shell);
  body += outerWindows(d, shell);
  return { defs, body };
}

// ---- open-plan office map ---------------------------------------------------
// A different building idea: instead of a grid of sealed rectangular cells,
// ONE continuous floor on a 16px tile grid, where a project reads as a ZONE —
// its own carpet, waist-high glass partitions you can see over, a bench its
// agents share, and open sides onto a circulation corridor. Shared space
// (lounge, meeting room, kitchen) is furniture on the same floor, not a cell.

export const TILE = 16;
const t = (n) => n * TILE;

/** The floor everything stands on: pale boards, running unbroken end to end. */
function baseFloor(d, x, y, w, h) {
  const pale = d.id === 'ops' ? '#b9bcbe' : d.id === 'cozy' ? '#d8c3a4' : '#cabfa9';
  const alt = d.id === 'ops' ? '#b2b5b8' : d.id === 'cozy' ? '#d0baa0' : '#c3b8a2';
  const seam = d.id === 'ops' ? '#a2a5a8' : d.id === 'cozy' ? '#bda78c' : '#b0a58f';
  let o = R(x, y, w, h, pale);
  const plank = 12, len = 200;
  for (let r = 0; r < Math.ceil(h / plank); r++) {
    const py = y + r * plank, ph = Math.min(plank, y + h - py), off = (r % 4) * 50;
    let c = 0;
    for (let bx = x - len + off; bx < x + w; bx += len, c++) {
      const bx0 = Math.max(x, bx), bw = Math.min(bx + len, x + w) - bx0;
      if (bw > 0 && scat(r * 13 + c, 31) > 0.76) o += R(bx0, py, bw, ph - 1, alt);
      if (bx > x && bx < x + w) o += R(bx, py, 1, ph - 1, seam);
    }
    o += R(x, py + ph - 1, w, 1, seam);
  }
  return o;
}

/** A zone's carpet: the project's colour, with a bound edge. */
function zoneCarpet(d, th, z) {
  const x = t(z.x), y = t(z.y), w = t(z.w), h = t(z.h);
  let o = R(x, y, w, h, `url(#${th.pid})`);
  o += R(x, y, w, 2, th.seam);            // bound edge
  o += R(x, y + h - 2, w, 2, th.seam);
  o += R(x, y, 2, h, th.seam);
  o += R(x + w - 2, y, 2, h, th.seam);
  o += R(x, y, w, 1, 'rgba(255,255,255,0.10)');
  return o;
}

/** Waist-high glass: you can see the whole floor, the zone still has an edge. */
const GLASS = { fill: 'rgba(196,226,240,0.42)', hi: 'rgba(255,255,255,0.62)', lo: 'rgba(64,102,122,0.45)' };
function glass(d, x, y, len, vertical) {
  const th = 5;
  const post = d.steelDark;
  let o = '';
  if (vertical) {
    o += R(x + th, y, 2, len, 'rgba(52,36,18,0.16)');       // contact shadow
    o += R(x, y, th, len, GLASS.fill);
    o += R(x, y, 2, len, GLASS.hi);
    o += R(x + th - 1, y, 1, len, GLASS.lo);
    for (let p = 0; p <= len - 6; p += 64) o += R(x - 1, y + p, th + 2, 6, post);
    o += R(x - 1, y + len - 6, th + 2, 6, post);
  } else {
    o += R(x, y + th, len, 2, 'rgba(52,36,18,0.16)');
    o += R(x, y, len, th, GLASS.fill);
    o += R(x, y, len, 2, GLASS.hi);
    o += R(x, y + th - 1, len, 1, GLASS.lo);
    for (let p = 0; p <= len - 6; p += 64) o += R(x + p, y - 1, 6, th + 2, post);
    o += R(x + len - 6, y - 1, 6, th + 2, post);
  }
  return o;
}

/**
 * A shared bench: one long surface with N places along it, which is how an
 * open-plan office actually seats a team (and matches the TeamPod the renderer
 * already has). Replaces N isolated desks scattered across a room.
 */
export function bench(dirKey, cx, top, statuses) {
  const d = DIRECTIONS[dirKey];
  const pitch = 58;
  const n = statuses.length;
  const w = n * pitch + 10;
  const x0 = cx - w / 2;
  const seatX = (i) => Math.round(x0 + 5 + pitch * i + pitch / 2);
  let o = '';
  for (let i = 0; i < n; i++) {
    const s = statuses[i];
    if (s === 'working' || s === 'done')
      o += `<ellipse cx="${seatX(i)}" cy="${top - 2}" rx="42" ry="24" fill="${STATUS[s]}" opacity=".10"/>`;
  }
  for (let i = 0; i < n; i++) o += chairRects(d, seatX(i), top);
  for (let i = 0; i < n; i++) o += robot(dirKey, statuses[i], 1, seatX(i) - 11, top - 28, { seated: true });
  o += `<ellipse cx="${cx}" cy="${top + 27}" rx="${w / 2 + 4}" ry="4" fill="rgba(52,36,18,0.22)"/>`;
  o += R(x0 - 1, top - 1, w + 2, 29, d.K);
  o += R(x0, top, w, 22, d.oak);
  o += R(x0, top, w, 3, d.oakHi);
  o += R(x0, top + 22, w, 4, d.oakEdge);
  o += R(x0 + 3, top + 27, 3, 4, d.oakDark);
  o += R(x0 + w - 6, top + 27, 3, 4, d.oakDark);
  for (let i = 0; i < n; i++) o += workstationRects(d, seatX(i), top + 1, statuses[i]);
  return o;
}

/** A chair from above. `dir` is -1 when the backrest is on the north side. */
function chairTop(d, cx, cy, dir) {
  let o = `<ellipse cx="${cx}" cy="${cy + 9}" rx="13" ry="4" fill="rgba(52,36,18,0.20)"/>`;
  o += R(cx - 12, cy + dir * 10 - 4, 24, 8, d.K);         // backrest, far side
  o += R(cx - 11, cy + dir * 10 - 3, 22, 6, d.seat);
  o += R(cx - 11, cy + dir * 10 - 3, 22, 2, d.seatHi);
  o += R(cx - 10, cy - 8, 20, 16, d.K);                   // seat pad, facing up
  o += R(cx - 9, cy - 7, 18, 14, d.seatHi);
  o += R(cx - 7, cy - 5, 14, 9, lift(d.seatHi, 1.18));    // cushion crown
  o += R(cx - 9, cy + 5, 18, 2, d.seatDark);              // front lip
  for (const ax of [cx - 12, cx + 9]) {                   // armrests
    o += R(ax, cy - 6, 3, 11, d.K);
    o += R(ax, cy - 5, 3, 9, d.seatDark);
  }
  return o;
}

/** A bookshelf against a partition — the prop that makes a corridor a place. */
function shelf(d, cx, baseY) {
  let o = R(cx - 20, baseY - 30, 40, 30, d.K);
  o += R(cx - 19, baseY - 29, 38, 28, d.oakEdge);
  o += R(cx - 19, baseY - 29, 38, 3, d.oak);
  const books = ['#c4564a', '#d9a441', '#4e8a52', '#5b8fc9', '#a06ab5', '#d97a4a'];
  for (let r = 0; r < 2; r++)
    for (let i = 0; i < 8; i++) {
      const bx = cx - 16 + i * 4;
      const bh = 6 + Math.floor(scat(r * 8 + i, 41) * 3);
      o += R(bx, baseY - 24 + r * 12 + (9 - bh), 3, bh,
             d.id === 'ops' ? '#8c939b' : books[(r * 8 + i) % 6]);
    }
  return o;
}

/** A glass-walled meeting room: an enclosed space you can still see into. */
function meetingRoom(d, z) {
  const x = t(z.x), y = t(z.y), w = t(z.w), h = t(z.h);
  const cx = x + w / 2, cy = y + h / 2;
  let o = R(x, y, w, h, d.id === 'ops' ? '#a9adb0' : '#b9ac93');
  for (let gy = y; gy < y + h; gy += 34) o += R(x, gy, w, 1, 'rgba(0,0,0,0.06)');
  for (let gx = x; gx < x + w; gx += 34) o += R(gx, y, 1, h, 'rgba(0,0,0,0.06)');
  const door = 56;
  o += glass(d, x, y, w, false);
  o += glass(d, x, y, h, true);
  o += glass(d, x + w - 5, y, h, true);
  o += glass(d, x, y + h - 5, (w - door) / 2, false);
  o += glass(d, x + (w + door) / 2, y + h - 5, (w - door) / 2, false);
  // table + seats
  for (const [ox, oy] of [[-52, -42], [0, -46], [52, -42]]) o += chairTop(d, cx + ox, cy + oy, -1);
  for (const [ox, oy] of [[-52, 40], [0, 44], [52, 40]]) o += chairTop(d, cx + ox, cy + oy, 1);
  o += `<ellipse cx="${cx}" cy="${cy + 5}" rx="74" ry="34" fill="rgba(52,36,18,0.24)"/>`;
  o += `<ellipse cx="${cx}" cy="${cy}" rx="74" ry="33" fill="${d.K}"/>`;
  o += `<ellipse cx="${cx}" cy="${cy - 1}" rx="71" ry="30" fill="${d.oakEdge}"/>`;
  o += `<ellipse cx="${cx}" cy="${cy - 3}" rx="69" ry="28" fill="${d.oak}"/>`;
  o += `<ellipse cx="${cx}" cy="${cy - 8}" rx="58" ry="17" fill="${d.oakHi}" opacity=".5"/>`;
  o += R(cx - 20, cy - 6, 14, 10, d.steelHi);    // a laptop left on the table
  o += R(cx - 20, cy - 6, 14, 2, '#ffffff');
  o += R(cx + 10, cy - 2, 5, 5, '#c4564a');      // and a mug
  o += R(cx - 44, y + 8, 88, 6, d.K);            // whiteboard on the far wall
  o += R(cx - 43, y + 9, 86, 4, '#eef2f6');
  o += R(cx - 38, y + 10, 26, 1, '#94a3b8');
  o += R(cx - 38, y + 12, 40, 1, '#94a3b8');
  return o;
}

/** Kitchen nook: counter, fridge, machine — furniture, not a room. */
function kitchen(d, z) {
  const x = t(z.x), y = t(z.y), w = t(z.w);
  let o = R(x, y, w, 30, d.K);                    // counter run
  o += R(x + 1, y + 1, w - 2, 24, d.steel);
  o += R(x + 1, y + 1, w - 2, 4, d.steelHi);
  o += R(x + 1, y + 25, w - 2, 4, d.steelDark);
  for (let i = 1; i < 4; i++) o += R(x + (w / 4) * i, y + 1, 1, 24, d.steelDark);
  o += R(x + 22, y + 9, 30, 10, d.id === 'ops' ? '#7d858c' : '#6f8ba0');  // sink
  const fx = x + w - 40;
  o += R(fx, y - 46, 38, 46, d.K);                // fridge
  o += R(fx + 1, y - 45, 36, 44, d.steelHi);
  o += R(fx + 1, y - 45, 36, 4, '#ffffff');
  o += R(fx + 1, y - 22, 36, 2, d.steelDark);
  o += R(fx + 28, y - 17, 3, 10, d.steelDark);
  const mx = x + 14;
  o += R(mx - 9, y - 26, 18, 26, d.K);            // coffee machine
  o += R(mx - 8, y - 25, 16, 24, d.steel);
  o += R(mx - 8, y - 25, 16, 3, d.steelHi);
  o += R(mx - 5, y - 17, 10, 6, '#2b2119');
  o += R(mx - 3, y - 9, 6, 2, '#c4564a');
  return o;
}

/** The lounge, as an area on the open floor rather than a walled cell. */
function loungeArea(d, z) {
  const x = t(z.x), y = t(z.y), w = t(z.w), h = t(z.h);
  const cx = x + w / 2, cy = y + h / 2;
  const rug = d.id === 'ops' ? '#7f858c' : d.id === 'cozy' ? '#c08d61' : '#6f7f96';
  const rugHi = d.id === 'ops' ? '#939aa2' : d.id === 'cozy' ? '#d6a87e' : '#8695ac';
  const rx = w / 2 - 26, ry = h / 2 - 16;
  let o = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${rug}"/>`;
  o += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${rugHi}" stroke-width="3"/>`;
  o += `<ellipse cx="${cx}" cy="${cy}" rx="${rx - 16}" ry="${ry - 12}" fill="none" stroke="${rugHi}" stroke-width="2" opacity=".5"/>`;
  const wood = d.id === 'ops' ? '#6b6a66' : '#8a4a3a';
  const woodHi = d.id === 'ops' ? '#828079' : '#a05a46';
  const sofa = (sx, sy) => {
    let r = R(sx - 7, sy - 1, 74, 12, d.K);
    r += R(sx, sy, 60, 10, wood);
    r += R(sx, sy, 60, 3, woodHi);
    r += R(sx - 6, sy + 4, 8, 18, wood);
    r += R(sx + 58, sy + 4, 8, 18, wood);
    r += R(sx + 2, sy + 10, 27, 10, woodHi);
    r += R(sx + 31, sy + 10, 27, 10, woodHi);
    r += `<ellipse cx="${sx + 30}" cy="${sy + 24}" rx="36" ry="5" fill="rgba(0,0,0,0.3)"/>`;
    return r;
  };
  o += sofa(cx - 30, cy - 40);
  o += R(cx - 18, cy + 6, 36, 12, d.K);           // coffee table
  o += R(cx - 17, cy + 7, 34, 10, '#4a3b2c');
  o += R(cx - 17, cy + 7, 34, 2, '#5d4a37');
  o += R(cx - 15, cy + 17, 3, 4, '#32281d');
  o += R(cx + 12, cy + 17, 3, 4, '#32281d');
  o += R(cx - 4, cy + 2, 5, 4, '#e8edf6');
  o += chairTop(d, cx - 86, cy + 2, -1);           // armchairs round the table
  o += chairTop(d, cx + 86, cy + 2, -1);
  o += chairTop(d, cx - 34, cy + 44, 1);
  o += chairTop(d, cx + 34, cy + 44, 1);
  o += plantRects(d, x + 22, y + h - 10);
  o += plantRects(d, x + w - 22, y + 34);
  return o;
}

/** The whole open-plan floor. `zones` are tile rects; corridors are what's left. */
export function officeSVG(dirKey, zones, cols, rows, origin, walkers = [], opt = {}) {
  const d = DIRECTIONS[dirKey];
  const night = !!opt.night;
  const W = t(cols), H = t(rows);
  const shell = { x: origin.x, y: origin.y, w: W, h: H };
  let defs = groundDefs(d);
  const seenP = new Set();
  for (const z of zones) {
    if (!z.theme) continue;
    const th = tones(z.theme, dirKey);
    if (!seenP.has(th.pid)) { defs += carpetPattern(th); seenP.add(th.pid); }
  }
  let body = ground(d, W + origin.x * 2, H + origin.y * 2, shell);
  if (night) body += R(0, 0, W + origin.x * 2, H + origin.y * 2, 'rgba(8,12,30,0.62)');

  let g = baseFloor(d, 0, 0, W, H);
  if (!night)
    for (let wx = 60; wx < W - 80; wx += 240)
      for (const [inset, len] of [[-8, 26], [-2, 42], [5, 58], [12, 74]])
        g += R(wx + inset, 0, 40 - inset * 2, len, 'rgba(255,244,214,0.05)');

  // --- pass 1: the room itself
  for (const z of zones) {
    if (z.kind === 'meeting') { g += meetingRoom(d, z); continue; }
    if (z.kind === 'kitchen') { g += kitchen(d, z); continue; }
    if (z.kind === 'lounge') { g += loungeArea(d, z); continue; }
    const th = tones(z.theme, dirKey);
    g += zoneCarpet(d, th, z);
    const x = t(z.x), y = t(z.y), w = t(z.w), h = t(z.h);
    g += glass(d, x, y, w, false);
    g += glass(d, x, y, h, true);
    g += glass(d, x + w - 5, y, h, true);
    g += plantRects(d, x + 18, y + h - 12);
    if (z.shelf) g += shelf(d, x + w - 34, y + h - 10);
  }

  // --- pass 2: light. Night falls on the ROOM, then lamps carve it back out;
  //     benches and agents draw after, so they stay readable in the dark.
  g += R(0, 0, W, H, night ? 'rgba(10,16,38,0.60)' : `rgba(28,38,74,${d.veil})`);
  if (night) {
    for (let wx = 60; wx < W - 80; wx += 240) g += pool(wx + 20, 26, 60, '#b2cbff', 0.10);
    for (const z of zones) {
      if (!z.agents) continue;
      const x = t(z.x), w = t(z.w), h = t(z.h), y = t(z.y);
      const lit = z.agents.filter((a) => a !== 'idle').length;
      if (lit) g += pool(x + w / 2, Math.round(y + h * 0.55) - 6, 96, '#ffd68c', 0.20);
    }
  }
  for (const z of zones) {                       // zone-level status halo
    if (!z.agents) continue;
    const need = z.agents.includes('error') ? STATUS.error
      : z.agents.includes('waiting_input') ? STATUS.waiting_input : null;
    if (need && opt.zoneStatus !== false) g += zoneGlow(z, need);
  }

  // --- pass 3: the people and what they sit at
  for (const z of zones) {
    if (!z.agents) continue;
    const x = t(z.x), y = t(z.y), w = t(z.w), h = t(z.h);
    g += bench(dirKey, x + w / 2, Math.round(y + h * 0.55), z.agents);
    if (z.board) g += pinboard(d, x + w / 2, y + 6, z.notes ?? ['ship the parser', 'review #412', 'flaky test']);
  }
  for (const [wx, wy, st] of walkers) {
    g += `<ellipse cx="${wx}" cy="${wy + 34}" rx="11" ry="3" fill="rgba(0,0,0,0.3)"/>`;
    g += robot(dirKey, st, 1, wx - 11, wy);
  }
  body += `<g transform="translate(${origin.x},${origin.y})">` + g + '</g>';
  body += outerWall(d, shell);
  body += outerWindows(d, shell);
  if (night) body += R(shell.x - SHELL, shell.y - SHELL, shell.w + SHELL * 2, shell.h + SHELL * 2, 'rgba(8,12,30,0.42)');
  return { defs, body };
}

// ---- ideas on top of the open floor -----------------------------------------

/** Flat concentric rings — never a gradient, which is the product's rule. */
export function pool(cx, cy, r, color, alpha) {
  const per = 1 - Math.pow(1 - alpha, 1 / 4);
  return [1.32, 1, 0.66, 0.36]
    .map((k) => `<circle cx="${cx}" cy="${cy}" r="${Math.round(r * k)}" fill="${color}" opacity="${per.toFixed(3)}"/>`)
    .join('');
}

/**
 * The ZONE carries the status, not just the agent in it.
 * A 22px sprite is a small target at true size; a whole carpet edge is not.
 */
export function zoneGlow(z, color) {
  const x = t(z.x), y = t(z.y), w = t(z.w), h = t(z.h);
  let o = '';
  for (const [pad, sw, a] of [[17, 12, 0.07], [10, 9, 0.11], [5, 6, 0.16]])
    o += `<rect x="${x - pad}" y="${y - pad}" width="${w + pad * 2}" height="${h + pad * 2}" rx="${pad + 2}" ` +
         `fill="none" stroke="${color}" stroke-width="${sw}" opacity="${a}"/>`;
  o += `<rect x="${x - 2}" y="${y - 2}" width="${w + 4}" height="${h + 4}" rx="3" fill="none" stroke="${color}" stroke-width="3" opacity=".85"/>`;
  return o;
}

/** The pinboard, showing the room's actual notes instead of a blank rectangle. */
export function pinboard(d, cx, y, notes) {
  const w = 74, h = 26, x = cx - w / 2;
  let o = R(x - 2, y - 2, w + 4, h + 4, d.K);
  o += R(x, y, w, h, '#c9bda2');
  o += R(x, y, w, 1, '#ded3ba');
  const cols = ['#fbbf24', '#4ade80', '#f87171', '#5b9dff', '#a78bfa', '#fb923c'];
  notes.slice(0, 6).forEach((n, i) => {
    const nx = x + 4 + (i % 3) * 23, ny = y + 3 + Math.floor(i / 3) * 11;
    o += R(nx, ny, 19, 9, cols[i % 6]);
    o += R(nx, ny, 19, 1, 'rgba(255,255,255,0.45)');
    o += R(nx + 2, ny + 3, Math.max(6, Math.min(15, n.length)), 1, 'rgba(0,0,0,0.32)');
    if (n.length > 10) o += R(nx + 2, ny + 5, Math.min(11, n.length - 6), 1, 'rgba(0,0,0,0.32)');
  });
  return o;
}

/** A team convening: the three of them leave their bench and sit at the table. */
export function teamAtTable(dirKey, z, roles) {
  const d = DIRECTIONS[dirKey];
  const x = t(z.x), y = t(z.y), w = t(z.w), h = t(z.h);
  const cx = x + w / 2, cy = y + h / 2;
  let o = '';
  // north side only: those seats face the viewer, which is the sprite we have
  const seats = [[-56, -46], [0, -50], [56, -46]];
  seats.forEach(([ox], i) => { void ox; void i; });
  seats.forEach(([ox, oy]) => { o += chairTop(d, cx + ox, cy + oy, -1); });
  seats.forEach(([ox, oy], i) => {
    o += robot(dirKey, roles[i].status, 1, cx + ox - 11, cy + oy - 20, { seated: true });
    const bx = cx + ox - 16;
    o += R(bx - 1, cy + oy + 11, 34, 11, d.K);              // role badge under the seat
    o += R(bx, cy + oy + 12, 32, 9, '#0f131c');
    o += R(bx, cy + oy + 12, 32, 1, roles[i].color);
  });
  o += `<ellipse cx="${cx}" cy="${cy + 5}" rx="74" ry="34" fill="rgba(52,36,18,0.24)"/>`;
  o += `<ellipse cx="${cx}" cy="${cy}" rx="74" ry="33" fill="${d.K}"/>`;
  o += `<ellipse cx="${cx}" cy="${cy - 1}" rx="71" ry="30" fill="${d.oakEdge}"/>`;
  o += `<ellipse cx="${cx}" cy="${cy - 3}" rx="69" ry="28" fill="${d.oak}"/>`;
  o += `<ellipse cx="${cx}" cy="${cy - 8}" rx="58" ry="17" fill="${d.oakHi}" opacity=".5"/>`;
  o += R(cx - 20, cy + 4, 16, 11, d.steelHi);
  o += R(cx - 20, cy + 4, 16, 2, '#ffffff');
  o += R(cx + 12, cy + 6, 5, 5, '#c4564a');
  return o;
}
