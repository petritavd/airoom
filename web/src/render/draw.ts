import type { Connector, FleetSnapshot, Robot, Room, RobotStatus, Team, TeamMember, TeamRole } from '@shared/types';
import type { DecorItem, FloorMat } from '../roomConfig';
import { autoDecor, DECOR_BY_KEY, layoutDecor, type PlacedDecor, type RoomLive } from './decor';
import { ambiance } from './ambiance';

// ---- Fixed one-screen layout ----------------------------------------------
// The viewport IS the building. Rooms of the same project family (shared path
// prefix, e.g. stickyboard + stickyboard/frontend) are placed adjacent and
// joined by an archway in the shared wall. Spare cells become the lounge.

export const CANVAS_FONT = '"Chakra Petch", ui-monospace, monospace';

export const STATUS_COLOR: Record<RobotStatus, string> = {
  working: '#4ade80',
  waiting_input: '#fbbf24',
  idle: '#5b6b86',
  error: '#f87171',
  done: '#34d399', // finished — green success glow, distinct from amber "needs you"
};

/**
 * The margins between a cell's edge and its carpet. They were plaster walls
 * once; on the open floor they are strips of the shared board floor — the
 * corridors — with the zone's waist-high glass standing at the carpet line.
 * The names stay, because everything from the sim to hit-testing knows the
 * interior through them, and the interior has not moved.
 */
export const WALL_SIDE = 7;
export const WALL_TOP = 9;
export const WALL_FACE = 13;
export const WALL_BOT = 12;
const DOOR_W = 40;
const ARCH_H = 56;
const TILE = 22;
/**
 * How many robots get a seat before the room shows "+N more". Twelve, not
 * six: a zone seats its crew across several bench ROWS now (each row at most
 * six places), and its cell grows taller to make the space — so the cap is
 * about legibility, not geometry.
 */
const MAX_DESKS = 12;

export interface Theme {
  id: string;
  name: string;
  /** Base floor tone. Materials are LIT — a dark floor turns every object on it
   *  into dark-on-dark, which is what made the old world read as murk. */
  floor: string;
  /** Second tone: alternate plank/tile, carpet fleck. Kept close to `floor` —
   *  the material should read as one surface, not as stripes. */
  floorAlt: string;
  /** Seam line: plank edge, grout, board end. */
  seam: string;
  accent: string;
  /**
   * What this floor is MADE of, when the room hasn't chosen.
   *
   * Chroma stays low on purpose. Fully saturated floors turned the world into
   * colour-blocked poster art; real carpet, tile and board are muted, and it is
   * the furniture that gets to be colourful.
   */
  mat: FloorMat;
}
// Tones carry the bold direction's floorLift (×1.10) already baked in: the
// same rows as before, pushed toward the light, so furniture with a #141925
// keyline sits ON the floor instead of dissolving into it.
export const THEMES: Theme[] = [
  { id: 'oak', name: 'Oak', floor: '#bc956d', floorAlt: '#b38c64', seam: '#9e7852', accent: '#b0680f', mat: 'wood' },
  { id: 'forest', name: 'Forest', floor: '#96ae85', floorAlt: '#8ea77e', seam: '#7c956e', accent: '#2f7d4a', mat: 'carpet' },
  { id: 'ocean', name: 'Ocean', floor: '#8c99b0', floorAlt: '#8492a8', seam: '#748297', accent: '#2f6cad', mat: 'carpet' },
  { id: 'plum', name: 'Plum', floor: '#a395a8', floorAlt: '#9b8ca0', seam: '#887a8d', accent: '#7247ab', mat: 'carpet' },
  { id: 'rose', name: 'Rose', floor: '#c5a08f', floorAlt: '#bc9786', seam: '#a58271', accent: '#b04a3e', mat: 'tile' },
  { id: 'slate', name: 'Slate', floor: '#b1b5ba', floorAlt: '#a9adb3', seam: '#959aa0', accent: '#2f7099', mat: 'tile' },
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
export function themeFor(room: Room | null, overrides: Record<string, string>): Theme {
  if (!room) return THEMES[0];
  return THEMES.find((t) => t.id === overrides[room.id]) ?? THEMES[hash(room.id) % THEMES.length];
}

// ---- layout types ----------------------------------------------------------

export interface P {
  x: number;
  y: number;
}
export interface Cell {
  idx: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'room' | 'lounge';
  room?: Room;
  family?: string;
  archRight: boolean; // opening to the cell on the right (same family)
  archLeft: boolean;
  familyDoorDown: boolean; // accented wide door to the cell below (same family)
  /** Draw this cell's RIGHT wall? False when the neighbour's left wall already
   *  stands there — two rooms sharing a boundary share one wall, not two. */
  wallRight: boolean;
  scale: number; // LOD scale for furniture/robots
}
export interface Desk {
  robot: Robot;
  cellIdx: number;
  seat: P; // robot head-top anchor when seated
  deskTop: number;
  x: number; // hit box
  y: number;
  w: number;
  h: number;
}
/**
 * A zone's shared bench: every agent in the room at one long desk, which is
 * how an open floor seats a project — and what TeamPod already did for teams.
 * Replaced the SLOTS scatter of one desk per robot: six desks strewn across a
 * carpet read as six strangers, a bench reads as a crew.
 *
 * Layout only — each occupant keeps its own Desk (hit box + seat anchor), so
 * hit-testing and the sim never knew anything changed.
 */
export interface BenchRow {
  cellIdx: number;
  deskTop: number;
  x0: number; // left edge of the bench top
  w: number;
  seats: { x: number; robot: Robot }[]; // left → right
}
/**
 * A team's shared bench: one long desk with the three of them side by side.
 *
 * The first version drew a rug under three ordinary desks. It read as a
 * translucent rectangle floating on the floor rather than as furniture — the
 * office is built out of solid objects, and a border is not one. A bench is a
 * thing you can point at, and it says "these three work together" without
 * needing a legend.
 *
 * Clickable as a whole (opens the team panel); the robots sitting at it keep
 * their own hit boxes.
 */
export interface TeamPod {
  teamId: string;
  roomId: string;
  cellIdx: number;
  state: Team['state'];
  /** seat anchors, left to right, in roster order */
  seats: { p: P; role: TeamRole; kind: TeamMember['kind']; robot: Robot | null }[];
  deskTop: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * The team's own button: a small plaque above the bench reading TEAM,
   * hit-tested BEFORE anyone sitting at the bench. Without it the only way to
   * open a team was to click the empty floor above the robots' heads — 29% of
   * the bench, with nothing drawn there to suggest it. It reads TEAM, or the
   * team's name once it has one — never the job's name, which the room's sign
   * already says, and which as a second copy on the bench was clutter that ran
   * into the first.
   */
  plate: { x: number; y: number; w: number; h: number; label: string };
}

export interface SpawnSpot {
  roomId: string;
  cellIdx: number;
  cx: number;
  cy: number; // same anchor semantics as a desk seat
  deskTop: number;
  x: number; // hit box
  y: number;
  w: number;
  h: number;
}
/** The ⚙ button in a room's nameplate — opens that room's settings. */
export interface GearSpot {
  roomId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
/**
 * Device pixels per art pixel.
 *
 * The world is drawn into a buffer at 1 art pixel per unit and then blown up by
 * this factor with smoothing off. Before, everything went straight onto a
 * dpr-scaled surface, so any fractional coordinate — and there are many, since
 * furniture is drawn through `ctx.scale(cell.scale, …)` — landed on a half
 * device pixel and came out soft. Snapping the whole world to one grid is what
 * separates deliberate pixel art from something that merely looks low-res.
 */
export const ART_PIXEL = 2;

export interface Layout {
  cells: Cell[];
  rows: number;
  desks: Desk[];
  benches: BenchRow[]; // one shared bench per staffed zone
  teamPods: TeamPod[];
  spawnSpots: SpawnSpot[]; // one ghost desk per non-full room — "+ new"
  /** The "+N" badge on a crowded room — clicking it lists every session,
   *  including the ones with no desk to sit at. */
  rosterSpots: GearSpot[];
  loungeSpot: { cellIdx: number; p: P } | null; // where a visiting robot stands
  /** The building footprint: rooms inside, ground and outer wall around it. */
  shell: { x: number; y: number; w: number; h: number };
  viewW: number;
  viewH: number;
  /**
   * Total height the rooms actually need.
   *
   * Rooms used to be squeezed into the viewport no matter how many there were,
   * so every new project made all of them smaller — past a point the furniture
   * overlaps and the labels are a letter wide. Below a floor the world grows
   * taller than the window instead, and the view scrolls.
   */
  worldH: number;
}

/** The cell below `cell` whose span contains this cell's bottom door. */
export function cellBelow(layout: Layout, cell: Cell): Cell | null {
  const doorX = bottomDoorX(cell);
  for (const c of layout.cells)
    if (c.row === cell.row + 1 && doorX >= c.x && doorX < c.x + c.w) return c;
  return null;
}
/** Cells in the row above whose bottom door opens into `cell`. */
export function cellsAbove(layout: Layout, cell: Cell): Cell[] {
  return layout.cells.filter(
    (c) => c.row === cell.row - 1 && bottomDoorX(c) >= cell.x && bottomDoorX(c) < cell.x + cell.w,
  );
}

/** Seat pitch along a zone's shared bench, at scale 1; bench width for n
 *  places is n * SEAT_PITCH + 10. The design reference used 58, which put
 *  shoulders nearly touching once screens were big enough to see it — the
 *  row breathes at 70 and still squeezes down to 44 when a zone is narrow. */
const SEAT_PITCH = 70;

/** Family key: the shortest room path that is a prefix of this room's path. */
function familyKeys(rooms: Room[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rooms) {
    let best = r.path;
    for (const other of rooms) {
      if (other.path.length < best.length && (r.path === other.path || r.path.startsWith(other.path + '/')))
        best = other.path;
    }
    map.set(r.id, best);
  }
  return map;
}

/** Is this room docked to another one (a team's lane), rather than a project? */
function isAnnex(room: Room, annexesBy: Map<string, Room[]>): boolean {
  return !!room.lane && [...annexesBy.values()].some((list) => list.includes(room));
}

export function interiorOf(cell: Cell) {
  return {
    iX: cell.x + WALL_SIDE,
    iY: cell.y + WALL_TOP + WALL_FACE,
    // Never inverted. A cell narrower than its own two walls used to hand the
    // canvas a negative width, which throws on the first rounded rectangle and
    // takes the whole office black — one cramped room should cost one cramped
    // room, not the drawing.
    iW: Math.max(2, cell.w - WALL_SIDE * 2),
    iH: Math.max(2, cell.h - (WALL_TOP + WALL_FACE) - WALL_BOT),
  };
}

export function bottomDoorX(cell: Cell): number {
  return cell.x + cell.w / 2;
}

/** Extra width a project needs because lanes are docked to it. Set once per
 *  layout, read by `roomWeight` — a project with three lanes beside it has to
 *  be given the floor for all four rooms, or every one of them comes out a
 *  sliver. */
let annexWeight = new Map<string, number>();

function baseWeight(room: Room): number {
  // Width share grows with staffing but saturates: past eight the extra
  // people are seated by ADDING BENCH ROWS (height), not by starving every
  // other room of width.
  return 1 + 0.28 * Math.min(room.robotCount, 8);
}

function roomWeight(room: Room): number {
  return baseWeight(room) + (annexWeight.get(room.id) ?? 0);
}

/**
 * How big furniture and agents are drawn, for the WHOLE floor.
 *
 * Set once per layout from the viewport, never from a cell: it answers "how
 * much room does this screen have", which is the question the old per-cell
 * formula was really trying to answer. The reference is a three-across,
 * three-down floor of the old 320x215 room, so a laptop window lands near 1
 * and a 27" display still grows the furniture rather than leaving acres of
 * carpet with tiny people on it.
 */
let worldScale = 1;
const SCALE_REF_W = 960;
const SCALE_REF_H = 645;

function mkCell(row: number, x: number, y: number, w: number, h: number, kind: 'room' | 'lounge', room?: Room, family?: string): Cell {
  return {
    idx: 0, // re-indexed after all cells are built
    row,
    x,
    y,
    w,
    h,
    kind,
    room,
    family,
    archRight: false,
    archLeft: false,
    familyDoorDown: false,
    wallRight: true,
    // ONE scale for the whole floor — see worldScale below. This used to be
    // clamp(min(w / 320, h / 215), …) off the cell's own box, which was fine
    // when rooms were uniform boxes but is wrong on an open floor: chunkNeed()
    // sizes a band by how many bench rows it needs, so cell height tracks
    // HEADCOUNT, and deriving furniture size from it made a one-agent room's
    // robot visibly smaller than a busy room's. It is one office; a robot is
    // a robot.
    scale: worldScale,
  };
}

/** Balanced chunk `i` of `parts` from a list, preserving order. */
function chunkOf<T>(list: T[], parts: number, i: number): T[] {
  const base = Math.floor(list.length / parts);
  const extra = list.length % parts;
  const start = i * base + Math.min(i, extra);
  return list.slice(start, start + base + (i < extra ? 1 : 0));
}

/** A room needs about this much height to stay legible: nameplate, a desk with
 *  a robot at it, and floor enough to read the room for what it is. */
const MIN_ROW_H = 168;

/**
 * How much room the building's outer wall and the ground outside it take.
 *
 * The office used to run edge to edge, which is why it read as a map of cells
 * rather than a place: nothing told you where the building stopped. The rooms
 * are laid out inside this margin and the shell is drawn in it.
 */
export const SHELL = 26;

export function computeLayout(snapshot: FleetSnapshot, outerW: number, outerH: number): Layout {
  // Everything below lays out in the INTERIOR; the whole grid is translated
  // into the shell once the cells exist.
  const viewW = Math.max(160, outerW - SHELL * 2);
  const viewH = Math.max(160, outerH - SHELL * 2);
  // must be set before the first mkCell() below — every cell reads it
  worldScale = clamp(Math.min(viewW / SCALE_REF_W, viewH / SCALE_REF_H), 0.62, 1.7);
  /**
   * Lanes are not projects.
   *
   * A team's lane is a git worktree with sessions in it, so the fleet scan
   * finds it and reports it like any other folder. Left alone it would land in
   * the floor plan as a mysterious project named after a task. Instead each
   * lane is pulled out here and docked to the room it branched from, sharing
   * that room's floor and opening onto it — which is what it actually is.
   */
  const annexesBy = new Map<string, Room[]>();
  for (const r of snapshot.rooms) {
    if (!r.lane) continue;
    // A lane whose project is not on screen has nowhere to dock; it falls back
    // to being an ordinary room rather than disappearing.
    if (!snapshot.rooms.some((x) => x.id === r.lane!.homeRoomId)) continue;
    const list = annexesBy.get(r.lane.homeRoomId) ?? [];
    list.push(r);
    annexesBy.set(r.lane.homeRoomId, list);
  }
  for (const list of annexesBy.values()) list.sort((a, b) => (a.lane?.lane ?? 0) - (b.lane?.lane ?? 0));
  annexWeight = new Map(
    [...annexesBy].map(([id, list]) => [id, list.reduce((sum, r) => sum + baseWeight(r), 0)]),
  );
  const topRooms = snapshot.rooms.filter((r) => !isAnnex(r, annexesBy));

  // Order rooms so families sit together.
  const fams = familyKeys(snapshot.rooms);
  const rooms = [...topRooms].sort((a, b) => {
    const fa = fams.get(a.id)!;
    const fb = fams.get(b.id)!;
    return fa === fb ? a.path.localeCompare(b.path) : fa.localeCompare(fb);
  });

  const cells: Cell[] = [];
  let rows: number;
  let worldH = viewH;

  // Lay one full-width row of rooms, widths ∝ staffing.
  const pushRow = (rowRooms: Room[], row: number, y: number, h: number) => {
    if (!rowRooms.length) return;
    const totalW = rowRooms.reduce((s, r) => s + roomWeight(r), 0);
    let xc = 0;
    rowRooms.forEach((room, i) => {
      const frac = roomWeight(room) / totalW;
      const x = Math.round(xc);
      const wPx = i === rowRooms.length - 1 ? viewW - x : Math.round(frac * viewW);
      xc += frac * viewW;
      cells.push(mkCell(row, x, y, wPx, h, 'room', room, fams.get(room.id)));
    });
  };

  if (rooms.length < 4) {
    // Small fleet: single row of rooms with the lounge beside them.
    const Lw = Math.round(clamp(viewW * 0.24, 220, 420));
    rows = 1;
    if (!rooms.length) {
      cells.push(mkCell(0, 0, 0, viewW, viewH, 'lounge'));
    } else {
      // rooms split around a centered lounge
      const left = rooms.slice(0, Math.ceil(rooms.length / 2));
      const right = rooms.slice(Math.ceil(rooms.length / 2));
      // By weight, not by count: a project with lanes docked to it has to be
      // given the floor for all of them, or the split below leaves slivers.
      const totalW = rooms.reduce((sum, r) => sum + roomWeight(r), 0) || 1;
      const share = (room: Room) => ((viewW - Lw) * roomWeight(room)) / totalW;
      let xc = 0;
      for (const room of left) {
        cells.push(mkCell(0, Math.round(xc), 0, Math.round(share(room)), viewH, 'room', room, fams.get(room.id)));
        xc += share(room);
      }
      cells.push(mkCell(0, Math.round(xc), 0, Lw, viewH, 'lounge'));
      xc += Lw;
      right.forEach((room, i) => {
        const x = Math.round(xc);
        const wPx = i === right.length - 1 ? viewW - x : Math.round(share(room));
        cells.push(mkCell(0, x, 0, wPx, viewH, 'room', room, fams.get(room.id)));
        xc += share(room);
      });
    }
  } else {
    // Ring layout: the lounge is the heart of the building — dead center —
    // with rooms arranged around it (families kept together in the bands,
    // singleton projects flanking the sides).
    const famSize = new Map<string, number>();
    for (const r of rooms) {
      const f = fams.get(r.id)!;
      famSize.set(f, (famSize.get(f) ?? 0) + 1);
    }
    // Quietest singles flank the lounge — the middle row's height follows the
    // lounge, so the crowded rooms belong in the bands, which grow to fit.
    const singles = rooms
      .filter((r) => famSize.get(fams.get(r.id)!) === 1)
      .sort((a, b) => a.robotCount - b.robotCount);
    let west: Room;
    let east: Room;
    if (singles.length >= 2) {
      west = singles[0];
      east = singles[1];
    } else {
      west = rooms[rooms.length - 2];
      east = rooms[rooms.length - 1];
    }
    const rest = rooms.filter((r) => r !== west && r !== east);
    const north = rest.slice(0, Math.ceil(rest.length / 2));
    const south = rest.slice(Math.ceil(rest.length / 2));
    const maxPerRow = Math.max(2, Math.round(viewW / 430));
    const rowsN = Math.max(1, Math.ceil(north.length / maxPerRow));
    const rowsS = Math.max(1, Math.ceil(south.length / maxPerRow));

    const Lw = Math.round(clamp(viewW * 0.24, 260, 470));
    const Lx = Math.round((viewW - Lw) / 2);
    // How many bench rows a room will need, from its projected width — a
    // crowded room's band is given the height its rows take, so hiring the
    // seventh agent grows the ROOM rather than hitting a wall.
    // The estimate must speak the PLACEMENT's units: seats are SEAT_PITCH
    // wide at worldScale, not a hardcoded 58px. The old mismatch meant a
    // crowded room was budgeted two rows of height and then laid out three —
    // the third bench went through the south wall.
    const rowPitchPx = Math.round(84 * worldScale) + 6;
    const benchRowsFor = (room: Room, estW: number): number => {
      const per = Math.max(2, Math.min(6, Math.floor((estW * 0.85 - 20 * worldScale) / (SEAT_PITCH * worldScale))));
      return Math.max(1, Math.ceil((Math.min(room.robotCount, MAX_DESKS) + 1) / per));
    };
    // The flanks sit beside the lounge at ITS height — if one is still
    // crowded despite the sort above, the whole middle row grows with it.
    const flankRows = Math.max(benchRowsFor(west, Lx), benchRowsFor(east, viewW - (Lx + Lw)));
    const Lh = Math.max(
      Math.round(clamp(viewH * 0.34, 200, 400)),
      MIN_ROW_H + (flankRows - 1) * rowPitchPx + 30,
    );
    const chunkNeed = (rowRooms: Room[]): number => {
      if (!rowRooms.length) return MIN_ROW_H;
      const totalW = rowRooms.reduce((sum, r) => sum + roomWeight(r), 0);
      let extra = 0;
      for (const r of rowRooms)
        extra = Math.max(extra, benchRowsFor(r, (roomWeight(r) / totalW) * viewW) - 1);
      return MIN_ROW_H + extra * rowPitchPx;
    };
    const needsN = Array.from({ length: rowsN }, (_, r) => chunkNeed(chunkOf(north, rowsN, r)));
    const needsS = Array.from({ length: rowsS }, (_, r) => chunkNeed(chunkOf(south, rowsS, r)));
    const sumN = needsN.reduce((a, b) => a + b, 0) || 1;
    const sumS = needsS.reduce((a, b) => a + b, 0) || 1;
    // If the bands cannot give every row the height it needs, the WORLD gets
    // taller — the rooms keep their size and the view scrolls instead.
    worldH = Math.max(viewH, sumN + sumS + Lh);
    // split the space above/below the lounge by what each band actually needs
    const bandN = Math.round(((worldH - Lh) * sumN) / (sumN + sumS));
    const Ly = bandN;

    let yAcc = 0;
    for (let r = 0; r < rowsN; r++) {
      const h = r === rowsN - 1 ? bandN - yAcc : Math.round((bandN * needsN[r]) / sumN);
      pushRow(chunkOf(north, rowsN, r), r, yAcc, h);
      yAcc += h;
    }
    cells.push(mkCell(rowsN, 0, Ly, Lx, Lh, 'room', west, fams.get(west.id)));
    cells.push(mkCell(rowsN, Lx, Ly, Lw, Lh, 'lounge'));
    cells.push(mkCell(rowsN, Lx + Lw, Ly, viewW - (Lx + Lw), Lh, 'room', east, fams.get(east.id)));
    const yS = Ly + Lh;
    const bandS = worldH - yS;
    let ySAcc = 0;
    for (let r = 0; r < rowsS; r++) {
      const h = r === rowsS - 1 ? bandS - ySAcc : Math.round((bandS * needsS[r]) / sumS);
      pushRow(chunkOf(south, rowsS, r), rowsN + 1 + r, yS + ySAcc, h);
      ySAcc += h;
    }
    rows = rowsN + 1 + rowsS;
  }

  // Carve the lanes out of their project's floor. Side by side rather than
  // stacked, so every one of them shares the project's full height — which is
  // what makes the archways line up and read as one continuous suite.
  if (annexesBy.size) {
    const withLanes: Cell[] = [];
    for (const c of cells) {
      const list = c.room ? annexesBy.get(c.room.id) : undefined;
      if (!c.room || !list?.length) {
        withLanes.push(c);
        continue;
      }
      const parts: Room[] = [c.room, ...list];
      // The project's own cell is REUSED as the first part, so its width is
      // about to change. Everything below measures against the originals.
      const cw = c.w;
      const cRight = c.x + c.w;
      const total = parts.reduce((sum, r) => sum + baseWeight(r), 0);
      // Proportional, with a floor — but the floor is dropped entirely rather
      // than allowed to overflow the parent, which is how a narrow window used
      // to produce a cell of negative width and a canvas that threw.
      // Proportional, but no part may end up narrower than its own two walls
      // plus a scrap of floor. When even that will not fit, everyone shares
      // equally: cramped is a fair outcome, inverted is a broken one.
      const minW = WALL_SIDE * 2 + 24;
      const raw = parts.map((r) => (cw * baseWeight(r)) / total);
      let widths = raw.map((w) => Math.max(minW, Math.round(w)));
      if (widths.reduce((a, b) => a + b, 0) > cw) {
        // Take the excess off the widest parts first — the project is the one
        // with room to spare, and a lane squeezed to nothing helps nobody.
        const spare = raw.map((w, i) => Math.max(0, widths[i] - minW));
        const spareTotal = spare.reduce((a, b) => a + b, 0);
        const over = widths.reduce((a, b) => a + b, 0) - cw;
        widths =
          spareTotal >= over
            ? widths.map((w, i) => w - Math.round((over * spare[i]) / spareTotal))
            : parts.map(() => Math.floor(cw / parts.length));
      }
      let xc = c.x;
      parts.forEach((room, i) => {
        const last = i === parts.length - 1;
        const w = last ? Math.max(1, cRight - xc) : widths[i];
        if (i === 0) {
          c.w = w;
          withLanes.push(c);
        } else {
          const cell = mkCell(c.row, xc, c.y, w, c.h, 'room', room, c.family);
          // The lane's far wall is the project's old one; everything between
          // them is opened by the sibling pass below.
          cell.archRight = last ? c.archRight : false;
          withLanes.push(cell);
        }
        xc += w;
      });
      c.archRight = false; // reassigned by the sibling pass
    }
    cells.length = 0;
    cells.push(...withLanes);
  }

  cells.forEach((c, i) => (c.idx = i));
  // One wall per boundary. Every cell used to paint walls on both sides, so a
  // shared edge came out as two walls back to back — complete with two lit tops
  // and two shadow lips, which is exactly what made rooms read as separate
  // cards pushed together rather than as rooms in one building.
  for (const c of cells) {
    c.wallRight = !cells.some((o) => o !== c && o.row === c.row && Math.abs(o.x - (c.x + c.w)) <= 1);
  }
  // Slide the whole floor plan inside the building. Everything derived from
  // cells below (desks, ghost desks, roster badges) is computed after this, so
  // it lands in the right place; adjacency tests above are relative and don't
  // care where the grid sits.
  for (const c of cells) {
    c.x += SHELL;
    c.y += SHELL;
  }
  const shell = { x: SHELL, y: SHELL, w: viewW, h: worldH };

  // Sibling connections (geometric adjacency, since widths vary).
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.kind !== 'room') continue;
    const right = cells[i + 1];
    if (right && right.row === cell.row && right.kind === 'room' && right.family === cell.family) {
      cell.archRight = true;
      right.archLeft = true;
    }
  }
  // The lounge is an open atrium: archways to whatever sits beside it.
  for (const cell of cells) {
    if (cell.kind !== 'lounge') continue;
    const left = cells.find((c) => c.row === cell.row && Math.abs(c.x + c.w - cell.x) <= 1);
    const right = cells.find((c) => c.row === cell.row && Math.abs(cell.x + cell.w - c.x) <= 1);
    if (left) {
      cell.archLeft = true;
      left.archRight = true;
    }
    if (right) {
      cell.archRight = true;
      right.archLeft = true;
    }
  }

  const layoutStub: Layout = {
    cells,
    rows,
    desks: [],
    benches: [],
    teamPods: [],
    spawnSpots: [],
    rosterSpots: [],
    loungeSpot: null,
    shell: { x: 0, y: 0, w: 0, h: 0 },
    viewW,
    viewH,
    worldH,
  };
  for (const cell of cells) {
    if (cell.kind !== 'room') continue;
    const down = cellBelow(layoutStub, cell);
    if (down?.kind === 'room' && down.family === cell.family) cell.familyDoorDown = true;
  }

  // One shared bench per zone, plus a ghost place ("hire an agent") when the
  // room isn't full. The row is laid out as if the ghost were the next hire,
  // so nothing shifts when it's filled. Team members sit at their own team
  // bench (below) and are kept off the zone bench entirely.
  const podded = new Set<string>();
  for (const r of snapshot.robots) if (r.team) podded.add(r.sessionId);
  const desks: Desk[] = [];
  const spawnSpots: SpawnSpot[] = [];
  const benches: BenchRow[] = [];
  for (const cell of cells) {
    if (!cell.room) continue;
    const { iX, iY, iW, iH } = interiorOf(cell);
    // Only MAX_DESKS robots get a place, and a robot without one cannot be
    // clicked — so the choice of WHICH ones is a correctness question, not a
    // cosmetic one. Anything waiting on the user comes first (never strand a
    // blocked agent behind a "+N" label), then the busy, then the most recent.
    const rank = (r: Robot) =>
      r.needsApproval || r.status === 'waiting_input' || r.status === 'error' ? 0 : r.status === 'working' ? 1 : 2;
    const members = snapshot.robots
      .filter((r) => r.roomId === cell.room!.id && !podded.has(r.sessionId))
      .sort((a, b) => rank(a) - rank(b) || (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
    const shown = Math.min(members.length, MAX_DESKS);
    const withGhost = Math.min(shown + 1, MAX_DESKS);
    const s = cell.scale;
    // The crew sits across as many bench ROWS as it takes: at most six
    // places to a bench (past that a row reads as a wall), balanced so seven
    // people are 4+3 rather than 6+1.
    const perRow = Math.max(2, Math.min(6, Math.floor((iW - 20 * s) / (SEAT_PITCH * s))));
    const benchRows = Math.max(1, Math.ceil(withGhost / perRow));
    const rowLen = (r: number) => Math.floor(withGhost / benchRows) + (r < withGhost % benchRows ? 1 : 0);
    // A room that also hosts a team keeps the team bench on the upper row;
    // the zone block sits lower so the two never collide.
    const hasPod = (snapshot.teams ?? []).some((t) => t.roomId === cell.room!.id);
    // The rows must fit between the head clearance and the floor NO MATTER
    // WHAT the band-height estimate said: pitch compresses before anything
    // is allowed to leave the room. (It used to be the other way round — the
    // head clamp ran last and pushed the block through the south wall.)
    const headY = iY + (hasPod ? 0.32 * iH + 62 * s : 34 * s);
    const floorRoom = iY + iH - 46 * s - headY;
    const rowPitchY = benchRows > 1 ? Math.max(34 * s, Math.min(84 * s, floorRoom / (benchRows - 1))) : 0;
    let firstDeskTop = iY + (hasPod ? 0.64 : 0.54) * iH - ((benchRows - 1) / 2) * rowPitchY;
    firstDeskTop = Math.max(firstDeskTop, headY);
    // floor clamp LAST: the front row must never cross the south wall
    firstDeskTop = Math.min(firstDeskTop, iY + iH - 46 * s - (benchRows - 1) * rowPitchY);
    // seat index → its row/column, row lengths balanced
    const seatPos = (i: number) => {
      let r = 0;
      let acc = 0;
      while (r < benchRows - 1 && i >= acc + rowLen(r)) {
        acc += rowLen(r);
        r++;
      }
      const len = rowLen(r);
      const pitch = Math.max(44 * s, Math.min(SEAT_PITCH * s, (iW - 16 * s) / len));
      const rowW = len * pitch + 10 * s;
      const x0 = iX + iW / 2 - rowW / 2;
      const deskTop = Math.round(firstDeskTop + r * rowPitchY);
      return {
        row: r,
        cx: Math.round(x0 + 5 * s + pitch * (i - acc) + pitch / 2),
        seatY: deskTop - 24 * s,
        deskTop,
        pitch,
        x0,
        rowW,
        len,
      };
    };
    // 24: the seated sprite runs 22 rows below its head-top anchor, so the
    // desk edge lands 2px under the torso — close enough to be worked at,
    // with the chair's backrest (top edge -22) tucked behind the head (-24).
    const place = (i: number) => {
      const p = seatPos(i);
      const hw = Math.min(100 * s, p.pitch);
      const hh = benchRows > 1 ? Math.min(80 * s, rowPitchY - 2) : Math.min(96 * s, iH * 0.5);
      return { ...p, x: p.cx - hw / 2, y: p.seatY - 12 * s, w: hw, h: hh };
    };
    members.slice(0, shown).forEach((robot, i) => {
      const p = place(i);
      desks.push({
        robot,
        cellIdx: cell.idx,
        seat: { x: p.cx, y: p.seatY },
        deskTop: p.deskTop,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
      });
    });
    // one BenchRow per occupied row (the ghost sits beside a bench, not on it)
    for (let r = 0, start = 0; r < benchRows; start += rowLen(r), r++) {
      const occupied = Math.min(Math.max(shown - start, 0), rowLen(r));
      if (!occupied) continue;
      const first = seatPos(start);
      benches.push({
        cellIdx: cell.idx,
        deskTop: first.deskTop,
        x0: first.x0,
        w: occupied * first.pitch + 10 * s,
        seats: members.slice(start, start + occupied).map((robot, k) => ({ x: seatPos(start + k).cx, robot })),
      });
    }
    // No ghost desk in a lane: a lane is a team's worktree, and an agent hired
    // into one would be working on a branch nobody told it about.
    if (shown < MAX_DESKS && !cell.room.lane) {
      const p = place(shown);
      spawnSpots.push({
        roomId: cell.room.id,
        cellIdx: cell.idx,
        cx: p.cx,
        cy: p.seatY,
        deskTop: p.deskTop,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
      });
    }
  }

  // Lounge spot (first lounge cell): stand by the coffee table.
  let loungeSpot: Layout['loungeSpot'] = null;
  const lounge = cells.find((c) => c.kind === 'lounge');
  if (lounge) {
    const { iY, iH } = interiorOf(lounge);
    loungeSpot = { cellIdx: lounge.idx, p: { x: lounge.x + lounge.w / 2 + 34, y: iY + iH * 0.52 - 10 } };
  }

  const rosterSpots: GearSpot[] = [];

  // Geometry can collapse: enough rooms in a short window and a cell's
  // interior goes to nothing, leaving hit boxes with zero or NEGATIVE size —
  // which no click can ever satisfy, so the room becomes dead to the pointer.
  // The drawing may look cramped; the targets must still be hittable.
  const MIN_HIT = 14;
  const usable = <T extends { x: number; y: number; w: number; h: number }>(b: T): T => {
    if (b.w >= MIN_HIT && b.h >= MIN_HIT) return b;
    const w = Math.max(b.w, MIN_HIT);
    const h = Math.max(b.h, MIN_HIT);
    // Centre the widened box on where it was meant to be, but never let it
    // slide off the stage: a box at x:-4 is half unreachable, which defeats
    // the point of widening it in the first place.
    const x = Math.min(Math.max(0, b.x + (b.w - w) / 2), Math.max(0, outerW - w));
    const y = Math.max(0, b.y + (b.h - h) / 2);
    return { ...b, x, y, w, h };
  };
  for (let i = 0; i < desks.length; i++) desks[i] = usable(desks[i]);
  for (let i = 0; i < spawnSpots.length; i++) spawnSpots[i] = usable(spawnSpots[i]);

  // A crowded room hides its overflow behind "+N". Give that badge a real hit
  // box: without one those sessions cannot be reached at all.
  for (const cell of cells) {
    if (!cell.room || cell.room.robotCount <= MAX_DESKS) continue;
    const baseY = cell.y + cell.h - WALL_BOT - 2;
    rosterSpots.push({
      roomId: cell.room.id,
      x: cell.x + cell.w - WALL_SIDE - 74,
      y: baseY - 16,
      w: 48,
      h: 18,
    });
  }
  // Team benches. The three members are pulled OUT of the ordinary desk slots
  // and given a row of their own, because the generic slot grid puts the third
  // desk on a second row (SLOTS[3]) — a team split across two rows is exactly
  // the thing a shared bench is meant to stop looking like.
  const teamPods: TeamPod[] = [];
  for (const team of snapshot.teams ?? []) {
    // A finished team still sits at its bench. Skipping the bench here (while
    // the desk loop above skipped their individual desks) left the robots
    // floating in an empty room the moment they delivered — the furniture
    // vanished out from under them. A team keeps its desk until dismissed.
    const home = cells.find((c) => c.room?.id === team.roomId);
    if (!home) continue;
    // One bench per CREW, in the room that crew actually works in: the lead in
    // the project, each lane's crew in its own lane. A single-lane team has
    // exactly one bench, in the project, which is how it has always looked.
    const byCell = new Map<number, TeamMember[]>();
    for (const m of team.members) {
      const lane = (m.lane ?? 0) > 0 ? cells.find((c) => c.room?.lane?.teamId === team.id && c.room.lane.lane === m.lane) : undefined;
      const cell = lane ?? home;
      byCell.set(cell.idx, [...(byCell.get(cell.idx) ?? []), m]);
    }
    for (const [cellIdx, members] of byCell) {
      const cell = cells[cellIdx];
      const s = cell.scale;
      const { iX, iY, iW, iH } = interiorOf(cell);
      // The same centred bench row a zone uses, one place per member — a
      // team's bench is the zone bench with a role strip, not a second kind of
      // desk.
      const n = members.length;
      // The bench has to FIT: a lane is a narrow room, and a pitch with a floor
      // under it put the end seats through the wall and made two crews read as
      // one long bench spanning three rooms.
      const pitch = Math.min(SEAT_PITCH * s, Math.max(8, (iW - 26 * s) / Math.max(n, 1)));
      const seatY = iY + 0.32 * iH - 26 * s;
      const deskTop = seatY + 24 * s;
      // Centred, then pushed back inside if the room is too narrow to hold the
      // whole row — two crews in two narrow lanes used to overlap across the
      // wall between them and read as one very long bench.
      const span = (n - 1) * pitch;
      const half = span / 2 + 12 * s;
      const cx = clamp(iX + iW / 2, iX + Math.min(half, iW / 2), iX + iW - Math.min(half, iW / 2));
      const seats = members.map((m, i) => ({
        p: { x: Math.round(cx + (i - (n - 1) / 2) * pitch), y: seatY },
        role: m.role,
        kind: m.kind,
        robot: snapshot.robots.find((r) => r.team?.id === team.id && r.team.role === m.role) ?? null,
      }));

      // Members never joined the zone bench (the podded set above) — they only
      // need their clickable desks here. A member's box is its robot and its
      // own screen: the bench top, the role strip and the lip in front belong
      // to the TEAM. The old box ran 30px past the front of the bench and was
      // wider than the seat pitch, so the whole piece of furniture opened
      // whoever happened to sit nearest.
      for (const seat of seats) {
        if (!seat.robot) continue;
        const hw = Math.min(pitch - 4 * s, 54 * s);
        desks.push({
          robot: seat.robot,
          cellIdx: cell.idx,
          seat: seat.p,
          deskTop,
          x: seat.p.x - hw / 2,
          y: seat.p.y - 12 * s,
          w: hw,
          h: deskTop + 24 * s - (seat.p.y - 12 * s),
        });
      }

      const x0 = Math.max(iX + 3, seats[0].p.x - 34 * s);
      const x1 = Math.min(iX + iW - 3, seats[n - 1].p.x + 34 * s);
      const podY = seatY - 40 * s;
      // The plaque: the team's name if it has one, TEAM if not. Sized to its
      // text (it may overhang a one-seat bench, never the room), centred on the
      // bench, and never under the room's sign — a bench that sits high in a
      // short room used to push it straight into the nameplate above.
      const name = team.name?.replace(/\s+/g, ' ').trim() ?? '';
      const label = name ? (name.length > 24 ? `${name.slice(0, 23).trimEnd()}…` : name) : 'TEAM';
      const pw = Math.round(Math.min(iW - 12 * s, Math.max(58 * s, (label.length * 6.4 + 30) * s)));
      const ph = Math.round(16 * s);
      const pxLeft = clamp((x0 + x1) / 2 - pw / 2, iX + 6 * s, iX + iW - 6 * s - pw);
      const pyTop = Math.max(podY + 2 * s, iY + 14 * s);
      teamPods.push({
        teamId: team.id,
        roomId: cell.room?.id ?? team.roomId,
        cellIdx: cell.idx,
        state: team.state,
        seats,
        deskTop,
        x: x0,
        y: podY,
        w: x1 - x0,
        h: deskTop + 34 * s - podY,
        plate: { x: Math.round(pxLeft), y: Math.round(pyTop), w: pw, h: ph, label },
      });
    }
  }

  return {
    cells,
    rows,
    desks,
    benches,
    teamPods,
    spawnSpots,
    rosterSpots,
    loungeSpot,
    shell,
    viewW: outerW,
    viewH: outerH,
    worldH: worldH + SHELL * 2,
  };
}

export function cellAt(layout: Layout, x: number, y: number): Cell | null {
  for (const c of layout.cells) if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) return c;
  return null;
}

export function hitTest(layout: Layout, sx: number, sy: number): Robot | null {
  for (let i = layout.desks.length - 1; i >= 0; i--) {
    const d = layout.desks[i];
    if (sx >= d.x && sx <= d.x + d.w && sy >= d.y && sy <= d.y + d.h) return d.robot;
  }
  return null;
}
/** Bench clicks open the team panel. Checked AFTER robots and desks, so the
 *  bench never steals a click meant for someone sitting at it. */
/** The plaque on a bench wins over everyone sitting at it — it is the team's
 *  own button, and it sits where nobody's desk is. */
export function teamPlateHit(layout: Layout, sx: number, sy: number): TeamPod | null {
  for (const pod of layout.teamPods) {
    const p = pod.plate;
    if (sx >= p.x && sx <= p.x + p.w && sy >= p.y && sy <= p.y + p.h) return pod;
  }
  return null;
}

export function teamPodHit(layout: Layout, sx: number, sy: number): TeamPod | null {
  for (const pod of layout.teamPods)
    if (sx >= pod.x && sx <= pod.x + pod.w && sy >= pod.y && sy <= pod.y + pod.h) return pod;
  return null;
}

export function spawnHit(layout: Layout, sx: number, sy: number): SpawnSpot | null {
  for (const s of layout.spawnSpots) {
    if (sx >= s.x && sx <= s.x + s.w && sy >= s.y && sy <= s.y + s.h) return s;
  }
  return null;
}
export function rosterHit(layout: Layout, sx: number, sy: number): GearSpot | null {
  for (const r of layout.rosterSpots) {
    if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) return r;
  }
  return null;
}
export function roomHitTest(layout: Layout, sx: number, sy: number): Room | null {
  return cellAt(layout, sx, sy)?.room ?? null;
}

// ---- team rug + role badges -------------------------------------------------

/**
 * Role colours: stable, flat, readable on every theme's floor.
 *
 * Keyed by KIND, not by name. A team can now call its members anything —
 * "Security", "Scout", "Frontend" — so a lookup by id would leave every custom
 * member grey. What the colour is really saying is what the member is for.
 */
const ROLE_COLOR: Record<TeamMember['kind'], string> = {
  lead: '#5eead4',
  worker: '#5b9dff',
  reviewer: '#f0a24a',
};

/** How a team's state colours its bench trim. */
const POD_STATE: Record<Team['state'], string> = {
  working: '#5b9dff',
  awaiting_human: '#f0a24a',
  done: '#4ade80',
  stopped: '#8494ad',
  error: '#e05a4f',
};

/**
 * A team's shared bench: one long oak surface, three chairs, three places set.
 *
 * Built from the same pieces as an ordinary desk so it reads as furniture from
 * the same workshop rather than as a highlight drawn over the floor. The only
 * thing marking it as a team's is a strip of role colour along the front edge
 * — and a slow pulse when the team is waiting on you, matching every other
 * attention cue in the building.
 */
function drawTeamPod(ctx: CanvasRenderingContext2D, pod: TeamPod, s: number, time: number, hover: boolean, selected: boolean) {
  const waiting = pod.state === 'awaiting_human';
  const tone = POD_STATE[pod.state];

  // Working members light their own patch of the bench.
  for (const seat of pod.seats) {
    const st = seat.robot?.status;
    if (st === 'working' || st === 'done') {
      const a = st === 'working' ? 0.14 : 0.11 + 0.03 * Math.sin(time / 800);
      lightPool(ctx, seat.p.x, pod.deskTop - 4, 26 * s, '#34d399', a);
    }
  }

  // NOTE: no translucent wash any more. A rounded white box over the bench
  // was the one soft-edged thing left in a hard-edged world, and because the
  // members' own hit boxes sit inside the pod's, it flickered on and off as
  // the pointer crossed the row. Hover now draws a crisp frame around the
  // bench (below, after the furniture) and stays lit over members too.

  // chairs go down first — the bench top is drawn over their front legs
  for (const seat of pod.seats) scaled(ctx, seat.p.x, pod.deskTop, s, () => drawChair(ctx));

  // one continuous top, spanning every seat — however many there are. The
  // bench used to be built around exactly three places, which is fine right
  // up until a team has two members, or five.
  const left = pod.seats[0].p.x;
  const spanLocal = (pod.seats[pod.seats.length - 1].p.x - left) / s;
  const gaps = pod.seats.slice(1).map((seat, i) => (seat.p.x + pod.seats[i].p.x) / 2 / s - left / s);
  scaled(ctx, left, pod.deskTop, s, () => {
    const x0 = -31;
    const w = spanLocal + 62;
    contact(ctx, w + 8, 27, 4);
    deskSlab(ctx, x0, w);
    // legs at the ends and midway, like a real bench desk
    px(ctx, x0 + 3, 27, 3, 4, F.oakDark);
    px(ctx, x0 + w - 6, 27, 3, 4, F.oakDark);
    px(ctx, spanLocal / 2 - 1, 27, 3, 4, F.oakDark);
    // low privacy divider between places — what actually makes it read as a
    // shared bench rather than one very wide desk
    for (const at of gaps) {
      px(ctx, at, -6, 1, 8, F.oakEdge);
      px(ctx, at, -6, 1, 2, F.oakHi);
    }
  });

  // the role strip along the front edge, one band per seat
  ctx.save();
  ctx.globalAlpha = waiting ? 0.65 + 0.3 * Math.sin(time / 260) : hover || selected ? 0.95 : 0.7;
  for (const seat of pod.seats) {
    const bw = Math.round(30 * s);
    const bx = Math.round(seat.p.x - bw / 2);
    const by = Math.round(pod.deskTop + 22 * s);
    px(ctx, bx, by, bw, Math.max(2, Math.round(2 * s)), seat.robot ? ROLE_COLOR[seat.kind] : '#4a5468');
  }
  // and a thin tie-bar in the team's state colour, joining the three
  ctx.globalAlpha = waiting ? 0.5 + 0.35 * Math.sin(time / 260) : 0.4;
  px(ctx, Math.round(pod.x + 4), Math.round(pod.deskTop + 26 * s), Math.round(pod.w - 8), Math.max(1, Math.round(s)), tone);
  ctx.restore();

  // places are set even before someone sits down, so the bench never looks
  // half-built while the team is still starting up
  for (const seat of pod.seats)
    scaled(ctx, seat.p.x, pod.deskTop, s, () => {
      const was = grayOn;
      grayOn = false; // the monitor is status, not scenery
      drawWorkstation(ctx, seat.robot?.status ?? 'idle', STATUS_COLOR[seat.robot?.status ?? 'idle'], time);
      grayOn = was;
    });

  // The plaque above the bench: TEAM, in a small dark sign edged in the
  // team's state tone. Always drawn, because it is the team's button — the one
  // thing on the bench that opens the team rather than a member.
  {
    const p = pod.plate;
    const edge = hover || selected ? '#e6ebf3' : tone;
    px(ctx, p.x - 1, p.y - 1, p.w + 2, p.h + 2, '#05070b');
    px(ctx, p.x, p.y, p.w, p.h, hover || selected ? '#1a2434' : '#0e1320');
    px(ctx, p.x, p.y, p.w, 1, edge);
    px(ctx, p.x, p.y + p.h - 1, p.w, 1, edge);
    const dot = Math.max(3, Math.round(4 * s));
    ctx.save();
    ctx.globalAlpha = waiting ? 0.6 + 0.4 * Math.sin(time / 260) : 1;
    px(ctx, p.x + Math.round(6 * s), p.y + Math.round(p.h / 2 - dot / 2), dot, dot, tone);
    ctx.restore();
    ctx.save();
    ctx.font = `600 ${Math.max(8, Math.round(9 * s))}px ${CANVAS_FONT}`;
    ctx.fillStyle = hover || selected ? '#ffffff' : '#dfe6f1';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const tx = p.x + Math.round(6 * s) + dot + Math.round(5 * s);
    ctx.fillText(truncate(ctx, p.label, p.x + p.w - tx - Math.round(6 * s)), tx, p.y + p.h / 2 + 0.5);
    ctx.restore();
  }

  // the hover/selection frame: a hard 2px rectangle around the bench top in
  // the team's state tone — the same language as every other edge here
  if (hover || selected) {
    const fx = Math.round(pod.seats[0].p.x - 34 * s);
    const fw = Math.round(pod.seats[pod.seats.length - 1].p.x + 34 * s) - fx;
    const fy = Math.round(pod.deskTop - 3 * s);
    const fh = Math.round(34 * s);
    ctx.save();
    ctx.globalAlpha = selected ? 0.95 : 0.7;
    px(ctx, fx, fy, fw, 2, tone);
    px(ctx, fx, fy + fh - 2, fw, 2, tone);
    px(ctx, fx, fy, 2, fh, tone);
    px(ctx, fx + fw - 2, fy, 2, fh, tone);
    ctx.restore();
  }
}

// ---- sprites (drawn by the sim layer) --------------------------------------

export interface SpriteView {
  sessionId: string;
  x: number;
  y: number; // head-top anchor
  status: RobotStatus;
  alpha: number;
  scale: number;
  seated: boolean;
  walking: boolean;
  walkPhase: number;
  attention: boolean; // at its desk asking for you: the "!" over its head
  /** walking a handoff over to a teammate — draws a little parcel in hand */
  carrying?: boolean;
  /** heading home from a drinks run — a fresh mug in hand */
  mug?: boolean;
  /** mid-conversation with another robot — draws the wordless chat dots */
  chatting?: boolean;
  /** why it's out: a tiny pictogram over the walker (mug, fish, book…) */
  glyph?: string | null;
}
export interface BubbleView {
  x: number;
  y: number;
  text: string;
  age: number; // 0..1 (1 = expiring)
}

/**
 * Sockets on the wall: one per connector the room's agents can reach, in a
 * patch panel at the top-right of the zone, each with a status LED in the
 * palette the robots already use. The panel is a button (opens the sheet)
 * and the end point of the cable pulse an agent sends when it uses one.
 */
export const SOCKET = 14; // art px per socket, unscaled
export const SOCKET_GAP = 3;
export interface SocketPanel {
  roomId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** each socket's centre, left → right, in the connectors' order */
  centres: P[];
  scale: number;
}

/** Where a room's patch panel sits: inside the top-right corner of the zone. */
export function socketPanel(cell: Cell, connectors: Connector[]): SocketPanel | null {
  if (!cell.room || !connectors.length) return null;
  const s = Math.max(0.7, Math.min(1.15, cell.scale));
  const n = Math.min(connectors.length, 8);
  const pitch = (SOCKET + SOCKET_GAP) * s;
  const w = n * pitch + 6 * s;
  const h = (SOCKET + 8) * s;
  const { iX, iY, iW } = interiorOf(cell);
  const x = Math.round(iX + iW - w - 8);
  const y = Math.round(iY + 6);
  const centres: P[] = [];
  for (let i = 0; i < n; i++) centres.push({ x: x + 3 * s + i * pitch + (SOCKET * s) / 2, y: y + 4 * s + (SOCKET * s) / 2 });
  return { roomId: cell.room.id, x, y, w, h, centres, scale: s };
}

export function socketHit(layout: Layout, connectors: Record<string, Connector[]>, sx: number, sy: number): SocketPanel | null {
  for (const cell of layout.cells) {
    if (!cell.room) continue;
    const p = socketPanel(cell, connectors[cell.room.id] ?? []);
    if (p && sx >= p.x && sx <= p.x + p.w && sy >= p.y && sy <= p.y + p.h) return p;
  }
  return null;
}

const SOCKET_LED: Record<Connector['status'], string> = {
  connected: STATUS_COLOR.working,
  'needs-auth': STATUS_COLOR.waiting_input,
  failed: STATUS_COLOR.error,
  pending: '#8fa3c7',
  disabled: '#2b3446',
};

/** A pulse of light along a cable: an agent is talking to a connector. */
export interface CablePulse {
  sessionId: string;
  roomId: string;
  server: string;
  t0: number; // performance.now() when it fired
}
export const PULSE_MS = 900;

function drawSocketPanel(ctx: CanvasRenderingContext2D, panel: SocketPanel, connectors: Connector[], time: number, hover: boolean) {
  const s = panel.scale;
  // the plate — a strip of brushed steel screwed to the wall
  px(ctx, panel.x, panel.y, panel.w, panel.h, F.K);
  px(ctx, panel.x + 1, panel.y + 1, panel.w - 2, panel.h - 2, hover ? '#3b4762' : '#2f3a50');
  px(ctx, panel.x + 1, panel.y + 1, panel.w - 2, 1, '#4a5876');
  connectors.slice(0, 8).forEach((c, i) => {
    const cx = panel.centres[i].x;
    const cy = panel.centres[i].y;
    const half = (SOCKET * s) / 2;
    // the socket: a dark recess with two pins, a plug seated in it when connected
    px(ctx, cx - half, cy - half, SOCKET * s, SOCKET * s, '#151a25');
    px(ctx, cx - half + 1, cy - half + 1, SOCKET * s - 2, SOCKET * s - 2, c.status === 'disabled' ? '#1b202c' : '#232a3a');
    if (c.status === 'connected' || c.status === 'pending') {
      // a plug: body plus cable stub
      px(ctx, cx - 3 * s, cy - 3 * s, 6 * s, 5 * s, c.transport === 'stdio' ? '#8b95ad' : c.transport === 'claudeai' ? '#c4b5fd' : '#7dd3fc');
      px(ctx, cx - 1 * s, cy + 2 * s, 2 * s, 3 * s, '#5b6478');
    } else {
      // empty socket: the two pin holes
      px(ctx, cx - 2 * s, cy - 1 * s, 1.5 * s, 2 * s, '#0c0f16');
      px(ctx, cx + 1 * s, cy - 1 * s, 1.5 * s, 2 * s, '#0c0f16');
    }
    // the LED, above the socket, in the status palette
    const led = SOCKET_LED[c.status];
    const blink = c.status === 'needs-auth' ? 0.55 + 0.45 * Math.sin(time / 260) : c.status === 'pending' ? 0.4 + 0.4 * Math.sin(time / 180) : 1;
    ctx.save();
    ctx.globalAlpha = blink;
    px(ctx, cx - 1.5 * s, panel.y + 1.5 * s, 3 * s, 2 * s, led);
    ctx.restore();
  });
  if (connectors.length > 8) {
    ctx.fillStyle = '#9fb0c9';
    ctx.font = `500 ${Math.round(8 * s)}px ${CANVAS_FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${connectors.length - 8}`, panel.x + panel.w - 2, panel.y + panel.h / 2);
  }
}

/** The cable from a desk to the wall, with a dot of light travelling it. */
function drawCablePulse(ctx: CanvasRenderingContext2D, from: P, to: P, t: number) {
  const k = Math.max(0, Math.min(1, t));
  ctx.save();
  ctx.globalAlpha = 0.35 * (1 - k * 0.6);
  ctx.strokeStyle = STATUS_COLOR.working;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.lineDashOffset = -t * 40;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  // an elbow: up the wall, then along it — cables run along walls, not across rooms
  ctx.lineTo(from.x, to.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
  // the dot, along the same elbow
  const leg1 = Math.abs(to.y - from.y);
  const leg2 = Math.abs(to.x - from.x);
  const total = leg1 + leg2 || 1;
  const d = k * total;
  const p = d <= leg1 ? { x: from.x, y: from.y + Math.sign(to.y - from.y) * d } : { x: from.x + Math.sign(to.x - from.x) * (d - leg1), y: to.y };
  ctx.globalAlpha = 1 - k * k;
  px(ctx, p.x - 2, p.y - 2, 4, 4, STATUS_COLOR.working);
  ctx.globalAlpha = 0.5 * (1 - k);
  px(ctx, p.x - 3, p.y - 3, 6, 6, STATUS_COLOR.working);
  ctx.restore();
}

interface DrawOpts {
  time: number;
  hoverId: string | null;
  selectedId: string | null;
  /** roomId → its connectors, for the sockets on the wall. */
  connectors?: Record<string, Connector[]>;
  /** agents talking to a connector right now */
  pulses?: CablePulse[];
  /** Focus mode: the world goes monochrome; colour is reserved for the
   *  robots and for signals that need a human (monitors, halos, badges). */
  focus?: boolean;
  themes: Record<string, string>;
  logos: Record<string, string>; // roomId → image data URL (floor decal)
  names: Record<string, string>; // roomId → custom display name
  /** sessionId → the agent's name (custom, or the deterministic default). */
  agentNames: Record<string, string>;
  floors: Record<string, FloorMat>; // roomId → floor material
  decor: Record<string, DecorItem[]>; // roomId → placed items
  live: Record<string, RoomLive>; // roomId → live context for functional decor
  /** Room-editor overlay state (null when not editing). */
  edit: {
    roomId: string;
    selected: number | null; // index into that room's decor
    ghost: { item: string; x: number; y: number; ok: boolean } | null; // placement preview
  } | null;
  sprites: SpriteView[];
  bubbles: BubbleView[];
  focusCell: number | null;
  /** Labels over desks: the task first, then who and what. One per robot
   *  that needs a person, plus the hovered and the selected one. */
  nameTags: NameTag[];
  /** How far the world is scrolled. Anything that flips to avoid the top edge
   *  must test against the SCREEN edge, not the world's — otherwise a bubble
   *  on a scrolled row decides it has headroom and draws off-screen. */
  scrollY?: number;
}

// Decoded room logos, cached by data URL (the rAF loop paints them once ready).
const logoImgs = new Map<string, HTMLImageElement>();
function logoImage(dataUrl: string): HTMLImageElement | null {
  let img = logoImgs.get(dataUrl);
  if (!img) {
    img = new Image();
    img.src = dataUrl;
    logoImgs.set(dataUrl, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

// ---- focus-mode grayscale -------------------------------------------------
// Focus drains the SCENERY of colour. The first cut used ctx.filter =
// 'grayscale(1)', which routes every one of the thousands of tiny pixel fills
// per frame through Chromium's software filter path — measured at 22× slower
// and allocating intermediate surfaces until the machine ran out of memory.
// So instead the COLOURS go gray, not the painting: fillStyle/strokeStyle are
// intercepted on the context, and while the scenery flag is up every colour
// string maps through a memoized luminance table. Plain fills stay plain.
const GRAY = new Map<string, string>();
function toGray(c: string): string {
  let g = GRAY.get(c);
  if (g !== undefined) return g;
  g = c;
  let r = -1;
  let gr = 0;
  let b = 0;
  let a = 1;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)) {
    r = parseInt(c.slice(1, 3), 16);
    gr = parseInt(c.slice(3, 5), 16);
    b = parseInt(c.slice(5, 7), 16);
    if (c.length === 9) a = parseInt(c.slice(7, 9), 16) / 255;
  } else if (/^#[0-9a-f]{3}$/i.test(c)) {
    r = parseInt(c[1] + c[1], 16);
    gr = parseInt(c[2] + c[2], 16);
    b = parseInt(c[3] + c[3], 16);
  } else {
    const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c);
    if (m) {
      r = +m[1];
      gr = +m[2];
      b = +m[3];
      a = m[4] === undefined ? 1 : +m[4];
    }
  }
  if (r >= 0) {
    const l = Math.round(0.2126 * r + 0.7152 * gr + 0.0722 * b);
    g = a >= 1 ? `rgb(${l},${l},${l})` : `rgba(${l},${l},${l},${a})`;
  }
  GRAY.set(c, g);
  return g;
}

let grayOn = false;
const intercepted = new WeakSet<object>();
function ensureGrayInterceptor(ctx: CanvasRenderingContext2D) {
  if (intercepted.has(ctx)) return;
  intercepted.add(ctx);
  for (const prop of ['fillStyle', 'strokeStyle'] as const) {
    let proto: object | null = Object.getPrototypeOf(ctx);
    let desc: PropertyDescriptor | undefined;
    while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, prop))) proto = Object.getPrototypeOf(proto);
    if (!desc?.get || !desc.set) continue;
    const { get, set } = desc;
    Object.defineProperty(ctx, prop, {
      get() {
        return get.call(this);
      },
      set(v: unknown) {
        set.call(this, grayOn && typeof v === 'string' ? toGray(v) : v);
      },
    });
  }
}

export function drawWorld(ctx: CanvasRenderingContext2D, layout: Layout, opts: DrawOpts) {
  ctx.imageSmoothingEnabled = false;
  ensureGrayInterceptor(ctx);
  // Scenery sections raise the flag; signal sections (halos, monitors,
  // sprites) lower it. When focus is off the flag never rises at all.
  const gs = (on: boolean) => {
    grayOn = !!opts.focus && on;
  };
  gs(true);
  drawOutside(ctx, layout);
  // ONE floor under everything: pale boards end to end. Zones lay their
  // carpets on it and the corridors are simply the boards showing between
  // them — which is what makes the plan read as one office, not a card grid.
  drawBaseFloor(ctx, layout.shell);

  const placedByCell = new Map<number, PlacedDecor[]>();
  for (const cell of layout.cells) {
    if (cell.kind === 'lounge') {
      drawLounge(ctx, cell, opts.time);
      continue;
    }
    const room = cell.room!;
    // `undefined` means the room has never been decorated → it gets the
    // automatic furnishing. An empty ARRAY means the user emptied it on
    // purpose, and an emptied room has to stay empty.
    const items = opts.decor[room.id];
    const furniture = items !== undefined ? items : autoDecor(room.id, room.robotCount);
    const placed = layoutDecor(cell, furniture);
    placedByCell.set(cell.idx, placed);
    drawRoom(ctx, layout, cell, themeFor(room, opts.themes), opts.time, opts.logos[room.id], opts.floors[room.id], placed, opts.live[room.id]);
  }
  // Light, before the people: night falls over the whole floor, lamps carve
  // their pools back out — and the benches and agents draw AFTER, so they
  // stay readable in the dark.
  drawAmbiance(ctx, layout, placedByCell);
  // The outer wall goes on top: rooms are laid out inside the building, so
  // the shell overlaps their outermost edge and closes the plan.
  drawShell_(ctx, layout, opts.time);

  // A zone that needs you waves as a WHOLE: its carpet edge glows amber (or
  // red for a break), so you scan the floor rather than hunting 22px sprites.
  gs(false); // a zone waving for help is signal, never scenery
  for (const cell of layout.cells) {
    if (!cell.room) continue;
    const lv = opts.live[cell.room.id];
    if (!lv) continue;
    const color = lv.errors > 0 ? STATUS_COLOR.error : lv.attention > 0 ? STATUS_COLOR.waiting_input : null;
    if (color) drawZoneHalo(ctx, cell, color, opts.time);
  }
  gs(true);

  // hover/selection glow, under the furniture it points at
  for (const d of layout.desks) {
    const hover = d.robot.sessionId === opts.hoverId;
    const selected = d.robot.sessionId === opts.selectedId;
    if (!hover && !selected) continue;
    ctx.fillStyle = selected ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)';
    rr(ctx, d.x, d.y, d.w, d.h, 9);
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1;
      rr(ctx, d.x + 0.5, d.y + 0.5, d.w - 1, d.h - 1, 9);
      ctx.stroke();
    }
  }
  // team benches, then the zone benches — every seat's robot is a sprite
  // drawn later, so nothing here draws a person
  for (const pod of layout.teamPods) {
    const cell = layout.cells[pod.cellIdx];
    // The pod counts as hovered while the pointer is on ANY of it — a member's
    // hit box included. Pod and member used to trade the highlight as the
    // pointer swept the row, which read as flicker rather than affordance.
    const onMember = pod.seats.some((st) => st.robot?.sessionId === opts.hoverId);
    drawTeamPod(
      ctx,
      pod,
      cell.scale,
      opts.time,
      opts.hoverId === `team:${pod.teamId}` || onMember,
      opts.selectedId === `team:${pod.teamId}`,
    );
  }
  for (const bench of layout.benches) {
    const cell = layout.cells[bench.cellIdx];
    drawBenchRow(ctx, bench, cell.scale, opts.time);
  }
  // Sockets on the wall, and the cables lit by whoever is using one. The LEDs
  // are signal (a red one is a connector down), so focus mode leaves them.
  gs(false);
  if (opts.connectors) {
    for (const cell of layout.cells) {
      if (!cell.room) continue;
      const list = opts.connectors[cell.room.id];
      if (!list?.length) continue;
      const panel = socketPanel(cell, list);
      if (!panel) continue;
      for (const pulse of opts.pulses ?? []) {
        if (pulse.roomId !== cell.room.id) continue;
        const t = (opts.time - pulse.t0) / PULSE_MS;
        if (t < 0 || t > 1) continue;
        const desk = layout.desks.find((d) => d.robot.sessionId === pulse.sessionId);
        if (!desk) continue;
        const idx = Math.max(0, Math.min(panel.centres.length - 1, list.findIndex((c) => c.name === pulse.server)));
        drawCablePulse(ctx, { x: desk.seat.x, y: desk.deskTop - 6 }, panel.centres[idx], t);
      }
      drawSocketPanel(ctx, panel, list, opts.time, opts.hoverId === `sockets:${cell.room.id}`);
    }
  }
  gs(true);
  // ghost desks — "hire an agent here"
  for (const s of layout.spawnSpots) {
    const cell = layout.cells[s.cellIdx];
    drawSpawnSpot(ctx, s, cell.scale, opts.time, opts.hoverId === `spawn:${s.roomId}`, opts.selectedId === `spawn:${s.roomId}`);
  }
  // sprites in painter's order — the robots are the one thing focus mode
  // never grays
  gs(false);
  const sorted = [...opts.sprites].sort((a, b) => a.y - b.y);
  for (const s of sorted) drawRobot(ctx, s, opts.time);

  // focus ring (keyboard nav)
  if (opts.focusCell != null) {
    const c = layout.cells[opts.focusCell];
    if (c) {
      ctx.strokeStyle = 'rgba(125,211,252,0.75)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(c.x + 2, c.y + 2, c.w - 4, c.h - 4);
      ctx.setLineDash([]);
    }
  }

  // room-editor overlay: dim the rest, grid the room, selection + ghost
  if (opts.edit) {
    const cell = layout.cells.find((c) => c.room?.id === opts.edit!.roomId);
    if (cell) {
      ctx.fillStyle = 'rgba(5, 7, 11, 0.55)';
      for (const c of layout.cells) {
        if (c.idx === cell.idx) continue;
        ctx.fillRect(c.x, c.y, c.w, c.h);
      }
      const { iX, iY, iW, iH } = interiorOf(cell);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      for (let gy = iY + 8; gy < iY + iH; gy += 16)
        for (let gx = iX + 8; gx < iX + iW; gx += 16) ctx.fillRect(gx, gy, 1.5, 1.5);
      ctx.strokeStyle = 'rgba(94,234,212,0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);

      const items = opts.decor[opts.edit.roomId] ?? [];
      if (opts.edit.selected != null) {
        const sel = layoutDecor(cell, items).find((p) => p.index === opts.edit!.selected);
        if (sel) {
          ctx.strokeStyle = '#ffffff';
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1.5;
          ctx.strokeRect(sel.x - sel.w / 2 - 3, sel.y - sel.h - 3, sel.w + 6, sel.h + 6);
          ctx.setLineDash([]);
        }
      }
      const g = opts.edit.ghost;
      if (g) {
        const def = DECOR_BY_KEY.get(g.item);
        if (def) {
          ctx.save();
          ctx.globalAlpha = g.ok ? 0.65 : 0.3;
          ctx.translate(Math.round(g.x), Math.round(g.y));
          ctx.scale(cell.scale, cell.scale);
          def.draw(ctx, opts.time, themeFor(cell.room!, opts.themes), opts.live[cell.room!.id]);
          ctx.restore();
          if (!g.ok) {
            ctx.strokeStyle = 'rgba(248,113,113,0.9)';
            ctx.lineWidth = 2;
            const gw = def.w * cell.scale;
            const gh = def.h * cell.scale;
            ctx.strokeRect(g.x - gw / 2, g.y - gh, gw, gh);
          }
        }
      }
    }
  }

}

/**
 * Text that sits ON the world rather than in it.
 *
 * The world is rasterised on a coarse art grid and blown up, which is what
 * makes it read as pixel art — but running that same grid through 10px type
 * turns speech bubbles into mush. These are drawn afterwards, straight onto the
 * display surface at full device resolution, so the office stays chunky and the
 * words stay sharp.
 */
export function drawOverlays(ctx: CanvasRenderingContext2D, opts: DrawOpts) {
  for (const s of opts.sprites) {
    const name = opts.agentNames[s.sessionId];
    if (name) drawAgentName(ctx, s, name, s.sessionId === opts.hoverId || s.sessionId === opts.selectedId);
  }
  for (const b of opts.bubbles) drawBubble(ctx, b, opts.scrollY ?? 0);
  for (const tag of opts.nameTags) drawNameTag(ctx, tag, opts.scrollY ?? 0);
}

/**
 * The agent's name, floating over its head — faint until hovered or selected,
 * so the office reads as a staffed room without becoming a diagram of labels.
 * It rides the sprite (walkers carry their name with them), and steps aside
 * while the "!" attention bubble owns that spot.
 */
function drawAgentName(ctx: CanvasRenderingContext2D, sv: SpriteView, name: string, hot: boolean) {
  if (sv.attention) return;
  ctx.save();
  ctx.globalAlpha = (hot ? 0.96 : 0.42) * sv.alpha;
  ctx.font = `600 10px ${CANVAS_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const x = Math.round(sv.x);
  const y = Math.round(sv.y - 9 * sv.scale);
  ctx.fillStyle = '#10151f'; // soft dark backing so pale floors can't eat it
  ctx.fillText(name, x + 1, y + 1);
  ctx.fillStyle = hot ? '#ffffff' : '#e8edf6';
  ctx.fillText(name, x, y);
  ctx.restore();
}

// ---- the building --------------------------------------------------------

/** Brick, for the outside walls. Warmer and darker than the interior plaster. */
const B = {
  top: '#b47048',
  face: '#9c5a3c',
  mortar: '#89492e',
  lip: '#6f3a24',
  glass: '#a4c9da',
  glassHi: '#c9e2ee',
  glassBar: '#7ea9bd',
};

/** The ground the building stands on. */
function drawOutside(ctx: CanvasRenderingContext2D, layout: Layout) {
  const h = Math.max(layout.viewH, layout.worldH);
  px(ctx, 0, 0, layout.viewW, h, '#8f9a86'); // grass verge
  for (let i = 0; i < (layout.viewW * h) / 900; i++) {
    const gx = scat(i, 21) * layout.viewW;
    const gy = scat(i, 22) * h;
    px(ctx, gx, gy, 1, 2, scat(i, 23) > 0.5 ? '#849077' : '#9aa591');
  }
  // a paved apron hugging the walls, so the building meets the ground
  const s = layout.shell;
  const pad = 9;
  px(ctx, s.x - pad, s.y - pad, s.w + pad * 2, s.h + pad * 2, '#a8a49a');
  for (let i = 0; i < ((s.w + 18) * (s.h + 18)) / 700; i++) {
    const gx = s.x - pad + scat(i, 24) * (s.w + pad * 2);
    const gy = s.y - pad + scat(i, 25) * (s.h + pad * 2);
    px(ctx, gx, gy, 2, 1, '#9d998f');
  }
}

/**
 * The floor the whole office stands on: pale boards, running unbroken end to
 * end under zones and corridors alike. 200px boards in 12px rows with a tone
 * flip on ~1 in 4 — the old 90px boards in 13px rows flipped often enough to
 * read as BRICK COURSES once a floor got wider than ~350px.
 */
function drawBaseFloor(ctx: CanvasRenderingContext2D, s: Layout['shell']) {
  const pale = '#cabfa9';
  const alt = '#c3b8a2';
  const seam = '#b0a58f';
  px(ctx, s.x, s.y, s.w, s.h, pale);
  const plank = 12;
  const len = 200;
  for (let r = 0; r < Math.ceil(s.h / plank); r++) {
    const py = s.y + r * plank;
    const ph = Math.min(plank, s.y + s.h - py);
    const off = (r % 4) * 50;
    let c = 0;
    for (let bx = s.x - len + off; bx < s.x + s.w; bx += len, c++) {
      const bx0 = Math.max(s.x, bx);
      const bw = Math.min(bx + len, s.x + s.w) - bx0;
      if (bw > 0 && scat(r * 13 + c, 31) > 0.76) px(ctx, bx0, py, bw, ph - 1, alt);
      if (bx > s.x && bx < s.x + s.w) px(ctx, bx, py, 1, ph - 1, seam);
    }
    px(ctx, s.x, py + ph - 1, s.w, 1, seam);
  }
}

/** The outer wall: brick, with windows along the street side. */
function drawShell_(ctx: CanvasRenderingContext2D, layout: Layout, time: number) {
  const s = layout.shell;
  const T = SHELL; // wall thickness
  const FACE = 10; // how tall the front face reads

  // north wall — top surface, then the face you'd walk into
  px(ctx, s.x - T, s.y - T, s.w + T * 2, T - FACE, B.top);
  px(ctx, s.x - T, s.y - FACE, s.w + T * 2, FACE - 2, B.face);
  for (let r = 0; r < 2; r++) {
    const py = s.y - FACE + r * 4;
    px(ctx, s.x - T, py, s.w + T * 2, 1, B.mortar);
    for (let bx = s.x - T + (r % 2) * 7; bx < s.x + s.w + T; bx += 14) px(ctx, bx, py, 1, 3, B.mortar);
  }
  px(ctx, s.x - T, s.y - 2, s.w + T * 2, 2, B.lip);

  // south wall
  px(ctx, s.x - T, s.y + s.h, s.w + T * 2, 3, B.lip);
  px(ctx, s.x - T, s.y + s.h + 3, s.w + T * 2, T - 3, B.top);

  // east / west walls
  for (const wx of [s.x - T, s.x + s.w]) {
    px(ctx, wx, s.y - T, T, s.h + T * 2, B.face);
    px(ctx, wx, s.y - T, 3, s.h + T * 2, B.top);
    px(ctx, wx + T - 2, s.y - T, 2, s.h + T * 2, B.lip);
  }

  // windows along the north wall, and the daylight they throw on the floor
  const amb = ambiance();
  const step = 240;
  const first = s.x + 60;
  for (let wx = first; wx < s.x + s.w - 80; wx += step) {
    px(ctx, wx - 2, s.y - T + 2, 44, T - 4, B.lip);
    px(ctx, wx, s.y - T + 4, 40, T - 8, amb.darkness > 0.6 ? '#3d4f74' : B.glass);
    px(ctx, wx, s.y - T + 4, 40, 2, amb.darkness > 0.6 ? '#4a5c86' : B.glassHi);
    px(ctx, wx + 19, s.y - T + 4, 2, T - 8, B.glassBar);
    // The light it throws, in flat steps — never a gradient. It starts just
    // inside the brick and falls across the corridor into the zones.
    const y0 = s.y + 2;
    const day = 1 - amb.darkness;
    const a = 0.028 + 0.03 * day;
    ctx.fillStyle = amb.darkness > 0.6 ? 'rgba(150,178,255,0.030)' : `rgba(255,244,214,${a.toFixed(3)})`;
    for (const [inset, len] of [
      [-8, 26],
      [-2, 42],
      [5, 58],
      [12, 74],
    ] as const) {
      ctx.fillRect(wx + inset, y0, 40 - inset * 2, len);
    }
  }
  void time;
}

// ---- rooms ------------------------------------------------------------------

/** Floor materials — all drawn from the room's theme tones (grass excepted). */
/**
 * Scatter hash.
 *
 * Speckle used to be placed by stepping a multiple modulo the width — which
 * walks a straight line and lays the flecks out in diagonal stripes. On a
 * carpet that reads as corduroy. This is a cheap deterministic hash instead, so
 * the grain looks like grain and stays identical frame to frame.
 */
function scat(i: number, salt: number): number {
  const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * Paint a floor material into any rectangle.
 *
 * The settings swatches use this so choosing a floor previews the actual
 * material — boards, carpet weave, grout lines — instead of a flat colour chip
 * that can't tell you the difference between oak and tile.
 */
export function paintFloorSample(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  th: Theme,
  mat?: FloorMat,
) {
  drawFloor(ctx, x, y, w, h, th, mat ?? th.mat);
}

function drawFloor(ctx: CanvasRenderingContext2D, x: number, iY: number, w: number, iH: number, th: Theme, mat: FloorMat) {
  if (mat === 'grass') {
    // Grass in the THEME's light, not one hardcoded lawn: pure #7fb04a made
    // every theme's grass identical, so the settings swatches showed six
    // copies of the same green and the theme picker went dead for grass
    // rooms. Blended toward the theme tones, Oak grows warm, Ocean cool,
    // Slate grey — still unmistakably grass.
    const base = blend('#7fb04a', th.floor, 0.4);
    const dark = blend('#74a343', th.seam, 0.4);
    const lite = blend('#8fbf5b', th.floorAlt, 0.4);
    px(ctx, x, iY, w, iH, base);
    for (let i = 0; i < (w * iH) / 90; i++) {
      const gx = x + scat(i, 1) * (w - 1);
      const gy = iY + scat(i, 2) * (iH - 2);
      px(ctx, gx, gy, 1, 2, scat(i, 3) > 0.5 ? dark : lite);
    }
    return;
  }
  px(ctx, x, iY, w, iH, th.floor);
  ctx.fillStyle = th.floorAlt;
  if (mat === 'checker') {
    for (let ty = 0; ty < Math.ceil(iH / TILE); ty++)
      for (let tx = 0; tx < Math.ceil(w / TILE); tx++) {
        if ((tx + ty) % 2 === 0) continue;
        const px0 = x + tx * TILE;
        const py0 = iY + ty * TILE;
        ctx.fillRect(px0, py0, Math.min(TILE, x + w - px0), Math.min(TILE, iY + iH - py0));
      }
    ctx.fillStyle = th.seam;
    for (let ty = 1; ty * TILE < iH; ty++) ctx.fillRect(x, iY + ty * TILE, w, 1);
    for (let tx = 1; tx * TILE < w; tx++) ctx.fillRect(x + tx * TILE, iY, 1, iH);
  } else if (mat === 'wood') {
    // Boards, not stripes: the seam is the only continuous line, and the tone
    // varies per BOARD (hashed) rather than per row. 170px boards in 11px rows
    // with a flip on ~1 in 4 — at 90x13 with 38% flipped, wide floors read as
    // BRICK COURSES: fine in a 320px room, wrong on an open plan.
    const plank = 11;
    const len = 170;
    for (let r = 0; r < Math.ceil(iH / plank); r++) {
      const py0 = iY + r * plank;
      const ph = Math.min(plank, iY + iH - py0);
      const offset = (r % 4) * 43;
      let c = 0;
      for (let bx = x - len + offset; bx < x + w; bx += len, c++) {
        const bx0 = Math.max(x, bx);
        const bw = Math.min(bx + len, x + w) - bx0;
        if (bw <= 0) continue;
        if (scat(r * 17 + c, 11) > 0.74) px(ctx, bx0, py0, bw, ph - 1, th.floorAlt);
        if (bx > x) px(ctx, bx, py0, 1, ph - 1, th.seam);
      }
      px(ctx, x, py0 + ph - 1, w, 1, th.seam);
    }
  } else if (mat === 'tile') {
    const big = 34;
    for (let ty = 0; ty < Math.ceil(iH / big); ty++)
      for (let tx = 0; tx < Math.ceil(w / big); tx++) {
        if ((tx + ty) % 2 === 0) continue;
        const px0 = x + tx * big;
        const py0 = iY + ty * big;
        px(ctx, px0, py0, Math.min(big, x + w - px0), Math.min(big, iY + iH - py0), th.floorAlt);
      }
    ctx.fillStyle = th.seam;
    for (let r = 1; r * big < iH; r++) ctx.fillRect(x, iY + r * big, w, 1);
    for (let c = 1; c * big < w; c++) ctx.fillRect(x + c * big, iY, 1, iH);
  } else if (mat === 'carpet') {
    for (let i = 0; i < (w * iH) / 26; i++) {
      const gx = x + scat(i, 4) * (w - 1);
      const gy = iY + scat(i, 5) * (iH - 1);
      px(ctx, gx, gy, 1, 1, scat(i, 6) > 0.62 ? th.seam : th.floorAlt);
    }
  } else if (mat === 'stone') {
    const bw = 42;
    const bh = 18;
    for (let r = 0; r < Math.ceil(iH / bh); r++) {
      const py0 = iY + r * bh;
      const ph = Math.min(bh, iY + iH - py0);
      const shift = r % 2 === 0 ? 0 : bw / 2;
      for (let bx = x + shift, c = 0; bx < x + w; bx += bw, c++) {
        if (scat(r * 31 + c, 7) > 0.68) px(ctx, bx, py0, Math.min(bw, x + w - bx), ph - 1, th.floorAlt);
      }
      px(ctx, x, py0 + ph - 1, w, 1, th.seam);
      for (let bx = x + shift; bx < x + w; bx += bw) px(ctx, bx, py0, 1, ph, th.seam);
    }
  }
}

/**
 * A pool of light drawn as concentric FLAT rings — never a gradient (the
 * product's absolute design rule) and cheaper per frame than allocating a
 * gradient object. Overlapping rings composite into a stepped falloff, which
 * is also the truthful look for a world drawn with imageSmoothingEnabled=false.
 */
// hoisted: this runs for every lit desk and lamp, every frame
const POOL_RINGS = [1.32, 1, 0.66, 0.36] as const;

function lightPool(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  alpha: number,
) {
  if (alpha <= 0.002) return;
  // The rings overlap, so painting them all at `alpha` would composite to
  // 1-(1-alpha)^4 — several times the intended brightness. Solve for the
  // per-ring value that lands the CENTRE exactly on `alpha`, and let the
  // widest ring be the faint outer step so the pool doesn't end on a hard edge.
  const per = 1 - Math.pow(1 - alpha, 1 / 4);
  ctx.save();
  ctx.globalAlpha = per;
  ctx.fillStyle = color;
  for (const k of POOL_RINGS) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * k, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Waist-high glass. You can see the whole floor over it, but a zone still has
 * an edge you could lean on. A 2px white top edge is what reads "glass";
 * without it the fill is just a blue smear on the boards.
 */
const GLASS_T = 5;
const GLASS = {
  fill: 'rgba(196,226,240,0.42)',
  hi: 'rgba(255,255,255,0.62)',
  lo: 'rgba(64,102,122,0.45)',
  shadow: 'rgba(52,36,18,0.16)',
};

function glassH(ctx: CanvasRenderingContext2D, x: number, y: number, len: number) {
  if (len < 8) return;
  px(ctx, x, y + GLASS_T, len, 2, GLASS.shadow); // contact shadow on the floor
  px(ctx, x, y, len, GLASS_T, GLASS.fill);
  px(ctx, x, y, len, 2, GLASS.hi);
  px(ctx, x, y + GLASS_T - 1, len, 1, GLASS.lo);
  for (let p = 0; p <= len - 6; p += 64) px(ctx, x + p, y - 1, 6, GLASS_T + 2, F.steelDark);
  px(ctx, x + len - 6, y - 1, 6, GLASS_T + 2, F.steelDark);
}

function glassV(ctx: CanvasRenderingContext2D, x: number, y: number, len: number) {
  if (len < 8) return;
  px(ctx, x + GLASS_T, y, 2, len, GLASS.shadow);
  px(ctx, x, y, GLASS_T, len, GLASS.fill);
  px(ctx, x, y, 2, len, GLASS.hi);
  px(ctx, x + GLASS_T - 1, y, 1, len, GLASS.lo);
  for (let p = 0; p <= len - 6; p += 64) px(ctx, x - 1, y + p, GLASS_T + 2, 6, F.steelDark);
  px(ctx, x - 1, y + len - 6, GLASS_T + 2, 6, F.steelDark);
}

/**
 * A project's zone on the open floor: its carpet, and waist-high glass along
 * the back and both sides — open at the front onto the corridor. This
 * replaced four plaster walls, and it is why the plan reads as one office:
 * nothing taller than a desk stands between you and the far wall.
 *
 * The cell model is untouched. A zone IS a cell; only what drawShell used to
 * paint changed, so layout, hit-testing and the sim never knew.
 */
function drawZone(ctx: CanvasRenderingContext2D, layout: Layout, cell: Cell, th: Theme, mat?: FloorMat) {
  const { iX, iY, iW, iH } = interiorOf(cell);

  // The project's carpet — the material its theme is named for unless the
  // room chose one — with a bound edge, like a laid rug rather than a paint
  // fill that happens to stop.
  drawFloor(ctx, iX, iY, iW, iH, th, mat ?? th.mat);
  px(ctx, iX, iY, iW, 2, th.seam);
  px(ctx, iX, iY + iH - 2, iW, 2, th.seam);
  px(ctx, iX, iY, 2, iH, th.seam);
  px(ctx, iX + iW - 2, iY, 2, iH, th.seam);
  px(ctx, iX, iY, iW, 1, 'rgba(255,255,255,0.10)');

  // Back glass, with a gap wherever a room above walks in — the same doorX
  // the sim's paths cross, so nobody ever steps through a pane.
  const gaps = cellsAbove(layout, cell)
    .map((c) => Math.round(bottomDoorX(c)))
    .filter((dx) => dx > iX + 24 && dx < iX + iW - 24)
    .sort((a, b) => a - b);
  let gx = iX;
  for (const dx of gaps) {
    glassH(ctx, gx, iY, dx - DOOR_W / 2 - gx);
    gx = dx + DOOR_W / 2;
  }
  glassH(ctx, gx, iY, iX + iW - gx);

  // Side glass, opened over the family archway band (the sim already walks
  // through exactly this band between sibling rooms).
  const archY0 = Math.round(iY + iH * 0.5 - ARCH_H / 2);
  const archY1 = archY0 + ARCH_H;
  const side = (x: number, arch: boolean) => {
    if (!arch) {
      glassV(ctx, x, iY, iH);
      return;
    }
    glassV(ctx, x, iY, archY0 - iY);
    glassV(ctx, x, archY1, iY + iH - archY1);
    // accent thresholds, so the opening reads as the family's own walkway
    px(ctx, x - 1, archY0 - 2, GLASS_T + 2, 2, th.accent);
    px(ctx, x - 1, archY1, GLASS_T + 2, 2, th.accent);
  };
  side(iX, cell.archLeft);
  side(iX + iW - GLASS_T, cell.archRight);
}

function drawRoom(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  cell: Cell,
  th: Theme,
  time: number,
  logo: string | undefined,
  floorMat: FloorMat | undefined,
  placed: PlacedDecor[],
  live: RoomLive | undefined,
) {
  const { x, y, w, h } = cell;
  const room = cell.room!;
  drawZone(ctx, layout, cell, th, floorMat);
  const { iX, iY, iW, iH } = interiorOf(cell);

  if (logo) {
    // the project's own mark, printed faintly on the floor
    const img = logoImage(logo);
    if (img) {
      const fit = Math.min((iW * 0.5) / img.naturalWidth, (iH * 0.58) / img.naturalHeight);
      const lw = img.naturalWidth * fit;
      const lh = img.naturalHeight * fit;
      ctx.save();
      ctx.imageSmoothingEnabled = true; // logos are art, not pixel sprites
      ctx.globalAlpha = 0.14;
      ctx.drawImage(
        img,
        Math.round(iX + iW / 2 - lw / 2),
        Math.round(iY + iH * 0.5 - lh / 2),
        Math.round(lw),
        Math.round(lh),
      );
      ctx.restore();
    }
  }

  // Furniture. The user's own arrangement if they made one, otherwise a
  // deterministic one derived from the room id — a room that opens with two
  // props and a field of bare floor looks unfinished no matter how well the
  // floor is drawn. (Chosen by the caller, which also hands the placements to
  // the light pass — lamps carve their pools after night falls.)
  for (const p of placed) {
    ctx.save();
    ctx.translate(Math.round(p.x), Math.round(p.y));
    ctx.scale(cell.scale, cell.scale);
    p.def.draw(ctx, time, th, live);
    ctx.restore();
  }

  // NOTE: no nameplate. The room's name, agent count and ⚙ used to be painted
  // into a 24px band across the top of every room; six of those tiled together
  // is a dashboard, not a floor plan. They live in `RoomLabels` now — real HTML
  // above the canvas, resting on the zone's glass edge the way a map labels a
  // place.

  const baseY = y + h - WALL_BOT - 2;

  if (room.robotCount > MAX_DESKS) {
    // Reads as a button, because it is one — these sessions have no desk and
    // this badge is the only way to reach them.
    const label = `+${room.robotCount - MAX_DESKS} more`;
    ctx.font = `500 10px ${CANVAS_FONT}`;
    const bw = ctx.measureText(label).width + 12;
    const bx = x + w - WALL_SIDE - 26 - bw;
    const by = baseY - 15;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    rr(ctx, bx, by, bw, 16, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    rr(ctx, bx + 0.5, by + 0.5, bw - 1, 15, 8);
    ctx.stroke();
    ctx.fillStyle = '#9fb0c9';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + bw / 2, by + 8);
  }

}

/**
 * The zone-level attention halo: soft glow frames spilling past the carpet
 * onto the corridor, and a crisp breathing line on the carpet's own bound
 * edge. Flat rectangles only — the same no-gradient rule as the light pools.
 */
function drawZoneHalo(ctx: CanvasRenderingContext2D, cell: Cell, color: string, time: number) {
  const { iX, iY, iW, iH } = interiorOf(cell);
  const frame = (pad: number, t: number, a: number) => {
    ctx.globalAlpha = a;
    px(ctx, iX - pad, iY - pad, iW + pad * 2, t, color);
    px(ctx, iX - pad, iY + iH + pad - t, iW + pad * 2, t, color);
    px(ctx, iX - pad, iY - pad, t, iH + pad * 2, color);
    px(ctx, iX + iW + pad - t, iY - pad, t, iH + pad * 2, color);
  };
  ctx.save();
  const breathe = 0.8 + 0.2 * Math.sin(time / 480);
  frame(8, 6, 0.05 * breathe);
  frame(4, 4, 0.09 * breathe);
  frame(0, 2, 0.45 + 0.25 * Math.sin(time / 480));
  ctx.restore();
}

/**
 * Time-of-day pass, once for the WHOLE floor: night falls over everything
 * inside the outer wall — zones and corridors alike, because it is one room
 * now — then lamps and windows carve their pools back out. Runs before the
 * benches and agents draw, so the people stay readable after dark.
 */
function drawAmbiance(ctx: CanvasRenderingContext2D, layout: Layout, placedByCell: Map<number, PlacedDecor[]>) {
  const amb = ambiance();
  const sh = layout.shell;
  if (amb.darkness > 0.01) {
    // Dusk over a LIT floor is a blue-grey veil, not a blackout. At 0.30 a
    // daylight material went straight back to the murk the repaint was meant
    // to remove; 0.14 keeps night a mood.
    ctx.fillStyle = `rgba(28,38,74,${(amb.darkness * 0.14).toFixed(3)})`;
    ctx.fillRect(sh.x, sh.y, sh.w, sh.h);
  }
  // Clip to the interior: an unclipped pool from a lamp near the edge would
  // smear over the brick shell.
  ctx.save();
  ctx.beginPath();
  ctx.rect(sh.x, sh.y, sh.w, sh.h);
  ctx.clip();
  for (const [idx, placed] of placedByCell) {
    const cell = layout.cells[idx];
    for (const p of placed) {
      if (p.def.glow) {
        // Warm lamp pool — soft in daylight, stronger at night. Kept tight to
        // the lamp: at the old radius it spread far enough to read as a
        // painted disc rather than as light coming off a shade.
        const a = 0.07 + 0.2 * amb.darkness;
        lightPool(ctx, p.x, p.y - 10, 26 * cell.scale, '#ffd68c', a);
      } else if (p.def.light === 'sky') {
        // daylight / moonlight falling through the glass onto the floor
        const night = amb.darkness > 0.5;
        const col = night ? '#b2cbff' : '#fff0c8';
        const a = night ? 0.11 * amb.darkness : 0.08 * (1 - amb.darkness);
        if (a > 0.01) lightPool(ctx, p.x, p.y + 8, 30 * cell.scale, col, a);
      }
    }
  }
  // After dark, any bench with someone active on it works under its own warm
  // pool — the light the agents are drawn against, and the reason a busy
  // office at 2am looks busy from across the street.
  if (amb.darkness > 0.5) {
    for (const b of layout.benches) {
      if (!b.seats.some((seat) => seat.robot.status !== 'idle')) continue;
      const s = layout.cells[b.cellIdx].scale;
      lightPool(ctx, b.x0 + b.w / 2, b.deskTop + 6 * s, Math.min(96, b.w / 2 + 30 * s), '#ffd68c', 0.18 * amb.darkness);
    }
    for (const pod of layout.teamPods) {
      if (!pod.seats.some((seat) => seat.robot && seat.robot.status !== 'idle')) continue;
      const s = layout.cells[pod.cellIdx].scale;
      lightPool(ctx, pod.x + pod.w / 2, pod.deskTop + 6 * s, Math.min(96, pod.w / 2 + 20), '#ffd68c', 0.18 * amb.darkness);
    }
  }
  ctx.restore();
}

/**
 * The lounge is an AREA on the open floor, not a walled cell: a rug, a sofa,
 * a low table and armchairs standing on the bare boards. Shared space is
 * furniture, not architecture.
 */
function drawLounge(ctx: CanvasRenderingContext2D, cell: Cell, time: number) {
  const { x, y, w, h } = cell;
  const { iY, iH } = interiorOf(cell);
  const s = cell.scale;
  const cx = x + w / 2;
  const cy = iY + iH * 0.52;

  // the rug: flat woven bands — cloth gets no keyline, it has no hard edge.
  // Sized with the cell's scale like everything on it, or the sitting area
  // reads as dollhouse furniture next to full-size zone benches.
  const rug = '#6f7f96';
  const rugHi = '#8695ac';
  const rx = Math.min(104 * s, w / 2 - 26);
  const ry = Math.min(52 * s, iH / 2 - 16);
  ctx.fillStyle = rug;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = rugHi;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx - 16, ry - 12, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;

  scaled(ctx, cx, cy, s, () => {
    // sofa on the north side, facing the table
    const sx = -30;
    const sy = -40;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, sy + 24, 36, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    px(ctx, sx - 7, sy - 1, 74, 12, F.K);
    px(ctx, sx, sy, 60, 10, '#8a4a3a');
    px(ctx, sx, sy, 60, 3, '#a05a46');
    px(ctx, sx - 6, sy + 4, 8, 18, '#8a4a3a');
    px(ctx, sx + 58, sy + 4, 8, 18, '#8a4a3a');
    px(ctx, sx + 2, sy + 10, 27, 10, '#a05a46');
    px(ctx, sx + 31, sy + 10, 27, 10, '#a05a46');

    // the low table, with the mug that makes it a place people actually sit
    px(ctx, -18, 6, 36, 12, F.K);
    px(ctx, -17, 7, 34, 10, '#4a3b2c');
    px(ctx, -17, 7, 34, 2, '#5d4a37');
    px(ctx, -15, 17, 3, 4, '#32281d');
    px(ctx, 12, 17, 3, 4, '#32281d');
    px(ctx, -4, 2, 5, 4, '#e8edf6');
    ctx.globalAlpha = 0.25 + 0.2 * (Math.sin(time / 240) + 1);
    px(ctx, -2, -2 - ((time / 80) % 5), 2, 3, '#cfd8e6');
    ctx.globalAlpha = 1;

    // armchairs round the table
    drawChairTop(ctx, -86, 2, -1);
    drawChairTop(ctx, 86, 2, -1);
    drawChairTop(ctx, -34, 44, 1);
    drawChairTop(ctx, 34, 44, 1);
  });

  scaled(ctx, x + WALL_SIDE + 18 * s, y + h - WALL_BOT - 3, s, () => drawPlant(ctx, 0, 0));
  scaled(ctx, x + w - WALL_SIDE - 22 * s, y + h - WALL_BOT - 3, s, () => drawCoffee(ctx, 0, 0, time));
}

/**
 * Where the lounge's furniture actually is, for the sim: two sofa cushions a
 * robot can sit on, and the coffee machine it can stand at. These are
 * drawLounge's own offsets made walkable — keep the two in lockstep.
 */
export function loungeAnchors(cell: Cell): { sofa: P[]; machine: P } {
  const { iY, iH } = interiorOf(cell);
  const s = cell.scale;
  const cx = cell.x + cell.w / 2;
  const cy = iY + iH * 0.52;
  return {
    // head-top anchors: a seated sprite (22 rows) lands its torso on the
    // cushions at sy+10, with its head above the backrest — how sofas work
    sofa: [
      { x: cx - 15 * s, y: cy - 52 * s },
      { x: cx + 16 * s, y: cy - 52 * s },
    ],
    machine: { x: cell.x + cell.w - WALL_SIDE - 22 * s, y: cell.y + cell.h - WALL_BOT - 3 - 20 * s },
  };
}

/** A chair seen from above, for seats that face a table. `dir` is -1 when the
 *  backrest is on the north side. */
function drawChairTop(ctx: CanvasRenderingContext2D, cx: number, cy: number, dir: 1 | -1) {
  ctx.fillStyle = 'rgba(52,36,18,0.20)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + 9, 13, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  px(ctx, cx - 12, cy + dir * 10 - 4, 24, 8, F.K); // backrest, far side
  px(ctx, cx - 11, cy + dir * 10 - 3, 22, 6, F.seat);
  px(ctx, cx - 11, cy + dir * 10 - 3, 22, 2, F.seatHi);
  px(ctx, cx - 10, cy - 8, 20, 16, F.K); // seat pad, facing up
  px(ctx, cx - 9, cy - 7, 18, 14, F.seatHi);
  px(ctx, cx - 7, cy - 5, 14, 9, '#778198'); // cushion crown
  px(ctx, cx - 9, cy + 5, 18, 2, F.seatDark); // front lip
  for (const ax of [cx - 12, cx + 9]) {
    px(ctx, ax, cy - 6, 3, 11, F.K); // armrests
    px(ctx, ax, cy - 5, 3, 9, F.seatDark);
  }
}

// ---- furniture kit ---------------------------------------------------------

/**
 * One sun, up and to the left, for everything you can sit at or put things on.
 *
 * Furniture used to be a stack of flat bands in whatever browns were to hand,
 * which is why a desk read as a bar and a chair as a rounded rectangle. These
 * are the shared tones, and `slab` is the shared shape: a lit top surface, a
 * front edge you'd bump your knee on, and a contact shadow underneath.
 */
export const F = {
  /** The keyline. Every object is drawn inside this — one hard dark edge is
   *  what keeps a silhouette together at cell.scale 0.62. */
  K: '#141925',
  oakHi: '#e0b177',
  oak: '#c08d51',
  oakEdge: '#8a6238',
  oakDark: '#5e4022',
  steelHi: '#dbe2ee',
  steel: '#98a1af',
  steelDark: '#5c6470',
  // Chairs are dark NEUTRAL now, not purple: ten of them sit on screen at
  // once, and any chroma they carry competes with the status colours — which
  // are the only thing near an agent that is allowed to be loud.
  seatHi: '#5f6a85',
  seat: '#4a5268',
  seatDark: '#2b3140',
  bezel: '#141925',
  bezelHi: '#39415a',
  paper: '#eae4d6',
  mug: '#c4564a',
  shade: 'rgba(52,36,18,0.22)',
};

/** A contact shadow. Nothing sits ON a floor without one. */
function contact(ctx: CanvasRenderingContext2D, w: number, y: number, squash = 3.5) {
  ctx.fillStyle = F.shade;
  ctx.beginPath();
  ctx.ellipse(0, y, w / 2, squash, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * A desk surface, keyline and all: the dark outline, a lit oak top, and the
 * front edge you'd bump a knee on. The keyline runs 2px past the edge at the
 * bottom, which is the desk's own base shadow — one shape, no extra line.
 * Origin at the desk's top edge; `x0`/`w` in desk-local coordinates, so a lone
 * desk and a team bench are the same slab at different widths.
 */
function deskSlab(ctx: CanvasRenderingContext2D, x0: number, w: number) {
  px(ctx, x0 - 1, -1, w + 2, 29, F.K);
  px(ctx, x0, 0, w, 22, F.oak);
  px(ctx, x0, 0, w, 3, F.oakHi); // the sun catches the back edge
  px(ctx, x0, 22, w, 4, F.oakEdge); // the face you'd walk into
}

// ---- workstation (desk only; the robot is a sprite) -------------------------

/**
 * The task chair, drawn around whoever sits in it.
 *
 * Local coordinates, origin at the desk's top edge. Drawn WHOLE, including the
 * parts the agent covers: it is the same chair whether anyone is in it, and an
 * agent that wanders off used to leave a backrest and two armrests around a
 * chair-shaped hole.
 *
 * The seated agent runs -24 (head-top) to -2 (torso bottom), arms at -10..-4.
 * The backrest's top edge is -22, so it sits BEHIND the shoulders and never
 * rises above the head — a slab of colour parked over the head is the one
 * thing that never reads as a chair, and it is what buried every agent in the
 * old drawing. Wider than before (28px against 24): width was never the
 * problem; position and saturation were.
 */
function drawChair(ctx: CanvasRenderingContext2D) {
  // backrest: keyline, shell, padded roll, recessed panel between bolsters
  px(ctx, -15, -22, 30, 19, F.K);
  px(ctx, -14, -21, 28, 17, F.seat);
  px(ctx, -12, -20, 24, 2, F.seatHi);
  px(ctx, -11, -16, 22, 9, F.seatDark);
  px(ctx, -14, -6, 28, 2, F.seatDark);
  // armrests, just outboard of the agent's arms
  for (const ax of [-18, 12]) {
    px(ctx, ax - 1, -14, 8, 12, F.K);
    px(ctx, ax, -13, 6, 10, F.seatDark);
    px(ctx, ax, -13, 6, 2, F.seatHi);
  }
  px(ctx, -2, -5, 4, 4, F.steelDark); // gas lift, peeking under the backrest
}

/**
 * One workstation's worth of things ON the desk: screen, keyboard, mug, paper.
 * Local coordinates, origin at the desk's top edge — the same for a lone desk
 * and for one place at a team's shared bench.
 */
function drawWorkstation(ctx: CanvasRenderingContext2D, status: RobotStatus, color: string, time: number) {
  const on = status === 'working';
  // ---- monitor, standing at the back of the desk
  const sw = 30;
  const sh = 16;
  px(ctx, -sw / 2 - 3, 1, sw + 6, sh + 5, F.bezel);
  px(ctx, -sw / 2 - 3, 1, sw + 6, 1, F.bezelHi);
  drawScreen(ctx, -sw / 2, 3, sw, sh, status, color, time);
  px(ctx, -sw / 2, 3, sw, 1, 'rgba(255,255,255,0.28)'); // glass highlight
  px(ctx, -sw / 2, 2 + sh, sw, 1, 'rgba(0,0,0,0.30)'); // inner shadow, bottom of the glass
  px(ctx, -5, sh + 6, 10, 2, F.bezelHi); // stand foot

  // ---- what's on the desk in front of it. NO keyboard or mouse: the robot
  // sits BEHIND the desk, so its input devices live on the far side of the
  // monitor where we can't see them — drawing them on the viewer's side put
  // them out of anyone's reach. (The screen facing us is the one licensed
  // lie; it is how status stays readable.)
  px(ctx, -24, 18, 6, 6, F.mug); // mug
  px(ctx, -24, 18, 6, 1, '#e07a6c');
  if (on) {
    // "typing" blips off to the side of the chair. Centred, they landed
    // squarely on the chair's base and read as lights bolted to it.
    px(ctx, 19, -8, 3, 3, color);
    ctx.globalAlpha = 0.2 + 0.5 * (Math.sin(time / 300) + 1) * 0.5;
    px(ctx, 24, -8, 3, 3, color);
    ctx.globalAlpha = 1;
  }
}

/**
 * A zone's shared bench: chairs first, one continuous keylined top over their
 * front legs, then a workstation per place. Stacked away from the viewer —
 * chair, agent (a sprite drawn later), desk — so each owns a band of its own
 * and a working screen is never hidden behind a robot's chest.
 */
function drawBenchRow(ctx: CanvasRenderingContext2D, bench: BenchRow, s: number, time: number) {
  for (const seat of bench.seats) {
    const st = seat.robot.status;
    if (st === 'working' || st === 'done') {
      // green pool: pulsing while working, steady satisfied glow when finished
      const a = st === 'working' ? 0.14 : 0.11 + 0.03 * Math.sin(time / 800);
      lightPool(ctx, seat.x, bench.deskTop - 4, 26 * s, '#34d399', a);
    }
  }
  for (const seat of bench.seats) scaled(ctx, seat.x, bench.deskTop, s, () => drawChair(ctx));
  const cx = bench.x0 + bench.w / 2;
  scaled(ctx, cx, bench.deskTop, s, () => {
    const lw = bench.w / s;
    contact(ctx, lw + 8, 27, 4);
    deskSlab(ctx, -lw / 2, lw);
    px(ctx, -lw / 2 + 3, 27, 3, 4, F.oakDark); // legs at the ends
    px(ctx, lw / 2 - 6, 27, 3, 4, F.oakDark);
  });
  // low privacy divider between places — what makes it read as a shared
  // bench rather than one very wide desk
  for (let i = 1; i < bench.seats.length; i++) {
    const at = (bench.seats[i - 1].x + bench.seats[i].x) / 2;
    scaled(ctx, at, bench.deskTop, s, () => {
      px(ctx, 0, -6, 1, 8, F.oakEdge);
      px(ctx, 0, -6, 1, 2, F.oakHi);
    });
  }
  for (const seat of bench.seats)
    scaled(ctx, seat.x, bench.deskTop, s, () => {
      const was = grayOn;
      grayOn = false; // the monitor is status, not scenery
      drawWorkstation(ctx, seat.robot.status, STATUS_COLOR[seat.robot.status], time);
      grayOn = was;
      if (seat.robot.skills?.length) drawSkillKit(ctx);
      if (seat.robot.playbook) drawPlaybookCard(ctx);
    });
}

/**
 * The card on the desk: this agent is running a playbook. A propped-up sheet
 * with lines on it, in the lavender the panel uses for the same idea — a
 * kind of work, not a status, so it stays out of the status palette.
 */
function drawPlaybookCard(ctx: CanvasRenderingContext2D) {
  px(ctx, -29, 13, 10, 12, F.K);
  px(ctx, -28, 14, 8, 10, '#c4b5fd');
  px(ctx, -27, 16, 6, 1, '#5b4f9a');
  px(ctx, -27, 18, 5, 1, '#5b4f9a');
  px(ctx, -27, 20, 6, 1, '#5b4f9a');
  px(ctx, -27, 22, 3, 1, '#5b4f9a');
}

/**
 * A toolbox on the desk: the mark of a skilled hire. Deliberately quiet —
 * a shape in a neutral navy, not a colour, so it never competes with the
 * status panel beside it. The names live in the panel's session details.
 */
function drawSkillKit(ctx: CanvasRenderingContext2D) {
  px(ctx, 19, 16, 10, 8, F.K);
  px(ctx, 20, 17, 8, 6, '#516e99');
  px(ctx, 20, 17, 8, 2, '#6d8bb5');
  px(ctx, 23, 20, 2, 2, F.steelHi); // the latch
}

/** Ghost desk: a faint dashed desk with a "+" — click to add an agent or a team. */
function drawSpawnSpot(ctx: CanvasRenderingContext2D, s: SpawnSpot, scale: number, time: number, hover: boolean, selected: boolean) {
  const cx = Math.round(s.cx);
  const a = hover || selected ? 0.85 : 0.32 + 0.08 * (Math.sin(time / 900 + cx) + 1);
  ctx.save();
  ctx.globalAlpha = a;
  if (hover || selected) {
    ctx.globalAlpha = 0.16;
    rr(ctx, s.x, s.y, s.w, s.h, 9);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.globalAlpha = a;
  }
  ctx.translate(cx, s.deskTop);
  ctx.scale(scale, scale);
  // dashed outline of the NEXT place at the bench — chalk on a lit floor
  ctx.strokeStyle = hover || selected ? '#ffffff' : '#fbf5e8';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  rr(ctx, -24, -24, 48, 42, 6);
  ctx.stroke();
  ctx.setLineDash([]);
  // "+" badge
  ctx.fillStyle = hover || selected ? '#ffffff' : '#fbf5e8';
  ctx.font = `600 20px ${CANVAS_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('+', 0, -2);
  if (hover || selected) {
    ctx.font = `500 9px ${CANVAS_FONT}`;
    ctx.fillText('new', 0, 13);
  }
  ctx.restore();
}

/**
 * The panel IS the signal: any live state paints the WHOLE screen in the
 * status colour and draws its content dark on top, so a lit desk is countable
 * from across the building. A glyph in a coloured frame could never do that —
 * at cell.scale 0.62 the old dark screens were four near-black rectangles.
 * Content is shaped, not just hued: code lines (working), a prompt and cursor
 * (waiting), "!" (error), a tick (done) — the states stay tellable-apart for
 * anyone who can't lean on the hue alone.
 */
function drawScreen(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, status: RobotStatus, color: string, time: number) {
  if (status === 'idle') {
    px(ctx, x, y, w, h, '#11151d'); // asleep — the one dark panel
    px(ctx, x + 3, y + h - 4, 5, 2, '#2b3446');
    return;
  }
  px(ctx, x, y, w, h, color);
  const ink = F.K;
  if (status === 'working') {
    // code scrolling by
    const scroll = Math.floor(time / 220);
    for (let i = 0; i < 4; i++) px(ctx, x + 3, y + 3 + i * 3, 4 + Math.floor(rand(i + scroll) * (w - 12)), 2, ink);
  } else if (status === 'waiting_input') {
    px(ctx, x + 6, y + 7, 7, 2, ink); // a prompt line…
    if (Math.sin(time / 260) > 0) px(ctx, x + 16, y + 5, 3, 6, ink); // …and its blinking cursor block
  } else if (status === 'error') {
    px(ctx, x + w / 2 - 1, y + 3, 2, 7, ink); // "!"
    px(ctx, x + w / 2 - 1, y + 12, 2, 2, ink);
  } else {
    // done: a tick
    const mx = x + w / 2 - 5;
    const my = y + h / 2;
    px(ctx, mx, my, 2, 2, ink);
    px(ctx, mx + 2, my + 2, 2, 2, ink);
    px(ctx, mx + 4, my, 2, 2, ink);
    px(ctx, mx + 6, my - 2, 2, 2, ink);
    px(ctx, mx + 8, my - 4, 2, 2, ink);
  }
}

// ---- robot sprite ------------------------------------------------------------

/**
 * The agent, authored as a char map — one string per row, the way a sprite
 * sheet reads — instead of a pile of rectangles nobody can see the shape of.
 * 22 art px wide, 32 tall: rows 0–3 are the antenna, the head-top sits at row
 * 4 (the sprite anchors on it), the torso ends at row 25 and the legs run to
 * 31 — ten rows shorter than the old sprite.
 *
 * S is the status colour, and every S sits INSIDE a dark field on purpose: a
 * 2x2 antenna bulb ringed by keyline, a 6x1 brow over two 2x1 eyes inside the
 * visor, and a 6x4 chest plate framed by shell. That is 38 status pixels
 * against the old sprite's 44 — fewer, not more — but none of them border a
 * light tone, which is what lets state survive cell.scale 0.62.
 */
const ROBOT_MAP = [
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
const ROBOT_SEATED_ROWS = 26; // rows 0..25 — a seated agent draws no legs
const ROBOT_HEAD_ROW = 4; // the anchor row: sv.y is the head-top

/** Shell tones, lit from up-and-left: H sun side, M mid, D shadow side. Arms
 *  and legs take the shadow tones — the body is the thing that catches light. */
const ROBOT_INK: Record<string, string> = {
  K: '#141925', // keyline
  H: '#eef3fb',
  M: '#c2cde1',
  D: '#93a0b8',
  V: '#161c29', // visor glass — the dark field the eyes live in
  A: '#93a0b8',
  a: '#74819a',
  L: '#a7b3c8',
  l: '#7d8aa1',
};

interface SpriteRect {
  x: number;
  y: number;
  w: number;
  h: number;
  ch: string;
}

/** Char map → merged rects, once at module load. Horizontal run-length, then
 *  vertical coalescing: ~50 fills per robot instead of one per pixel. */
function mapRects(map: string[]): SpriteRect[] {
  const runs: SpriteRect[] = [];
  map.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === '.') {
        x++;
        continue;
      }
      let n = 1;
      while (x + n < row.length && row[x + n] === ch) n++;
      runs.push({ x, y, w: n, h: 1, ch });
      x += n;
    }
  });
  const byKey = new Map<string, SpriteRect>();
  const out: SpriteRect[] = [];
  for (const r of runs) {
    const key = `${r.x}:${r.w}:${r.ch}`;
    const prev = byKey.get(key);
    if (prev && prev.y + prev.h === r.y) prev.h += 1;
    else {
      const nr = { ...r };
      out.push(nr);
      byKey.set(key, nr);
    }
  }
  return out;
}
const ROBOT_BODY = mapRects(ROBOT_MAP.slice(0, ROBOT_SEATED_ROWS));
// The legs animate independently for the walk cycle. y is relative to row 26.
const ROBOT_LEGS = mapRects(ROBOT_MAP.slice(ROBOT_SEATED_ROWS));
const ROBOT_LEG_L = ROBOT_LEGS.filter((r) => r.x < 11);
const ROBOT_LEG_R = ROBOT_LEGS.filter((r) => r.x >= 11);

function spriteRects(ctx: CanvasRenderingContext2D, rects: SpriteRect[], status: string, ox: number, oy: number) {
  const y0 = Math.round(oy); // the bob is fractional; the art grid is not
  for (const r of rects) {
    ctx.fillStyle = r.ch === 'S' ? status : ROBOT_INK[r.ch];
    ctx.fillRect(ox + r.x, y0 + r.y, r.w, r.h);
  }
}

export function drawRobot(ctx: CanvasRenderingContext2D, sv: SpriteView, time: number) {
  const { status, walking, seated } = sv;
  const color = STATUS_COLOR[status];
  const on = status === 'working';
  ctx.save();
  ctx.globalAlpha = sv.alpha;
  ctx.translate(Math.round(sv.x), Math.round(sv.y));
  ctx.scale(sv.scale, sv.scale);

  const phase = walking ? Math.sin(sv.walkPhase / 90) : Math.sin(time / 140 + sv.x);
  const bob = walking ? Math.abs(Math.sin(sv.walkPhase / 90)) * 1.6 : on && seated ? Math.max(0, -phase) : 0;
  const hy = -bob;

  if (!seated) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, 29, 11, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    // Legs first, body over them: a lifted leg tucks UP behind the torso
    // (keyline meeting keyline). Pushing the planted leg down instead would
    // open a gap of floor at the hip.
    const swing = walking ? Math.sin(sv.walkPhase / 90) * 2.5 : 0;
    spriteRects(ctx, ROBOT_LEG_L, color, -11, hy + 22 - Math.max(0, swing));
    spriteRects(ctx, ROBOT_LEG_R, color, -11, hy + 22 - Math.max(0, -swing));
  }

  spriteRects(ctx, ROBOT_BODY, color, -11, hy - ROBOT_HEAD_ROW);

  // the parcel: a handoff physically travelling across the room
  if (sv.carrying && !seated) {
    px(ctx, 7, hy + 14, 10, 9, F.K);
    px(ctx, 8, hy + 15, 8, 7, '#d9a441');
    px(ctx, 8, hy + 15, 8, 2, '#eec06a');
    px(ctx, 11, hy + 15, 2, 7, '#a8781f');
  } else if (sv.mug && !seated) {
    // the spoils of a drinks run, steaming all the way home
    px(ctx, 9, hy + 16, 5, 5, F.mug);
    px(ctx, 9, hy + 16, 5, 1, '#e07a6c');
    px(ctx, 14, hy + 17, 2, 2, F.mug); // handle
    ctx.globalAlpha = sv.alpha * 0.7;
    px(ctx, 10, hy + 12 - ((time / 300) % 3 | 0), 1, 2, '#cfd8e6');
    ctx.globalAlpha = sv.alpha;
  }

  // blink: the 2x1 eyes go visor-dark for a beat (idle agents don't blink —
  // a muted slate face that also blinks reads as broken, not resting)
  if (status !== 'idle' && Math.sin(time / 700 + sv.x) > 0.96) {
    px(ctx, -3, hy + 5, 2, 1, ROBOT_INK.V);
    px(ctx, 1, hy + 5, 2, 1, ROBOT_INK.V);
  }

  // mid-conversation: three wordless dots taking turns — chatter is dots,
  // text bubbles stay reserved for what agents actually say. They sit ABOVE
  // the floating name: the name is drawn at screen size on the overlay while
  // this sprite scales, so the clearance is scale-aware (the name text is
  // 10 screen px ≈ 10/scale local rows tall, ending near local -9).
  if (sv.chatting && !sv.attention) {
    const dotY = hy - 12 - 8 / sv.scale;
    const active = Math.floor(time / 300 + sv.x) % 3;
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = sv.alpha * (i === active ? 0.95 : 0.35);
      px(ctx, -5 + i * 4, dotY, 2, 2, '#e8edf6');
    }
    ctx.globalAlpha = sv.alpha;
  } else if (sv.glyph && !sv.attention) {
    drawGlyph(ctx, sv.glyph, hy, time, sv.alpha, sv.scale);
  }

  // attention: "!" bubble bobbing overhead
  if (sv.attention) {
    const ab = Math.sin(time / 220) * 2;
    ctx.globalAlpha = sv.alpha * (0.75 + 0.25 * Math.sin(time / 220));
    px(ctx, -5, hy - 20 + ab, 10, 10, status === 'error' ? STATUS_COLOR.error : STATUS_COLOR.waiting_input);
    ctx.fillStyle = status === 'error' ? '#fff' : '#1e293b';
    ctx.font = `700 9px ${CANVAS_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', 0, hy - 15 + ab);
    ctx.globalAlpha = sv.alpha;
  }
  ctx.restore();
}

/**
 * Intent pictograms: a 7px-ish icon over a robot that is out on an errand —
 * the difference between "robot moving" and "robot going for coffee". Drawn
 * in the sprite's own scaled space, so they stay pixel-true.
 */
function drawGlyph(ctx: CanvasRenderingContext2D, glyph: string, hy: number, time: number, alpha: number, scale: number) {
  // above the floating name (which is screen-sized — see the chat dots note)
  const y = Math.round(hy - 17 - 8 / scale) + Math.round(Math.sin(time / 520) * 1);
  ctx.save();
  ctx.globalAlpha = alpha * 0.85;
  switch (glyph) {
    case 'mug':
      px(ctx, -3, y + 2, 5, 4, '#c4564a');
      px(ctx, -3, y + 2, 5, 1, '#e07a6c');
      px(ctx, 2, y + 3, 2, 2, '#c4564a'); // handle
      px(ctx, -2, y - ((time / 320) % 2 | 0), 1, 1, '#cfd8e6'); // steam
      break;
    case 'fish':
      px(ctx, -4, y + 3, 5, 3, '#e8894a');
      px(ctx, 1, y + 2, 2, 2, '#e8894a'); // tail, flicked up
      px(ctx, 1, y + 4, 2, 2, '#e8894a');
      px(ctx, -3, y + 4, 1, 1, '#141925'); // eye
      break;
    case 'book':
      px(ctx, -3, y + 1, 7, 5, '#eae4d6');
      px(ctx, 0, y + 1, 1, 5, '#8a6238'); // spine
      px(ctx, -2, y + 3, 2, 1, '#8494ad');
      px(ctx, 2, y + 3, 2, 1, '#8494ad');
      break;
    case 'game':
      px(ctx, -4, y + 2, 8, 4, '#2c3545');
      px(ctx, -3, y + 3, 1, 2, '#dbe2ee'); // stick
      px(ctx, 1, y + 3, 1, 1, '#4ade80'); // buttons
      px(ctx, 2, y + 4, 1, 1, '#f2a0c0');
      break;
    case 'star':
      px(ctx, -1, y, 2, 2, '#ffd68c');
      px(ctx, -1, y + 4, 2, 2, '#ffd68c');
      px(ctx, -3, y + 2, 2, 2, '#ffd68c');
      px(ctx, 1, y + 2, 2, 2, '#ffd68c');
      px(ctx, -1, y + 2, 2, 2, '#fff0c8');
      break;
    case 'heart':
      px(ctx, -3, y + 1, 2, 2, '#f27b9b');
      px(ctx, 1, y + 1, 2, 2, '#f27b9b');
      px(ctx, -3, y + 2, 6, 2, '#f27b9b');
      px(ctx, -2, y + 4, 4, 1, '#f27b9b');
      px(ctx, -1, y + 5, 2, 1, '#f27b9b');
      break;
  }
  ctx.restore();
}

// ---- bubbles & tags ----------------------------------------------------------

function drawBubble(ctx: CanvasRenderingContext2D, b: BubbleView, scrollY = 0) {
  const maxW = 168;
  ctx.font = `500 10.5px ${CANVAS_FONT}`;
  const words = b.text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const wd of words) {
    const t = cur ? cur + ' ' + wd : wd;
    if (ctx.measureText(t).width > maxW - 16 && cur) {
      lines.push(cur);
      cur = wd;
      if (lines.length === 2) break;
    } else cur = t;
  }
  if (lines.length < 2 && cur) lines.push(cur);
  if (lines.length === 2 && cur && lines[1] !== cur) lines[1] = truncate(ctx, lines[1] + '…', maxW - 16);

  const w = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16);
  const h = lines.length * 13 + 10;
  const canvas = ctx.canvas as HTMLCanvasElement;
  const x = Math.round(clamp(b.x - w / 2, 4, canvas.clientWidth - w - 4));
  let y = Math.round(b.y - h - 12);
  let tailUp = false; // bubble below the robot when clipped at the top
  if (y - scrollY < 4) {
    y = Math.round(b.y + 48);
    tailUp = true;
  }
  const fade = b.age > 0.8 ? 1 - (b.age - 0.8) / 0.2 : 1;

  const tailX = clamp(b.x, x + 8, x + w - 8);
  ctx.save();
  ctx.globalAlpha = 0.94 * fade;
  rr(ctx, x, y, w, h, 7);
  ctx.fillStyle = '#f4f6fa';
  ctx.fill();
  ctx.beginPath(); // tail (points at the robot)
  if (tailUp) {
    ctx.moveTo(tailX - 4, y);
    ctx.lineTo(tailX + 4, y);
    ctx.lineTo(tailX, y - 5);
  } else {
    ctx.moveTo(tailX - 4, y + h);
    ctx.lineTo(tailX + 4, y + h);
    ctx.lineTo(tailX, y + h + 5);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#1a2130';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x + 8, y + 6 + i * 13));
  ctx.restore();
}

export interface NameTag {
  x: number;
  y: number;
  title: string;
  sub: string;
  /** warn: waiting on you · err: stopped · live: hovered or selected */
  tone?: 'warn' | 'err' | 'live';
}
const TAG_TONE: Record<NonNullable<NameTag['tone']>, string> = { warn: '#fbbf24', err: '#f87171', live: '#5eead4' };

function drawNameTag(ctx: CanvasRenderingContext2D, tag: NameTag, scrollY = 0) {
  ctx.font = `600 11px ${CANVAS_FONT}`;
  const tw = ctx.measureText(tag.title).width;
  ctx.font = `500 9.5px ${CANVAS_FONT}`;
  const sw = ctx.measureText(tag.sub).width;
  const w = Math.max(tw, sw) + 16;
  const h = 30;
  // Centred on the robot, but kept inside the canvas: a desk by the wall
  // must not push half its label out of the window.
  const W = ctx.canvas.width / (ctx.getTransform().a || 1);
  const x = Math.round(Math.min(Math.max(4, tag.x - w / 2), W - w - 4));
  const cx = x + w / 2;
  // Above the robot normally, below it when that would put the tag off the top
  // of the SCREEN — which is where a hovered robot on a scrolled row sits.
  const above = Math.round(tag.y - h - 32);
  const y = above - scrollY < 4 ? Math.round(tag.y + 14) : above;
  ctx.save();
  ctx.globalAlpha = 0.95;
  rr(ctx, x, y, w, h, 6);
  ctx.fillStyle = '#10151f';
  ctx.fill();
  ctx.strokeStyle = tag.tone ? TAG_TONE[tag.tone] : '#2a3550';
  ctx.lineWidth = 1;
  rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 6);
  ctx.stroke();
  if (tag.tone) {
    // A short bar of the tone colour on the left edge: readable from across
    // the room before the words are.
    ctx.fillStyle = TAG_TONE[tag.tone];
    ctx.fillRect(x + 1, y + 7, 3, h - 14);
  }
  ctx.fillStyle = '#e8edf6';
  ctx.font = `600 11px ${CANVAS_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(tag.title, cx, y + 5);
  ctx.fillStyle = '#8494ad';
  ctx.font = `500 9.5px ${CANVAS_FONT}`;
  ctx.fillText(tag.sub, cx, y + 17);
  ctx.restore();
}

// ---- props --------------------------------------------------------------------

function rand(n: number): number {
  return (((Math.sin(n * 12.9898 + 4.1) * 43758.5) % 1) + 1) % 1;
}

/** A potted plant with the house keyline — corridor and lounge greenery. */
function drawPlant(ctx: CanvasRenderingContext2D, cx: number, base: number) {
  px(ctx, cx - 6, base - 8, 12, 9, F.K);
  px(ctx, cx - 5, base - 7, 10, 7, '#a8674a');
  px(ctx, cx - 5, base - 7, 10, 2, '#c07d5c');
  px(ctx, cx - 8, base - 24, 16, 16, F.K);
  px(ctx, cx - 7, base - 23, 14, 14, '#4e8a52');
  px(ctx, cx - 6, base - 22, 8, 5, '#68a862');
}

/** The lounge coffee machine, in steel with the house keyline. */
function drawCoffee(ctx: CanvasRenderingContext2D, cx: number, base: number, time: number) {
  px(ctx, cx - 9, base - 24, 18, 24, F.K);
  px(ctx, cx - 8, base - 23, 16, 22, F.steel);
  px(ctx, cx - 8, base - 23, 16, 3, F.steelHi);
  px(ctx, cx - 5, base - 16, 10, 6, '#2b2119');
  px(ctx, cx - 3, base - 8, 6, 2, F.mug);
  ctx.globalAlpha = 0.25 + 0.2 * (Math.sin(time / 220) + 1);
  px(ctx, cx - 1, base - 27 - ((time / 70) % 5), 2, 3, '#cfd8e6');
  ctx.globalAlpha = 1;
}

// ---- utils ---------------------------------------------------------------------

function scaled(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, draw: () => void) {
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.scale(s, s);
  draw();
  ctx.restore();
}
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h), r);
}
function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(w), Math.ceil(h));
}
function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function blend(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const m = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `rgb(${m[0]},${m[1]},${m[2]})`;
}
