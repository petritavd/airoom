// Pixel-art source for the airoom redesign.
// Sprites are char maps; scenes are parametric. Everything emits SVG <rect>s
// on an integer art-pixel grid, which is the SVG equivalent of the renderer's
// ART_PIXEL=2 + imageSmoothingEnabled=false discipline.

export const STATUS = {
  working: '#4ade80',
  waiting_input: '#fbbf24',
  idle: '#5b6b86',
  error: '#f87171',
  done: '#34d399',
};

// ---- the three directions ---------------------------------------------------
// Each supplies the same legend keys, so one sprite map renders in all three.

export const DIRECTIONS = {
  bold: {
    id: 'bold',
    name: 'Bold 16-bit',
    K: '#141925',   // hard keyline
    H: '#eef3fb',   // shell, sun side
    M: '#c2cde1',   // shell, mid
    D: '#93a0b8',   // shell, shadow side
    V: '#161c29',   // visor glass
    A: '#93a0b8', a: '#74819a',
    L: '#a7b3c8', l: '#7d8aa1',
    // world
    wallTop: '#f6efe2', wallFace: '#dccfb6', wallLip: '#8b7c63',
    oakHi: '#e0b177', oak: '#c08d51', oakEdge: '#8a6238', oakDark: '#5e4022',
    seatHi: '#5f6a85', seat: '#4a5268', seatDark: '#2b3140',
    bezel: '#141925', bezelHi: '#39415a',
    steelHi: '#dbe2ee', steel: '#98a1af', steelDark: '#5c6470',
    floorLift: 1.10,   // materials read LIT
    veil: 0.14,        // night is a mood, not a blackout
    outline: true,
  },
  cozy: {
    id: 'cozy',
    name: 'Cozy office sim',
    K: '#6f5947',   // warm dark keyline, not black
    H: '#fbf1e2',
    M: '#e3cdb2',
    D: '#bfa286',
    V: '#4a3b30',
    A: '#c0a486', a: '#9c8064',
    L: '#d3ba9c', l: '#ab8d70',
    wallTop: '#fdf4e4', wallFace: '#e8d5b6', wallLip: '#9a8265',
    oakHi: '#e6b981', oak: '#c9955b', oakEdge: '#95692f', oakDark: '#6b4a29',
    seatHi: '#87aaa4', seat: '#67908a', seatDark: '#44665f',
    bezel: '#4a3b30', bezelHi: '#6f5947',
    steelHi: '#eee3d2', steel: '#b3a594', steelDark: '#7d6f5c',
    floorLift: 1.16,
    veil: 0.08,
    outline: true,
  },
  ops: {
    id: 'ops',
    name: 'Ops console',
    K: '#0d1017',
    H: '#e3e8ee',
    M: '#b0b8c3',
    D: '#7b838f',
    V: '#0f131a',
    A: '#828a95', a: '#636b75',
    L: '#9aa2ad', l: '#6e757f',
    wallTop: '#e7e9ec', wallFace: '#c4c8cd', wallLip: '#767a80',
    oakHi: '#7b828b', oak: '#5f666f', oakEdge: '#454b53', oakDark: '#2f343a',
    seatHi: '#727a86', seat: '#5a616b', seatDark: '#3a4048',
    bezel: '#0d1017', bezelHi: '#2b313b',
    steelHi: '#d6dae0', steel: '#9aa1aa', steelDark: '#5f666f',
    floorLift: 1.06,   // neutral and light; desat is what makes status the only chroma
    desat: 0.86,
    veil: 0.10,
    outline: true,
  },
};

// ---- sprite maps ------------------------------------------------------------
// 22 art px wide. Head-top at row 4. Seated ends at row 25 (no legs), standing
// at row 31. S = status colour, and it is a LARGE share of the silhouette:
// a 4x2 antenna bulb, a 6x2 visor bar and a 6x6 chest plate, so state reads
// from across the room instead of from two 2px eyes.

export const ROBOT = [
  '..........KK..........',
  '.........KSSK.........',
  '.........KSSK.........',
  '..........KK..........',
  '.....KKKKKKKKKKKK.....',
  '.....KHHHHHHHHHHK.....',
  '.....KHHHHHHHHHHK.....',
  '.....KMVVVVVVVVMK.....',
  '.....KMVSSSSSSVMK.....',
  '.....KMVSSVVSSVMK.....',
  '.....KMVVVVVVVVMK.....',
  '.....KMMMMMMMMMMK.....',
  '.....KDDDDDDDDDDK.....',
  '.....KKKKKKKKKKKK.....',
  '..........KK..........',
  '....KKKKKKKKKKKKKK....',
  '....KHHHHHHHHHHHHK....',
  '....KHHHHHHHHHHHHK....',
  'KAAAAMMMSSSSSSMMMAAAAK',
  'KAAAAMMMSSSSSSMMMAAAAK',
  'KAAKKMMMSSSSSSMMMKKAAK',
  'KAAKKMMMSSSSSSMMMKKAAK',
  'KAAKKMMMMMMMMMMMMKKAAK',
  'KAAKKDDDDDDDDDDDDKKAAK',
  'KKKKKDDDDDDDDDDDDKKKKK',
  '....KKKKKKKKKKKKKK....',
  '......KKKK..KKKK......',
  '......KLLK..KLLK......',
  '......KLLK..KLLK......',
  '......KLLK..KLLK......',
  '......KllK..KllK......',
  '......KKKK..KKKK......',
];
export const ROBOT_SEATED_ROWS = 26; // rows 0..25 — torso bottom, no legs

// The CURRENT sprite, reproduced from draw.ts drawRobot() at its real
// proportions and its real colours, for an honest before/after.
export const ROBOT_OLD = [
  '.........SSSS.........',
  '.........SSSS.........',
  '.........SSSS.........',
  '..........MM..........',
  '....HHHHHHHHHHHHHH....',
  '....HHHHHHHHHHHHHH....',
  '....HHHHHHHHHHHHHH....',
  '....PPPPPPPPPPPPPP....',
  '....PPVVVVVVVVVVPP....',
  '....PPVVEEVVEEVVPP....',
  '....PPVVEEVVEEVVPP....',
  '....PPVVVVVVVVVVPP....',
  '....PPVVVVVVVVVVPP....',
  '....PPPPPPPPPPPPPP....',
  '....PPPPPPPPPPPPPP....',
  '....PPPPPPPPPPPPPP....',
  '....PPPPPPPPPPPPPP....',
  '......................',
  '...TTTTTTTTTTTTTTTT...',
  '...TTTTTTTTTTTTTTTT...',
  'AAATTTTTTTTTTTTTTTTAAA',
  'AAABBBBBBBBBBBBBBBBAAA',
  'AAABBBBBCCCCCCBBBBBAAA',
  'AAABBBBBCCCCCCBBBBBAAA',
  'AAABBBBBCCCCCCBBBBBAAA',
  'AAABBBBBCCCCCCBBBBBAAA',
  'AAABBBBBBBBBBBBBBBBAAA',
  'AAABBBBBBBBBBBBBBBBAAA',
  '...BBBBBBBBBBBBBBBB...',
  '...BBBBBBBBBBBBBBBB...',
  '...BBBBBBBBBBBBBBBB...',
  '...BBBBBBBBBBBBBBBB...',
  '......LLLL..LLLL......',
  '......LLLL..LLLL......',
  '......LLLL..LLLL......',
  '......LLLL..LLLL......',
  '......LLLL..LLLL......',
  '......LLLL..LLLL......',
  '......LLLL..LLLL......',
  '......LLLL..LLLL......',
];
export const OLD_LEGEND = {
  S: null, M: '#9aa6ba', H: '#c3ccdb', P: '#e6ebf3', V: '#161b26',
  E: null, T: '#9aa6ba', B: '#c3ccdb', C: null, A: '#9aa6ba', L: '#8b97ab',
};

// ---- emitter ---------------------------------------------------------------

export function rect(x, y, w, h, c, extra = '') {
  if (w <= 0 || h <= 0 || !c) return '';
  const r = (n) => (Number.isInteger(n) ? n : Math.round(n * 100) / 100);
  return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="${c}"${extra}/>`;
}

/** Char map -> merged rects. Horizontal run-length, then vertical coalescing. */
export function mapRects(map, legend, px, ox = 0, oy = 0) {
  const w = map[0].length;
  for (const row of map) {
    if (row.length !== w) throw new Error(`ragged sprite row (${row.length} vs ${w}): ${row}`);
  }
  const runs = [];
  map.forEach((row, y) => {
    let x = 0;
    while (x < w) {
      const ch = row[x];
      if (ch === '.') { x++; continue; }
      let n = 1;
      while (x + n < w && row[x + n] === ch) n++;
      runs.push({ x, y, w: n, h: 1, ch });
      x += n;
    }
  });
  // vertical coalesce: same x, same width, same char, next row
  const byKey = new Map();
  const out = [];
  for (const r of runs) {
    const key = `${r.x}:${r.w}:${r.ch}`;
    const prev = byKey.get(key);
    if (prev && prev.y + prev.h === r.y) prev.h += 1;
    else { const nr = { ...r }; out.push(nr); byKey.set(key, nr); }
  }
  return out
    .map((r) => {
      const c = legend[r.ch];
      return c ? rect(ox + r.x * px, oy + r.y * px, r.w * px, r.h * px, c) : '';
    })
    .join('');
}

/** Legend for the new robot in a given direction, tinted by status. */
export function robotLegend(dir, status) {
  const s = STATUS[status];
  const d = DIRECTIONS[dir];
  return { K: d.K, H: d.H, M: d.M, D: d.D, V: d.V, A: d.A, a: d.a, L: d.L, l: d.l, S: s };
}
export function oldLegend(status) {
  const s = STATUS[status];
  const lit = status === 'working' || status === 'done';
  return { ...OLD_LEGEND, S: s, C: s, E: lit ? s : '#3a465e' };
}

/** Draw the new robot. `seated` clips the legs off. */
export function robot(dir, status, px, ox, oy, { seated = false } = {}) {
  const map = seated ? ROBOT.slice(0, ROBOT_SEATED_ROWS) : ROBOT;
  return mapRects(map, robotLegend(dir, status), px, ox, oy);
}
export function robotOld(status, px, ox, oy, { seated = false } = {}) {
  const map = seated ? ROBOT_OLD.slice(0, 32) : ROBOT_OLD;
  return mapRects(map, oldLegend(status), px, ox, oy);
}

// ---- colour utils -----------------------------------------------------------

export function hex2rgb(h) {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export function rgb2hex([r, g, b]) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
export function lift(h, k) {
  return rgb2hex(hex2rgb(h).map((c) => 255 - (255 - c) / k));
}
export function desat(h, k) {
  const [r, g, b] = hex2rgb(h);
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return rgb2hex([r + (y - r) * k, g + (y - g) * k, b + (y - b) * k]);
}
/** A theme floor tone, adjusted for the direction. */
export function floorTone(h, d) {
  let c = h;
  if (d.desat) c = desat(c, d.desat);
  return lift(c, d.floorLift);
}
