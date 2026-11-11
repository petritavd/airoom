import type { DecorItem } from '../roomConfig';
import type { Cell, Theme } from './draw';
import { interiorOf } from './draw';
import { ambiance, hexLerp } from './ambiance';

/**
 * The decoration catalog: procedural pixel-art items users place in rooms.
 * Every item draws relative to its ANCHOR = bottom-center of its footprint,
 * so painter's-order sorting by fy just works.
 *
 * House style, same as the agents and the furniture: a #141925 keyline around
 * every object, one sun up-and-left (lit top, body, shaded right), and a warm
 * contact shadow underneath. An item that skips any of the three looks pasted
 * on next to ones that don't.
 */

/**
 * Live room context handed to functional decor items — they don't just sit
 * there, they SHOW things: the git branch, agent statuses, your notes.
 * Undefined when rendering palette thumbnails (items show sample content).
 */
export interface RoomLive {
  branch?: string; // git branch of the room's most recently active session
  notes: string[]; // whiteboard sticky notes (from room settings)
  working: number; // robots currently working
  attention: number; // robots waiting on the human (input/approval/error)
  errors: number; // the subset of `attention` that is actually broken
  done: number; // robots that finished their turn (green)
}

export interface DecorDef {
  key: string;
  label: string;
  emoji: string; // palette icon
  w: number; // footprint at scale 1
  h: number;
  glow?: boolean; // emits a warm local light pool (lamps)
  light?: 'sky'; // casts sky-coloured daylight/moonlight onto the floor (windows)
  draw: (ctx: CanvasRenderingContext2D, time: number, th: Theme, live?: RoomLive) => void; // origin = anchor
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(w), Math.ceil(h));
}

function shadow(ctx: CanvasRenderingContext2D, w: number) {
  // Warm and soft: hard black under everything read as soot once the floors
  // were lit, and it made every object look pasted on.
  ctx.fillStyle = 'rgba(52,36,18,0.22)';
  ctx.beginPath();
  ctx.ellipse(0, 0, w / 2, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** The keyline every item is drawn inside. */
const K = '#141925';

/**
 * Shared tones. Each material is a lit top, a body, and a shadowed side, so a
 * sofa and an armchair across the room are lit by the same sun — and they are
 * the SAME rows the desks and the building use, which is what makes a placed
 * item read as furniture from the workshop rather than a sticker.
 */
const WOOD = { hi: '#e0b177', mid: '#c08d51', lo: '#8a6238', dk: '#5e4022' };
const METAL = { hi: '#dbe2ee', mid: '#98a1af', lo: '#5c6470' };
const RUST = { hi: '#c98466', mid: '#ac6349', lo: '#874c37' };
const NAVY = { hi: '#6d8bb5', mid: '#516e99', lo: '#3c5376' };
const OLIVE = { hi: '#9aad78', mid: '#7d9160', lo: '#606f47' };
/** Terracotta and the soil in it. */
const POT = { hi: '#d08a5e', mid: '#b5643f', lo: '#8e4a2c', soil: '#4b3524' };
/** Foliage, lit crown to shadowed underside. */
const LEAF = { hi: '#6cbf6e', mid: '#4f9d52', lo: '#3d8046', dk: '#2f6238' };
/** Anything with a lit panel: monitors, cabinets, arcade cabs, aquariums. */
const CASE = { hi: '#5d6a80', mid: '#414d61', lo: '#2c3545', glass: '#1d2634' };
/** Painted steel — lockers, machines. */
const ENAMEL = { hi: '#8fa2b5', mid: '#6d7f93', lo: '#4e5d6e' };
/** Paper and card. */
const PAPER = { hi: '#ffffff', mid: '#eae4d6', lo: '#c9c1b0' };
const STATUS = { working: '#4ade80', wants: '#fbbf24' };

/** A keylined block, lit from the top-left. */
function blk(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  c: { hi: string; mid: string; lo: string },
) {
  px(ctx, x - 1, y - 1, w + 2, h + 2, K);
  px(ctx, x, y, w, h, c.mid);
  px(ctx, x, y, w, 2, c.hi);
  px(ctx, x + w - 2, y + 2, 2, h - 2, c.lo);
}

/** A keylined ellipse. */
function kell(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, fill: string) {
  ctx.fillStyle = K;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx + 1, ry + 1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

function fell(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, fill: string, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = ctx.globalAlpha * alpha;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Foliage: a keyline ring, a shadowed underside, a body, a lit crown. */
function bush(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number) {
  fell(ctx, cx, cy, w / 2 + 1, h / 2 + 1, K);
  fell(ctx, cx, cy, w / 2, h / 2, LEAF.lo);
  fell(ctx, cx - w * 0.14, cy - h * 0.12, w * 0.38, h * 0.38, LEAF.mid);
  fell(ctx, cx + w * 0.2, cy + h * 0.1, w * 0.26, h * 0.26, LEAF.dk);
  fell(ctx, cx - w * 0.2, cy - h * 0.24, w * 0.18, h * 0.16, LEAF.hi);
}

/** A tapered terracotta pot with soil showing. */
function pot(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const hw = w / 2;
  px(ctx, -hw - 1, -h - 1, w + 2, h + 2, K);
  px(ctx, -hw, -h, w, h, POT.mid);
  px(ctx, -hw, -h, w, 2, POT.hi); // rim catching the light
  px(ctx, hw - 2, -h + 2, 2, h - 2, POT.lo); // shaded side
  px(ctx, -hw + 1, -h + 1, w - 2, 2, POT.soil);
}

/** Feet peeking out under a piece of furniture. */
function legs(ctx: CanvasRenderingContext2D, hw: number, col = WOOD.dk) {
  px(ctx, -hw, -4, 3, 4, col);
  px(ctx, hw - 3, -4, 3, 4, col);
}

function rand(n: number): number {
  return (((Math.sin(n * 12.9898 + 4.1) * 43758.5) % 1) + 1) % 1;
}

export const DECOR: DecorDef[] = [
  // ---- live: these show something real --------------------------------------
  {
    key: 'board',
    label: 'Whiteboard',
    emoji: '📋',
    w: 42,
    h: 34,
    draw(ctx, _time, _th, live) {
      // The only note surface in the catalog — it absorbed the pinboard,
      // which showed the same RoomConfig.notes on a smaller cork.
      shadow(ctx, 38);
      px(ctx, -16, -6, 3, 6, METAL.lo);
      px(ctx, 13, -6, 3, 6, METAL.lo);
      blk(ctx, -21, -32, 42, 27, PAPER);
      const notes = live ? live.notes : ['ship', 'fix bug', 'demo'];
      if (notes.length) {
        const cols = ['#fbbf24', '#4ade80', '#f87171', '#5b9dff', '#a78bfa', '#fb923c'];
        notes.slice(0, 6).forEach((note, i) => {
          const nx = -18 + (i % 3) * 13;
          const ny = -29 + Math.floor(i / 3) * 12;
          px(ctx, nx, ny, 11, 9, cols[i % 6]);
          px(ctx, nx, ny, 11, 1, 'rgba(255,255,255,0.45)');
          px(ctx, nx + 2, ny + 3, Math.min(8, Math.max(4, note.length)), 1, 'rgba(0,0,0,0.3)');
          if (note.length > 6) px(ctx, nx + 2, ny + 5, Math.min(7, note.length - 6), 1, 'rgba(0,0,0,0.3)');
        });
      } else {
        // no notes yet — marker scribbles
        px(ctx, -17, -29, 22, 2, '#5b8fd4');
        px(ctx, -17, -24, 28, 2, '#5b8fd4');
        px(ctx, -17, -19, 16, 2, '#d46a5b');
        px(ctx, -17, -14, 24, 2, '#8494ad');
      }
    },
  },
  {
    key: 'flag',
    label: 'Branch flag',
    emoji: '🚩',
    w: 30,
    h: 42,
    draw(ctx, _time, th, live) {
      // Flies the room's git branch.
      shadow(ctx, 14);
      px(ctx, -6, -4, 12, 4, K);
      px(ctx, -5, -3, 10, 3, METAL.lo);
      px(ctx, -2, -41, 4, 38, K); // pole
      px(ctx, -1, -40, 2, 37, METAL.mid);
      px(ctx, -3, -42, 6, 3, K); // finial
      px(ctx, -2, -41, 4, 2, '#d8c48a');
      px(ctx, 0, -39, 22, 15, K); // the flag, in the room's accent
      px(ctx, 1, -38, 20, 13, th.accent);
      px(ctx, 1, -38, 20, 2, 'rgba(255,255,255,0.27)');
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 5.5px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText((live?.branch ?? 'main').slice(0, 10), 3, -31, 17);
    },
  },
  {
    key: 'beacon',
    label: 'Status beacon',
    emoji: '🚨',
    w: 16,
    h: 28,
    glow: true,
    draw(ctx, time, _th, live) {
      // Amber when something wants you, green while agents work, dark when
      // the room is quiet.
      const wants = (live?.attention ?? 0) > 0;
      const busy = (live?.working ?? 0) > 0;
      const on = live ? wants || busy : true;
      const core = wants || !live ? STATUS.wants : STATUS.working;
      shadow(ctx, 16);
      blk(ctx, -7, -7, 14, 6, METAL);
      px(ctx, -6, -11, 12, 4, K); // collar
      px(ctx, -5, -10, 10, 3, METAL.hi);
      px(ctx, -6, -25, 12, 15, K); // the lamp
      px(ctx, -5, -24, 10, 13, '#2a3346');
      if (on) {
        ctx.save();
        ctx.globalAlpha = ctx.globalAlpha * (0.55 + 0.45 * Math.abs(Math.sin(time / (wants ? 320 : 900))));
        px(ctx, -5, -24, 10, 13, core);
        ctx.restore();
      }
      px(ctx, -5, -24, 10, 3, 'rgba(255,255,255,0.40)'); // glass
      px(ctx, -3, -21, 3, 7, 'rgba(255,255,255,0.33)');
      px(ctx, -7, -28, 14, 3, K); // cap
      px(ctx, -6, -27, 12, 2, METAL.mid);
    },
  },

  // ---- light -----------------------------------------------------------------
  {
    key: 'lamp',
    label: 'Floor lamp',
    emoji: '💡',
    w: 18,
    h: 38,
    glow: true,
    draw(ctx, time) {
      shadow(ctx, 18);
      px(ctx, -6, -3, 12, 3, K);
      px(ctx, -5, -2, 10, 2, METAL.lo);
      px(ctx, -2, -26, 4, 24, K); // stem
      px(ctx, -1, -25, 2, 23, METAL.mid);
      px(ctx, -9, -37, 18, 12, K); // shade
      px(ctx, -8, -36, 16, 10, '#e8c987');
      px(ctx, -8, -36, 16, 3, '#f7e0ab');
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * (0.9 + 0.1 * Math.sin(time / 520));
      px(ctx, -8, -27, 16, 2, '#ffd68c'); // light under the shade
      ctx.restore();
    },
  },
  {
    key: 'desk_lamp',
    label: 'Desk lamp',
    emoji: '🔦',
    w: 16,
    h: 24,
    glow: true,
    draw(ctx, time) {
      shadow(ctx, 14);
      px(ctx, -6, -3, 12, 3, K);
      px(ctx, -5, -2, 10, 2, METAL.lo);
      px(ctx, -1, -16, 3, 14, K); // upright
      px(ctx, 0, -15, 2, 13, METAL.mid);
      px(ctx, -8, -23, 12, 8, K); // shade
      px(ctx, -7, -22, 10, 6, '#e8c987');
      px(ctx, -7, -22, 10, 2, '#f7e0ab');
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * (0.8 + 0.2 * Math.sin(time / 600));
      px(ctx, -6, -16, 8, 2, '#ffd68c');
      ctx.restore();
    },
  },
  {
    key: 'window',
    label: 'Window',
    emoji: '🪟',
    w: 36,
    h: 34,
    light: 'sky',
    draw(ctx, time) {
      const amb = ambiance();
      // save/restore + relative alpha so the room editor's ghost preview
      // (0.65 valid / 0.3 blocked) survives this item's own alpha changes
      const base = ctx.globalAlpha;
      ctx.save();
      px(ctx, -19, -34, 38, 26, K); // frame
      // banded sky — flat pixel-art bands, never a smooth gradient
      const BANDS = 4;
      for (let i = 0; i < BANDS; i++) {
        ctx.fillStyle = hexLerp(amb.skyTop, amb.skyBot, i / (BANDS - 1));
        ctx.fillRect(-17, -32 + (22 / BANDS) * i, 34, 22 / BANDS + 0.5);
      }
      // stars fade in with darkness
      if (amb.stars > 0.05) {
        for (let i = 0; i < 7; i++) {
          const sx = -14 + rand(i * 3 + 1) * 28;
          const sy = -31 + rand(i * 7 + 2) * 13;
          const tw = 0.4 + 0.6 * Math.abs(Math.sin(time / 700 + i * 1.7));
          ctx.globalAlpha = base * amb.stars * tw;
          px(ctx, sx, sy, 1.4, 1.4, '#e8f0ff');
        }
        // crescent moon
        ctx.globalAlpha = base * amb.stars;
        ctx.fillStyle = '#e8ecf2';
        ctx.beginPath();
        ctx.arc(7, -25, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = amb.skyTop;
        ctx.beginPath();
        ctx.arc(9, -26.5, 3.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = base;
      }
      if (amb.darkness < 0.75) {
        // sun — sinks toward the sill as darkness grows
        ctx.globalAlpha = base * (1 - amb.darkness);
        ctx.fillStyle = amb.phase === 'day' ? '#ffe9a8' : '#ffb36b';
        ctx.beginPath();
        ctx.arc(-7, -26 + amb.darkness * 12, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = base * Math.max(0, 0.9 - amb.darkness);
        // drifting cloud
        const cx = -15 + ((time / 900) % 36);
        px(ctx, cx, -21, 8, 2.5, 'rgba(255,255,255,0.75)');
        px(ctx, cx + 2, -23, 5, 2, 'rgba(255,255,255,0.6)');
      }
      ctx.restore();
      ctx.globalAlpha = base;
      // mullions + sill
      px(ctx, -1, -32, 2, 22, WOOD.lo);
      px(ctx, -17, -22, 34, 2, WOOD.lo);
      px(ctx, -17, -32, 3, 9, 'rgba(255,255,255,0.10)'); // glass sheen
      px(ctx, -19, -10, 38, 4, K);
      px(ctx, -18, -9, 36, 3, WOOD.hi);
    },
  },

  // ---- plants ----------------------------------------------------------------
  {
    key: 'plant_s',
    label: 'Small plant',
    emoji: '🌱',
    w: 14,
    h: 20,
    draw(ctx, time) {
      shadow(ctx, 14);
      pot(ctx, 10, 7);
      ctx.save();
      ctx.translate(Math.sin(time / 1400) * 0.4, 0); // the barest breath of air
      bush(ctx, 0, -13, 14, 13);
      ctx.restore();
    },
  },
  {
    key: 'plant_l',
    label: 'Big plant',
    emoji: '🪴',
    w: 22,
    h: 34,
    draw(ctx, time) {
      shadow(ctx, 20);
      pot(ctx, 16, 11);
      ctx.save();
      ctx.translate(Math.sin(time / 1600) * 0.5, 0);
      bush(ctx, 0, -23, 22, 22);
      bush(ctx, -6, -16, 10, 9);
      ctx.restore();
    },
  },
  {
    key: 'cactus',
    label: 'Cactus',
    emoji: '🌵',
    w: 16,
    h: 26,
    draw(ctx) {
      shadow(ctx, 14);
      pot(ctx, 12, 8);
      px(ctx, -4, -24, 8, 17, K); // trunk
      px(ctx, -3, -23, 6, 16, LEAF.mid);
      px(ctx, -3, -23, 2, 16, LEAF.hi);
      px(ctx, 1, -20, 2, 13, LEAF.dk);
      px(ctx, -8, -20, 5, 9, K); // arms
      px(ctx, -7, -19, 3, 8, LEAF.mid);
      px(ctx, 4, -17, 5, 7, K);
      px(ctx, 5, -16, 3, 6, LEAF.mid);
      px(ctx, -1, -26, 3, 3, '#f2a0c0'); // flower
    },
  },

  // ---- seating & tables ------------------------------------------------------
  {
    key: 'sofa',
    label: 'Sofa',
    emoji: '🛋️',
    w: 68,
    h: 30,
    draw(ctx) {
      shadow(ctx, 66);
      blk(ctx, -34, -26, 68, 12, RUST); // back rest
      px(ctx, -34, -16, 8, 16, K); // arms, the darkest planes
      px(ctx, -33, -15, 6, 15, RUST.lo);
      px(ctx, 26, -16, 8, 16, K);
      px(ctx, 27, -15, 6, 15, RUST.lo);
      px(ctx, -27, -15, 27, 13, K); // seat cushions catch the light
      px(ctx, -26, -14, 25, 11, RUST.hi);
      px(ctx, 0, -15, 27, 13, K);
      px(ctx, 1, -14, 25, 11, RUST.hi);
    },
  },
  {
    key: 'chair',
    label: 'Armchair',
    emoji: '🪑',
    w: 26,
    h: 26,
    draw(ctx) {
      shadow(ctx, 24);
      blk(ctx, -13, -24, 26, 10, NAVY); // back
      px(ctx, -13, -15, 6, 14, K); // arms
      px(ctx, -12, -14, 4, 13, NAVY.lo);
      px(ctx, 7, -15, 6, 14, K);
      px(ctx, 8, -14, 4, 13, NAVY.lo);
      px(ctx, -8, -15, 16, 13, K); // seat cushion
      px(ctx, -7, -14, 14, 11, NAVY.hi);
    },
  },
  {
    key: 'stool',
    label: 'Stool',
    emoji: '🔵',
    w: 18,
    h: 20,
    draw(ctx) {
      shadow(ctx, 16);
      px(ctx, -7, -6, 3, 6, METAL.lo);
      px(ctx, 4, -6, 3, 6, METAL.lo);
      kell(ctx, 0, -13, 9, 6, OLIVE.mid);
      fell(ctx, 0, -15, 7, 4, OLIVE.hi);
    },
  },
  {
    key: 'beanbag',
    label: 'Bean bag',
    emoji: '🟠',
    w: 32,
    h: 22,
    draw(ctx) {
      shadow(ctx, 30);
      kell(ctx, 0, -9, 16, 9, OLIVE.mid);
      fell(ctx, -3, -13, 11, 6, OLIVE.hi); // lit slump
      fell(ctx, 7, -6, 7, 4, OLIVE.lo); // the dip you sit in
    },
  },
  {
    // Not in the reference catalog, but nothing else gives a small seating
    // group a surface to gather around — kept, redrawn in the house style.
    key: 'table',
    label: 'Coffee table',
    emoji: '🪑',
    w: 36,
    h: 22,
    draw(ctx) {
      shadow(ctx, 34);
      legs(ctx, 15, WOOD.dk);
      blk(ctx, -17, -20, 34, 10, WOOD);
      px(ctx, 4, -18, 9, 6, PAPER.mid); // a book left open on it
      px(ctx, 4, -18, 9, 1, PAPER.hi);
      px(ctx, 8, -18, 1, 6, PAPER.lo);
      px(ctx, -11, -18, 5, 5, '#c4564a'); // and a mug
      px(ctx, -11, -18, 5, 1, '#e07a6c');
    },
  },
  {
    key: 'table_big',
    label: 'Meeting table',
    emoji: '🪟',
    w: 66,
    h: 30,
    draw(ctx) {
      shadow(ctx, 62);
      px(ctx, -14, -8, 4, 8, WOOD.dk);
      px(ctx, 10, -8, 4, 8, WOOD.dk);
      kell(ctx, 0, -14, 32, 12, WOOD.mid);
      fell(ctx, 0, -17, 26, 7, WOOD.hi, 0.6);
      px(ctx, -8, -17, 11, 7, METAL.hi); // a laptop left on the table
      px(ctx, -8, -17, 11, 1, '#ffffff');
      px(ctx, 8, -15, 4, 4, '#c4564a'); // and a mug
    },
  },

  // ---- floor -----------------------------------------------------------------
  {
    key: 'rug_round',
    label: 'Round rug',
    emoji: '⭕',
    w: 64,
    h: 40,
    draw(ctx) {
      // Cloth gets no keyline — it has no hard edge — and no alpha either:
      // painted translucent it read as a stain on the boards.
      fell(ctx, 0, -12, 32, 19, NAVY.mid);
      ctx.strokeStyle = NAVY.hi;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(0, -12, 32, 19, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * 0.6;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, -12, 23, 13, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    },
  },
  {
    key: 'rug_rect',
    label: 'Area rug',
    emoji: '🟫',
    w: 74,
    h: 46,
    draw(ctx) {
      px(ctx, -37, -44, 74, 44, RUST.mid);
      px(ctx, -37, -44, 74, 3, RUST.hi);
      px(ctx, -37, -3, 74, 3, RUST.lo);
      ctx.save();
      ctx.strokeStyle = RUST.hi;
      ctx.lineWidth = 2;
      ctx.globalAlpha = ctx.globalAlpha * 0.7;
      ctx.strokeRect(-33, -40, 66, 36);
      ctx.strokeStyle = RUST.lo;
      ctx.globalAlpha = ctx.globalAlpha * 0.85;
      ctx.strokeRect(-27, -34, 54, 24);
      ctx.restore();
    },
  },
  {
    key: 'runner',
    label: 'Runner rug',
    emoji: '🧶',
    w: 58,
    h: 20,
    draw(ctx) {
      px(ctx, -29, -18, 58, 18, OLIVE.mid);
      px(ctx, -29, -18, 58, 2, OLIVE.hi);
      px(ctx, -29, -2, 58, 2, OLIVE.lo);
      px(ctx, -26, -15, 52, 1, OLIVE.hi);
      px(ctx, -26, -5, 52, 1, OLIVE.hi);
      for (let i = 0; i < 11; i++) px(ctx, -25 + i * 5, -13, 1, 7, OLIVE.lo); // woven bars
    },
  },

  // ---- storage & work --------------------------------------------------------
  {
    key: 'shelf',
    label: 'Bookshelf',
    emoji: '📚',
    w: 26,
    h: 30,
    draw(ctx) {
      shadow(ctx, 26);
      blk(ctx, -13, -30, 26, 30, { hi: WOOD.hi, mid: WOOD.lo, lo: WOOD.dk });
      const spines = ['#c4564a', '#d9a441', '#4e8a52', '#5b8fc9', '#a06ab5', '#d97a4a', '#6cbf6e'];
      for (let r = 0; r < 2; r++) {
        px(ctx, -12, -20 + r * 10, 24, 1, WOOD.dk); // shelf board
        for (let i = 0; i < 7; i++) {
          const bh = 6 + (i % 3);
          px(ctx, -11 + i * 3, -28 + r * 10 + (3 - (i % 3)), 2, bh, spines[i]);
        }
      }
    },
  },
  {
    key: 'cabinet',
    label: 'Filing cabinet',
    emoji: '🗄️',
    w: 18,
    h: 28,
    draw(ctx) {
      shadow(ctx, 18);
      blk(ctx, -9, -28, 18, 28, ENAMEL);
      for (let i = 0; i < 3; i++) {
        px(ctx, -8, -26 + i * 9, 16, 8, ENAMEL.lo); // drawer face
        px(ctx, -8, -26 + i * 9, 16, 1, ENAMEL.hi);
        px(ctx, -3, -23 + i * 9, 6, 2, METAL.hi); // pull
      }
    },
  },
  {
    key: 'rack',
    label: 'Server rack',
    emoji: '🖥️',
    w: 18,
    h: 38,
    draw(ctx, time) {
      shadow(ctx, 18);
      blk(ctx, -9, -38, 18, 38, CASE);
      for (let i = 0; i < 6; i++) {
        px(ctx, -7, -36 + i * 6, 14, 5, CASE.glass); // a rack unit
        const blink = rand(i * 3 + Math.floor(time / 340)) > 0.4;
        px(ctx, -6, -35 + i * 6, 2, 2, i % 2 ? (blink ? STATUS.working : '#2f5a44') : '#4a5568');
        px(ctx, -3, -35 + i * 6, 2, 2, i % 3 ? '#4a5568' : STATUS.wants);
        px(ctx, 2, -35 + i * 6, 4, 1, '#33415a'); // vents
      }
    },
  },

  // ---- refreshment -----------------------------------------------------------
  {
    key: 'coffee',
    label: 'Coffee machine',
    emoji: '☕',
    w: 14,
    h: 19,
    draw(ctx, time) {
      shadow(ctx, 14);
      blk(ctx, -7, -19, 14, 19, METAL);
      px(ctx, -5, -15, 10, 6, '#2b2119'); // the alcove
      px(ctx, -4, -14, 3, 4, '#5a4632'); // jug of coffee
      px(ctx, -3, -7, 6, 2, '#c4564a'); // button
      px(ctx, -2, -5, 4, 3, PAPER.mid); // cup waiting
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * (0.25 + 0.2 * (Math.sin(time / 220) + 1));
      px(ctx, -1, -22 - ((time / 70) % 5), 2, 3, '#cfd8e6'); // steam
      ctx.restore();
    },
  },
  {
    key: 'cooler',
    label: 'Water cooler',
    emoji: '💧',
    w: 12,
    h: 25,
    draw(ctx, time) {
      shadow(ctx, 12);
      blk(ctx, -6, -14, 12, 14, ENAMEL);
      px(ctx, -2, -8, 4, 2, NAVY.hi); // tap
      px(ctx, -5, -25, 10, 12, K); // the bottle
      px(ctx, -4, -24, 8, 11, '#7fc4e0');
      px(ctx, -4, -24, 8, 3, '#a9dcf0');
      px(ctx, 1, -22, 2, 8, '#5aa6c4');
      const bt = (time / 600) % 1;
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * (1 - bt);
      px(ctx, -1, -16 - bt * 5, 2, 2, '#bfe0ff'); // a bubble rising
      ctx.restore();
    },
  },
  {
    key: 'vending',
    label: 'Vending machine',
    emoji: '🥤',
    w: 24,
    h: 38,
    draw(ctx) {
      shadow(ctx, 24);
      blk(ctx, -12, -38, 24, 38, ENAMEL);
      px(ctx, -10, -35, 15, 26, K); // the lit window
      px(ctx, -9, -34, 13, 24, CASE.glass);
      const cans = ['#c4564a', '#d9a441', '#4e8a52', '#5b8fc9'];
      for (let i = 0; i < 8; i++)
        px(ctx, -8 + (i % 3) * 4, -33 + Math.floor(i / 3) * 6, 3, 5, cans[i % 4]);
      px(ctx, 6, -33, 5, 8, ENAMEL.lo); // button panel
      px(ctx, 7, -31, 3, 1, METAL.hi);
      px(ctx, 7, -28, 3, 1, METAL.hi);
      px(ctx, -9, -7, 13, 4, CASE.lo); // the flap
    },
  },

  // ---- play & personality ----------------------------------------------------
  {
    key: 'arcade',
    label: 'Arcade cabinet',
    emoji: '🕹️',
    w: 26,
    h: 40,
    draw(ctx, time) {
      shadow(ctx, 26);
      blk(ctx, -13, -40, 26, 40, CASE);
      px(ctx, -10, -37, 20, 3, '#f2a0c0'); // marquee
      px(ctx, -10, -32, 20, 14, K); // screen
      px(ctx, -9, -31, 18, 12, '#101a2e');
      const f = Math.floor(time / 320) % 3;
      px(ctx, -7 + f, -29, 5, 3, STATUS.working); // whatever game this is,
      px(ctx, 0, -26 + f, 7, 3, '#5b9dff'); // somebody left it running
      px(ctx, -5, -23, 9, 3, '#f2a0c0');
      px(ctx, -10, -16, 20, 7, CASE.lo); // control deck
      px(ctx, -6, -14, 3, 3, '#c4564a');
      px(ctx, 1, -14, 3, 3, STATUS.wants);
    },
  },
  {
    key: 'dart',
    label: 'Dartboard',
    emoji: '🎯',
    w: 20,
    h: 34,
    draw(ctx) {
      kell(ctx, 0, -22, 10, 10, '#2f3a2c');
      ctx.fillStyle = '#c9c1b0';
      ctx.beginPath();
      ctx.arc(0, -22, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#a8452f';
      ctx.beginPath();
      ctx.arc(0, -22, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2f6238';
      ctx.beginPath();
      ctx.arc(0, -22, 2, 0, Math.PI * 2);
      ctx.fill();
      px(ctx, 2, -25, 6, 1, METAL.hi); // a dart in the board
      px(ctx, 6, -26, 3, 3, '#d9a441');
    },
  },
  {
    key: 'guitar',
    label: 'Guitar',
    emoji: '🎸',
    w: 16,
    h: 36,
    draw(ctx) {
      shadow(ctx, 12);
      px(ctx, -2, -34, 5, 22, K); // neck, leaning
      px(ctx, -1, -33, 3, 21, WOOD.lo);
      px(ctx, -2, -36, 5, 3, K); // headstock
      px(ctx, -1, -35, 3, 2, WOOD.dk);
      kell(ctx, 0, -14, 6, 6, WOOD.mid);
      kell(ctx, 0, -7, 8, 7, WOOD.mid);
      fell(ctx, -2, -9, 5, 4, WOOD.hi, 0.45);
      ctx.fillStyle = K; // sound hole
      ctx.beginPath();
      ctx.arc(0, -11, 2, 0, Math.PI * 2);
      ctx.fill();
      px(ctx, -4, -5, 8, 1, WOOD.dk); // bridge
    },
  },
  {
    key: 'fish',
    label: 'Aquarium',
    emoji: '🐠',
    w: 36,
    h: 30,
    draw(ctx, time) {
      shadow(ctx, 36);
      blk(ctx, -18, -8, 36, 8, { hi: WOOD.hi, mid: WOOD.lo, lo: WOOD.dk }); // stand
      px(ctx, -17, -29, 34, 22, K); // tank
      px(ctx, -16, -28, 32, 20, '#2f6f96');
      px(ctx, -16, -28, 32, 4, '#4f97bd'); // lit surface
      px(ctx, -16, -10, 32, 2, '#c9b48a'); // gravel
      px(ctx, -13, -14, 3, 6, LEAF.mid); // weed
      px(ctx, -9, -12, 2, 4, LEAF.lo);
      px(ctx, 10, -13, 3, 5, LEAF.mid);
      const f1 = -13 + ((time / 1100) % 1) * 22;
      px(ctx, f1, -22, 5, 3, '#e8894a');
      px(ctx, f1 - 1, -22, 1, 3, '#f6b47c'); // tail
      const f2 = 9 - ((time / 1500 + 0.4) % 1) * 20;
      px(ctx, f2, -18, 4, 2, '#d9a441');
      const b = (time / 700) % 1;
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * (1 - b);
      px(ctx, 10, -13 - b * 13, 1, 2, '#dff2fa'); // a bubble rising
      ctx.restore();
    },
  },
  {
    key: 'cat',
    label: 'Office cat',
    emoji: '🐈',
    w: 22,
    h: 14,
    draw(ctx, time) {
      // Curled up asleep. Eyes shut, breathing, the tail stirring — the one
      // resident who has no status colour and no opinion about your PR.
      const br = Math.sin(time / 1300) * 0.4;
      const tw = Math.sin(time / 700) > 0.7 ? 1 : 0;
      shadow(ctx, 20);
      px(ctx, -11, -7 + tw, 4, 2, K); // tail, curled round
      px(ctx, -10, -6 + tw, 6, 2, '#7a6450');
      px(ctx, -7, -9, 3, 3, K);
      px(ctx, -6, -8, 3, 2, '#7a6450');
      kell(ctx, -1, -6 + br, 9, 5, '#8a7259'); // body
      fell(ctx, -3, -8 + br, 6, 3, '#a08a6d');
      px(ctx, 5, -14 + br, 3, 4, K); // ears
      px(ctx, 6, -13 + br, 2, 3, '#8a7259');
      px(ctx, 10, -14 + br, 3, 4, K);
      px(ctx, 11, -13 + br, 2, 3, '#8a7259');
      ctx.fillStyle = K; // head
      ctx.beginPath();
      ctx.arc(9, -9 + br, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#a08a6d';
      ctx.beginPath();
      ctx.arc(9, -9 + br, 3.5, 0, Math.PI * 2);
      ctx.fill();
      px(ctx, 7, -10 + br, 2, 1, '#4a3b2c'); // eyes, shut — it is asleep
      px(ctx, 10, -10 + br, 2, 1, '#4a3b2c');
      px(ctx, 9, -8 + br, 1, 1, '#c88a8a'); // nose
    },
  },
  {
    key: 'trophy',
    label: 'Trophy',
    emoji: '🏆',
    w: 14,
    h: 22,
    draw(ctx) {
      shadow(ctx, 12);
      px(ctx, -6, -5, 12, 5, K); // plinth
      px(ctx, -5, -4, 10, 4, WOOD.lo);
      px(ctx, -5, -4, 10, 1, WOOD.mid);
      px(ctx, -2, -11, 4, 6, '#b08a2e'); // stem
      px(ctx, -6, -20, 12, 9, K); // cup
      px(ctx, -5, -19, 10, 8, '#e0b83f');
      px(ctx, -5, -19, 10, 2, '#f4d878');
      px(ctx, -8, -18, 3, 5, '#c9a134'); // handles
      px(ctx, 5, -18, 3, 5, '#c9a134');
    },
  },

  // ---- wall ------------------------------------------------------------------
  {
    key: 'art',
    label: 'Framed picture',
    emoji: '🖼️',
    w: 28,
    h: 24,
    draw(ctx) {
      px(ctx, -14, -24, 28, 20, K); // frame
      px(ctx, -12, -22, 24, 16, WOOD.mid);
      px(ctx, -10, -20, 20, 12, '#7fa8c4'); // sky
      px(ctx, -10, -12, 20, 4, LEAF.lo); // hills
      px(ctx, -6, -16, 5, 5, '#f4d878'); // sun
      px(ctx, 2, -18, 7, 6, '#5a7f9c');
    },
  },
  {
    key: 'tv',
    label: 'Wall screen',
    emoji: '📺',
    w: 36,
    h: 28,
    draw(ctx, time, _th, live) {
      // The room's own dashboard, finally wired: the green bar grows with
      // agents working, amber appears when something wants a human, a green
      // stub marks finished turns — the desks' signals, readable off a wall.
      const working = live ? live.working : 2;
      const attention = live ? live.attention : 1;
      const done = live ? live.done : 0;
      px(ctx, -18, -28, 36, 24, K);
      px(ctx, -16, -26, 32, 20, '#0f1826');
      px(ctx, -13, -23, working > 0 ? Math.min(26, 6 + working * 7) : 10, 2, working > 0 ? STATUS.working : '#3d4d6b');
      px(ctx, -13, -19, 20, 2, '#3d4d6b');
      px(ctx, -13, -15, attention > 0 ? Math.min(26, 5 + attention * 6) : 14, 2, attention > 0 ? STATUS.wants : '#3d4d6b');
      px(ctx, -13, -11, done > 0 ? Math.min(26, 4 + done * 5) : 16, 2, done > 0 ? '#34d399' : '#3d4d6b');
      // heartbeat in the corner while anything runs
      if (working > 0 && Math.sin(time / 500) > 0) px(ctx, 11, -25, 2, 2, STATUS.working);
      px(ctx, -16, -26, 32, 1, 'rgba(255,255,255,0.13)');
      px(ctx, -3, -4, 6, 3, METAL.lo); // stand
    },
  },
];

export const DECOR_BY_KEY = new Map(DECOR.map((d) => [d.key, d]));

export interface PlacedDecor {
  def: DecorDef;
  index: number; // position in the room's decor array
  x: number; // anchor
  y: number;
  w: number; // scaled footprint
  h: number;
}

export function layoutDecor(cell: Cell, items: DecorItem[]): PlacedDecor[] {
  const { iX, iY, iW, iH } = interiorOf(cell);
  const s = cell.scale;
  const placed: PlacedDecor[] = [];
  items.forEach((it, index) => {
    const def = DECOR_BY_KEY.get(it.item);
    if (!def) return; // unknown key (older/newer build) — skip gracefully
    placed.push({
      def,
      index,
      x: iX + it.fx * iW,
      y: iY + it.fy * iH,
      w: def.w * s,
      h: def.h * s,
    });
  });
  return placed.sort((a, b) => a.y - b.y);
}

export function decorAt(placed: PlacedDecor[], x: number, y: number): PlacedDecor | null {
  // topmost (visually front-most) first
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i];
    if (x >= p.x - p.w / 2 && x <= p.x + p.w / 2 && y >= p.y - p.h && y <= p.y) return p;
  }
  return null;
}

/**
 * What a room looks like before anybody decorates it.
 *
 * A room used to ship with two corner props and a great deal of bare floor,
 * and empty floor is exactly what makes a space read as unfinished. This
 * furnishes every room deterministically from its id, so it looks lived in on
 * first launch and no two rooms look alike — and the moment the user places
 * anything of their own, their list replaces this wholesale.
 *
 * Placement dodges the shared bench (a centred row around fy .55, or .32/.78
 * when a team bench shares the zone): furniture hugs the glass at the back
 * and sides, and the sitting area lives on the open floor at the front.
 */
export function autoDecor(roomId: string, deskCount: number): DecorItem[] {
  let h = 2166136261;
  for (let i = 0; i < roomId.length; i++) h = Math.imul(h ^ roomId.charCodeAt(i), 16777619);
  const pick = <T,>(list: T[], salt: number): T => list[Math.abs((h >> salt) | 0) % list.length];

  const items: DecorItem[] = [];
  // The front of the zone, laid out as a small sitting area. Order matters:
  // `layoutDecor` paints by anchor Y, so the rug has to be listed with a
  // SMALLER fy than whatever stands on it or it covers it.
  if (deskCount <= 4) items.push({ item: pick(['rug_rect', 'rug_round'], 2), fx: 0.5, fy: 0.86 });
  if (deskCount <= 3) items.push({ item: pick(['table', 'table_big'], 23), fx: 0.5, fy: 0.9 });
  // On the back glass, above the bench: something flat.
  items.push({ item: pick(['art', 'board', 'window', 'tv'], 26), fx: 0.12, fy: 0.15 });
  // Left edge: something tall and useful.
  items.push({ item: pick(['shelf', 'cabinet', 'cooler', 'coffee', 'rack'], 5), fx: 0.06, fy: 0.52 });
  // Right edge: something with a bit of personality.
  items.push({ item: pick(['plant_l', 'lamp', 'cactus', 'trophy', 'guitar'], 8), fx: 0.94, fy: 0.52 });
  // Front corners: greenery on one side, a character piece on the other.
  items.push({ item: pick(['plant_s', 'plant_l', 'cactus'], 11), fx: 0.07, fy: 0.96 });
  items.push({ item: pick(['shelf', 'arcade', 'vending', 'dart', 'fish'], 14), fx: 0.93, fy: 0.96 });
  // Somewhere to sit that isn't a desk — centred along the front, where the
  // zone opens onto the corridor and nothing competes for the floor.
  if (deskCount <= 3) items.push({ item: pick(['sofa', 'chair', 'stool', 'beanbag'], 20), fx: 0.5, fy: 0.96 });
  else if (deskCount <= 5) items.push({ item: pick(['stool', 'plant_s', 'beanbag'], 20), fx: 0.5, fy: 0.96 });
  return items;
}

/** Room presets: one-click decorated rooms (fractions of the interior). */
export const PRESETS: { key: string; label: string; floor: string; items: DecorItem[] }[] = [
  {
    key: 'loft',
    label: 'Startup loft',
    floor: 'wood',
    items: [
      { item: 'window', fx: 0.3, fy: 0.16 },
      { item: 'rug_rect', fx: 0.5, fy: 0.78 },
      { item: 'sofa', fx: 0.5, fy: 0.94 },
      { item: 'beanbag', fx: 0.22, fy: 0.66 },
      { item: 'plant_l', fx: 0.06, fy: 0.95 },
      { item: 'lamp', fx: 0.94, fy: 0.93 },
      { item: 'shelf', fx: 0.93, fy: 0.42 },
      { item: 'coffee', fx: 0.06, fy: 0.45 },
      { item: 'cat', fx: 0.68, fy: 0.62 },
    ],
  },
  {
    key: 'server',
    label: 'Server room',
    floor: 'tile',
    items: [
      { item: 'rack', fx: 0.06, fy: 0.5 },
      { item: 'rack', fx: 0.16, fy: 0.5 },
      { item: 'rack', fx: 0.26, fy: 0.5 },
      { item: 'cabinet', fx: 0.93, fy: 0.5 },
      { item: 'board', fx: 0.9, fy: 0.95 },
      { item: 'cooler', fx: 0.06, fy: 0.95 },
    ],
  },
  {
    key: 'zen',
    label: 'Zen garden',
    floor: 'grass',
    items: [
      { item: 'window', fx: 0.5, fy: 0.14 },
      { item: 'plant_l', fx: 0.06, fy: 0.5 },
      { item: 'plant_l', fx: 0.94, fy: 0.5 },
      { item: 'cactus', fx: 0.12, fy: 0.93 },
      { item: 'cactus', fx: 0.88, fy: 0.93 },
      { item: 'rug_round', fx: 0.5, fy: 0.78 },
      { item: 'fish', fx: 0.5, fy: 0.96 },
      { item: 'cat', fx: 0.5, fy: 0.6 },
    ],
  },
];
