// The decor catalog, re-arted in the new style.
// Every item: a #141925 keyline, one sun up-and-left (lit top, body, shaded
// right), and a warm contact shadow. Origin is the ANCHOR = bottom-centre of
// the footprint, matching decor.ts, so these drop straight into the existing
// placement system. Footprints (w,h) are unchanged.
import { rect } from './art.mjs';

const R = rect;
export const K = '#141925';
const WOOD = { hi: '#e0b177', mid: '#c08d51', lo: '#8a6238', dk: '#5e4022' };
const METAL = { hi: '#dbe2ee', mid: '#98a1af', lo: '#5c6470' };
const RUST = { hi: '#c98466', mid: '#ac6349', lo: '#874c37' };
const NAVY = { hi: '#6d8bb5', mid: '#516e99', lo: '#3c5376' };
const OLIVE = { hi: '#9aad78', mid: '#7d9160', lo: '#606f47' };
const POT = { hi: '#d08a5e', mid: '#b5643f', lo: '#8e4a2c', soil: '#4b3524' };
const LEAF = { hi: '#6cbf6e', mid: '#4f9d52', lo: '#3d8046', dk: '#2f6238' };
const CASE = { hi: '#5d6a80', mid: '#414d61', lo: '#2c3545', glass: '#1d2634' };
const ENAMEL = { hi: '#8fa2b5', mid: '#6d7f93', lo: '#4e5d6e' };
const PAPER = { hi: '#ffffff', mid: '#eae4d6', lo: '#c9c1b0' };
const STATUS = { working: '#4ade80', wants: '#fbbf24', error: '#f87171' };

/** Contact shadow. Nothing sits on a floor without one. */
const sh = (w, sq = 3.5) => `<ellipse cx="0" cy="0" rx="${w / 2}" ry="${sq}" fill="rgba(52,36,18,0.22)"/>`;
/** A keylined block, lit from the top-left. */
const blk = (x, y, w, h, c) =>
  R(x - 1, y - 1, w + 2, h + 2, K) + R(x, y, w, h, c.mid) +
  R(x, y, w, 2, c.hi) + R(x + w - 2, y + 2, 2, h - 2, c.lo);
/** A keylined ellipse. */
const ell = (cx, cy, rx, ry, fill) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx + 1}" ry="${ry + 1}" fill="${K}"/>` +
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"/>`;
/** Foliage: a shadowed underside, a body, a lit crown. */
function bush(cx, cy, w, h) {
  let o = `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2 + 1}" ry="${h / 2 + 1}" fill="${K}"/>`;
  o += `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="${LEAF.lo}"/>`;
  o += `<ellipse cx="${cx - w * 0.14}" cy="${cy - h * 0.12}" rx="${w * 0.38}" ry="${h * 0.38}" fill="${LEAF.mid}"/>`;
  o += `<ellipse cx="${cx + w * 0.2}" cy="${cy + h * 0.1}" rx="${w * 0.26}" ry="${h * 0.26}" fill="${LEAF.dk}"/>`;
  o += `<ellipse cx="${cx - w * 0.2}" cy="${cy - h * 0.24}" rx="${w * 0.18}" ry="${h * 0.16}" fill="${LEAF.hi}"/>`;
  return o;
}
/** A tapered terracotta pot. */
function pot(w, h) {
  const hw = w / 2;
  return R(-hw - 1, -h - 1, w + 2, h + 2, K) + R(-hw, -h, w, h, POT.mid) +
    R(-hw, -h, w, 2, POT.hi) + R(hw - 2, -h + 2, 2, h - 2, POT.lo) +
    R(-hw + 1, -h + 1, w - 2, 2, POT.soil);
}
const legs = (hw, col = WOOD.dk) => R(-hw, -4, 3, 4, col) + R(hw - 3, -4, 3, 4, col);

export const DECOR = {
  // ---- live: these show something real -------------------------------------
  board: { label: 'Whiteboard', w: 42, h: 34, group: 'live',
    note: 'Now the only note surface — it absorbed the separate Pinboard.',
    draw: () => sh(38) + R(-16, -6, 3, 6, METAL.lo) + R(13, -6, 3, 6, METAL.lo) +
      blk(-21, -32, 42, 27, PAPER) +
      ['#fbbf24', '#4ade80', '#f87171', '#5b9dff', '#a78bfa', '#fb923c']
        .map((c, i) => R(-18 + (i % 3) * 13, -29 + Math.floor(i / 3) * 12, 11, 9, c) +
          R(-18 + (i % 3) * 13, -29 + Math.floor(i / 3) * 12, 11, 1, 'rgba(255,255,255,.45)') +
          R(-16 + (i % 3) * 13, -26 + Math.floor(i / 3) * 12, 7, 1, 'rgba(0,0,0,.3)')).join('') },
  flag: { label: 'Branch flag', w: 30, h: 42, group: 'live',
    note: 'Flies the room’s git branch.',
    draw: (th = '#b0680f') => sh(14) + R(-6, -4, 12, 4, K) + R(-5, -3, 10, 3, METAL.lo) +
      R(-2, -41, 4, 38, K) + R(-1, -40, 2, 37, METAL.mid) + R(-3, -42, 6, 3, K) + R(-2, -41, 4, 2, '#d8c48a') +
      R(0, -39, 22, 15, K) + R(1, -38, 20, 13, th) + R(1, -38, 20, 2, '#ffffff44') +
      R(3, -34, 13, 1, '#00000033') + R(3, -31, 9, 1, '#00000033') },
  beacon: { label: 'Status beacon', w: 16, h: 28, group: 'live',
    note: 'Amber when something wants you, green while agents work, dark when quiet.',
    draw: () => sh(16) + blk(-7, -7, 14, 6, METAL) + R(-6, -11, 12, 4, K) + R(-5, -10, 10, 3, METAL.hi) +
      R(-6, -25, 12, 15, K) + R(-5, -24, 10, 13, STATUS.wants) +
      R(-5, -24, 10, 3, '#ffffff66') + R(-3, -21, 3, 7, '#ffffff55') +
      R(-7, -28, 14, 3, K) + R(-6, -27, 12, 2, METAL.mid) },

  // ---- light ---------------------------------------------------------------
  lamp: { label: 'Floor lamp', w: 18, h: 38, group: 'light', glow: 1,
    draw: () => sh(18) + R(-6, -3, 12, 3, K) + R(-5, -2, 10, 2, METAL.lo) +
      R(-2, -26, 4, 24, K) + R(-1, -25, 2, 23, METAL.mid) +
      R(-9, -37, 18, 12, K) + R(-8, -36, 16, 10, '#e8c987') + R(-8, -36, 16, 3, '#f7e0ab') +
      R(-8, -27, 16, 2, '#ffd68c') },
  desk_lamp: { label: 'Desk lamp', w: 16, h: 24, group: 'light', glow: 1,
    draw: () => sh(14) + R(-6, -3, 12, 3, K) + R(-5, -2, 10, 2, METAL.lo) +
      R(-1, -16, 3, 14, K) + R(0, -15, 2, 13, METAL.mid) +
      R(-8, -23, 12, 8, K) + R(-7, -22, 10, 6, '#e8c987') + R(-7, -22, 10, 2, '#f7e0ab') +
      R(-6, -16, 8, 2, '#ffd68c') },
  window: { label: 'Window', w: 36, h: 34, group: 'light', light: 1,
    draw: () => R(-19, -34, 38, 26, K) + R(-17, -32, 34, 22, '#8fc4e8') +
      R(-17, -32, 34, 9, '#b6dcf4') + R(-1, -32, 2, 22, WOOD.lo) + R(-17, -22, 34, 2, WOOD.lo) +
      R(-19, -10, 38, 4, K) + R(-18, -9, 36, 3, WOOD.hi) },

  // ---- plants --------------------------------------------------------------
  plant_s: { label: 'Small plant', w: 14, h: 20, group: 'plants',
    draw: () => sh(14) + pot(10, 7) + bush(0, -13, 14, 13) },
  plant_l: { label: 'Big plant', w: 22, h: 34, group: 'plants',
    draw: () => sh(20) + pot(16, 11) + bush(0, -23, 22, 22) + bush(-6, -16, 10, 9) },
  cactus: { label: 'Cactus', w: 16, h: 26, group: 'plants',
    draw: () => sh(14) + pot(12, 8) + R(-4, -24, 8, 17, K) + R(-3, -23, 6, 16, LEAF.mid) +
      R(-3, -23, 2, 16, LEAF.hi) + R(1, -20, 2, 13, LEAF.dk) +
      R(-8, -20, 5, 9, K) + R(-7, -19, 3, 8, LEAF.mid) + R(4, -17, 5, 7, K) + R(5, -16, 3, 6, LEAF.mid) +
      R(-1, -26, 3, 3, '#f2a0c0') },

  // ---- seating & tables ----------------------------------------------------
  sofa: { label: 'Sofa', w: 68, h: 30, group: 'seating',
    draw: () => sh(66) + blk(-34, -26, 68, 12, RUST) +
      R(-34, -16, 8, 16, K) + R(-33, -15, 6, 15, RUST.lo) +
      R(26, -16, 8, 16, K) + R(27, -15, 6, 15, RUST.lo) +
      R(-27, -15, 27, 13, K) + R(-26, -14, 25, 11, RUST.hi) +
      R(0, -15, 27, 13, K) + R(1, -14, 25, 11, RUST.hi) },
  chair: { label: 'Armchair', w: 26, h: 26, group: 'seating',
    draw: () => sh(24) + blk(-13, -24, 26, 10, NAVY) +
      R(-13, -15, 6, 14, K) + R(-12, -14, 4, 13, NAVY.lo) +
      R(7, -15, 6, 14, K) + R(8, -14, 4, 13, NAVY.lo) +
      R(-8, -15, 16, 13, K) + R(-7, -14, 14, 11, NAVY.hi) },
  stool: { label: 'Stool', w: 18, h: 20, group: 'seating',
    draw: () => sh(16) + R(-7, -6, 3, 6, METAL.lo) + R(4, -6, 3, 6, METAL.lo) +
      ell(0, -13, 9, 6, OLIVE.mid) + `<ellipse cx="0" cy="-15" rx="7" ry="4" fill="${OLIVE.hi}"/>` },
  beanbag: { label: 'Bean bag', w: 32, h: 22, group: 'seating',
    draw: () => sh(30) + ell(0, -9, 16, 9, OLIVE.mid) +
      `<ellipse cx="-3" cy="-13" rx="11" ry="6" fill="${OLIVE.hi}"/>` +
      `<ellipse cx="7" cy="-6" rx="7" ry="4" fill="${OLIVE.lo}"/>` },
  table_big: { label: 'Meeting table', w: 66, h: 30, group: 'seating',
    draw: () => sh(62) + R(-14, -8, 4, 8, WOOD.dk) + R(10, -8, 4, 8, WOOD.dk) +
      ell(0, -14, 32, 12, WOOD.mid) + `<ellipse cx="0" cy="-17" rx="26" ry="7" fill="${WOOD.hi}" opacity=".6"/>` +
      R(-8, -17, 11, 7, METAL.hi) + R(-8, -17, 11, 1, '#ffffff') + R(8, -15, 4, 4, '#c4564a') },

  // ---- floor ---------------------------------------------------------------
  rug_round: { label: 'Round rug', w: 64, h: 40, group: 'floor',
    draw: () => `<ellipse cx="0" cy="-12" rx="32" ry="19" fill="${NAVY.mid}"/>` +
      `<ellipse cx="0" cy="-12" rx="32" ry="19" fill="none" stroke="${NAVY.hi}" stroke-width="3"/>` +
      `<ellipse cx="0" cy="-12" rx="23" ry="13" fill="none" stroke="${NAVY.hi}" stroke-width="2" opacity=".6"/>` },
  rug_rect: { label: 'Area rug', w: 74, h: 46, group: 'floor',
    draw: () => R(-37, -44, 74, 44, RUST.mid) + R(-37, -44, 74, 3, RUST.hi) +
      R(-37, -3, 74, 3, RUST.lo) +
      `<rect x="-33" y="-40" width="66" height="36" fill="none" stroke="${RUST.hi}" stroke-width="2" opacity=".7"/>` +
      `<rect x="-27" y="-34" width="54" height="24" fill="none" stroke="${RUST.lo}" stroke-width="2" opacity=".6"/>` },
  runner: { label: 'Runner rug', w: 58, h: 20, group: 'floor',
    draw: () => R(-29, -18, 58, 18, OLIVE.mid) + R(-29, -18, 58, 2, OLIVE.hi) +
      R(-29, -2, 58, 2, OLIVE.lo) +
      R(-26, -15, 52, 1, OLIVE.hi) + R(-26, -5, 52, 1, OLIVE.hi) +
      Array.from({ length: 11 }, (_, i) => R(-25 + i * 5, -13, 1, 7, OLIVE.lo)).join('') },

  // ---- storage & work ------------------------------------------------------
  shelf: { label: 'Bookshelf', w: 26, h: 30, group: 'work',
    draw: () => sh(26) + blk(-13, -30, 26, 30, { hi: WOOD.hi, mid: WOOD.lo, lo: WOOD.dk }) +
      [0, 1].map((r) => R(-12, -20 + r * 10, 24, 1, WOOD.dk) +
        Array.from({ length: 7 }, (_, i) => R(-11 + i * 3, -28 + r * 10 + (7 - (4 + (i % 3))), 2, 4 + (i % 3) + 2,
          ['#c4564a', '#d9a441', '#4e8a52', '#5b8fc9', '#a06ab5', '#d97a4a', '#6cbf6e'][i])).join('')).join('') },
  cabinet: { label: 'Filing cabinet', w: 18, h: 28, group: 'work',
    draw: () => sh(18) + blk(-9, -28, 18, 28, ENAMEL) +
      [0, 1, 2].map((i) => R(-8, -26 + i * 9, 16, 8, ENAMEL.lo) + R(-8, -26 + i * 9, 16, 1, ENAMEL.hi) +
        R(-3, -23 + i * 9, 6, 2, METAL.hi)).join('') },
  rack: { label: 'Server rack', w: 18, h: 38, group: 'work',
    draw: () => sh(18) + blk(-9, -38, 18, 38, CASE) +
      Array.from({ length: 6 }, (_, i) => R(-7, -36 + i * 6, 14, 5, CASE.glass) +
        R(-6, -35 + i * 6, 2, 2, i % 2 ? STATUS.working : '#4a5568') +
        R(-3, -35 + i * 6, 2, 2, i % 3 ? '#4a5568' : STATUS.wants) +
        R(2, -35 + i * 6, 4, 1, '#33415a')).join('') },

  // ---- refreshment ---------------------------------------------------------
  coffee: { label: 'Coffee machine', w: 14, h: 19, group: 'food',
    draw: () => sh(14) + blk(-7, -19, 14, 19, METAL) + R(-5, -15, 10, 6, '#2b2119') +
      R(-4, -14, 3, 4, '#5a4632') + R(-3, -7, 6, 2, '#c4564a') + R(-2, -5, 4, 3, PAPER.mid) },
  cooler: { label: 'Water cooler', w: 12, h: 25, group: 'food',
    draw: () => sh(12) + blk(-6, -14, 12, 14, ENAMEL) + R(-2, -8, 4, 2, NAVY.hi) +
      R(-5, -25, 10, 12, K) + R(-4, -24, 8, 11, '#7fc4e0') + R(-4, -24, 8, 3, '#a9dcf0') +
      R(1, -22, 2, 8, '#5aa6c4') },
  vending: { label: 'Vending machine', w: 24, h: 38, group: 'food',
    draw: () => sh(24) + blk(-12, -38, 24, 38, ENAMEL) + R(-10, -35, 15, 26, K) +
      R(-9, -34, 13, 24, CASE.glass) +
      Array.from({ length: 8 }, (_, i) => R(-8 + (i % 3) * 4, -33 + Math.floor(i / 3) * 6, 3, 5,
        ['#c4564a', '#d9a441', '#4e8a52', '#5b8fc9'][i % 4])).join('') +
      R(6, -33, 5, 8, ENAMEL.lo) + R(7, -31, 3, 1, METAL.hi) + R(7, -28, 3, 1, METAL.hi) +
      R(-9, -7, 13, 4, CASE.lo) },

  // ---- play & personality --------------------------------------------------
  arcade: { label: 'Arcade cabinet', w: 26, h: 40, group: 'play',
    draw: () => sh(26) + blk(-13, -40, 26, 40, CASE) +
      R(-10, -37, 20, 3, '#f2a0c0') +
      R(-10, -32, 20, 14, K) + R(-9, -31, 18, 12, '#101a2e') +
      R(-7, -29, 5, 3, STATUS.working) + R(0, -26, 7, 3, '#5b9dff') + R(-5, -23, 9, 3, '#f2a0c0') +
      R(-10, -16, 20, 7, CASE.lo) + R(-6, -14, 3, 3, '#c4564a') + R(1, -14, 3, 3, STATUS.wants) },
  dart: { label: 'Dartboard', w: 20, h: 34, group: 'play',
    draw: () => ell(0, -22, 10, 10, '#2f3a2c') + `<circle cx="0" cy="-22" r="7" fill="#c9c1b0"/>` +
      `<circle cx="0" cy="-22" r="4" fill="#a8452f"/>` + `<circle cx="0" cy="-22" r="2" fill="#2f6238"/>` +
      R(2, -25, 6, 1, METAL.hi) + R(6, -26, 3, 3, '#d9a441') },
  guitar: { label: 'Guitar', w: 16, h: 36, group: 'play',
    draw: () => sh(12) + R(-2, -34, 5, 22, K) + R(-1, -33, 3, 21, WOOD.lo) +
      R(-2, -36, 5, 3, K) + R(-1, -35, 3, 2, WOOD.dk) +
      ell(0, -14, 6, 6, WOOD.mid) + ell(0, -7, 8, 7, WOOD.mid) +
      `<ellipse cx="-2" cy="-9" rx="5" ry="4" fill="${WOOD.hi}" opacity=".45"/>` +
      `<circle cx="0" cy="-11" r="2" fill="${K}"/>` + R(-4, -5, 8, 1, WOOD.dk) },
  fish: { label: 'Aquarium', w: 36, h: 30, group: 'play',
    draw: () => sh(36) + blk(-18, -8, 36, 8, { hi: WOOD.hi, mid: WOOD.lo, lo: WOOD.dk }) +
      R(-17, -29, 34, 22, K) + R(-16, -28, 32, 20, '#2f6f96') + R(-16, -28, 32, 4, '#4f97bd') +
      R(-13, -14, 3, 6, LEAF.mid) + R(-9, -12, 2, 4, LEAF.lo) + R(10, -13, 3, 5, LEAF.mid) +
      R(-4, -22, 5, 3, '#e8894a') + R(1, -21, 2, 1, '#f6b47c') + R(6, -18, 4, 2, '#d9a441') +
      R(-16, -10, 32, 2, '#c9b48a') },
  cat: { label: 'Office cat', w: 22, h: 14, group: 'play',
    draw: () => sh(20) +
      R(-11, -7, 4, 2, K) + R(-10, -6, 6, 2, '#7a6450') +      // tail, curled round
      R(-7, -9, 3, 3, K) + R(-6, -8, 3, 2, '#7a6450') +
      ell(-1, -6, 9, 5, '#8a7259') +
      `<ellipse cx="-3" cy="-8" rx="6" ry="3" fill="#a08a6d"/>` +
      R(5, -14, 3, 4, K) + R(6, -13, 2, 3, '#8a7259') +        // ears
      R(10, -14, 3, 4, K) + R(11, -13, 2, 3, '#8a7259') +
      `<circle cx="9" cy="-9" r="4.5" fill="${K}"/>` + `<circle cx="9" cy="-9" r="3.5" fill="#a08a6d"/>` +
      R(7, -10, 2, 1, '#4a3b2c') + R(10, -10, 2, 1, '#4a3b2c') +   // eyes, shut — it is asleep
      R(9, -8, 1, 1, '#c88a8a') },
  trophy: { label: 'Trophy', w: 14, h: 22, group: 'play',
    draw: () => sh(12) + R(-6, -5, 12, 5, K) + R(-5, -4, 10, 4, WOOD.lo) + R(-5, -4, 10, 1, WOOD.mid) +
      R(-2, -11, 4, 6, '#b08a2e') +
      R(-6, -20, 12, 9, K) + R(-5, -19, 10, 8, '#e0b83f') + R(-5, -19, 10, 2, '#f4d878') +
      R(-8, -18, 3, 5, '#c9a134') + R(5, -18, 3, 5, '#c9a134') },

  // ---- wall ----------------------------------------------------------------
  art: { label: 'Framed picture', w: 28, h: 24, group: 'wall',
    draw: () => R(-14, -24, 28, 20, K) + R(-12, -22, 24, 16, WOOD.mid) +
      R(-10, -20, 20, 12, '#7fa8c4') + R(-10, -12, 20, 4, LEAF.lo) +
      R(-6, -16, 5, 5, '#f4d878') + R(2, -18, 7, 6, '#5a7f9c') },
  tv: { label: 'Wall screen', w: 36, h: 28, group: 'wall',
    note: 'Worth wiring to live data — a dead screen on the wall is a sad prop.',
    draw: () => R(-18, -28, 36, 24, K) + R(-16, -26, 32, 20, '#0f1826') +
      R(-13, -23, 12, 2, STATUS.working) + R(-13, -19, 20, 2, '#3d4d6b') +
      R(-13, -15, 8, 2, STATUS.wants) + R(-13, -11, 16, 2, '#3d4d6b') +
      R(-16, -26, 32, 1, '#ffffff22') + R(-3, -4, 6, 3, METAL.lo) },
};

/** Items cut, and why. */
export const DROPPED = [
  ['pinboard', 'Duplicate note surface — the Whiteboard shows the same RoomConfig.notes.'],
  ['mailbox', 'Third thing signalling "someone needs you", after the beacon and the zone halo.'],
  ['ottoman', 'A smaller, blander bean bag. The bean bag has a silhouette; this was a box.'],
  ['boxes', 'Storage block that the filing cabinet already covers, with less character.'],
  ['printer', 'Office noise. Nothing in this product prints.'],
  ['fridge', 'The kitchen counter has one, and the water cooler covers "cold drink".'],
  ['coatrack', 'The staff are robots. They do not own coats.'],
  ['bin', '14×16 of nothing. It never read as anything at room scale.'],
];
