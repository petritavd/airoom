import type { Robot, RobotStatus } from '@shared/types';
import {
  bottomDoorX,
  cellBelow,
  cellsAbove,
  interiorOf,
  loungeAnchors,
  WALL_TOP,
  WALL_BOT,
  WALL_FACE,
  WALL_SIDE,
  type BubbleView,
  type Cell,
  type Desk,
  type Layout,
  type P,
  type SpriteView,
} from './draw';
import { autoDecor, layoutDecor } from './decor';
import type { DecorItem } from '../roomConfig';
import { ambiance } from './ambiance';
import { sound } from '../sound';


/** `prefers-reduced-motion`, read once and kept fresh. The canvas honoured it
 *  nowhere until now; the CSS did. */
const calmQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
let prefersCalm = calmQuery?.matches ?? false;
calmQuery?.addEventListener?.('change', (e) => {
  prefersCalm = e.matches;
});
// Robot bodies extend 28px below their head-top anchor (feet at +28): keep
// feet inside the room by anchoring bottom-area targets above the bottom wall.
const BODY_H = 34;

/**
 * The life layer: robots are sprites that walk in through the front opening,
 * sit at their desk, stand at the opening when they need you — and, when idle,
 * take short trips that mean something: a coffee, a look at the fish, a game
 * on the arcade, a chat with a colleague, a sit on the lounge sofa.
 *
 * Every outing targets a PLACE derived from the room's actual decor (see
 * `buildPlaces`). If a room has nothing worth visiting, its robots stay put —
 * a robot standing in an empty corner is worse than a robot at its desk,
 * which is the bug this system replaced.
 */

type Mode =
  | 'enter' // walking in from the opening to the desk
  | 'seated'
  | 'visit' // at a colleague's desk: carrying a handoff, or just to chat
  | 'toDoor' // needs attention → walking to the opening
  | 'atDoor' // standing at the opening with a "!" bubble
  | 'wander' // walking to a place in its own room
  | 'toLounge' // walking to a place in ANOTHER room (door + hallway hop)
  | 'pause' // at a place (standing or sitting), waiting to head back
  | 'return' // heading back to the desk
  | 'leave'; // session gone → walking out

/** A destination worth walking to, derived from a room's real furniture. */
export interface Place {
  kind: string; // decor key ('coffee', 'fish', …)
  cellIdx: number;
  x: number; // robot head-top anchor when using it
  y: number;
  sit: boolean; // sat on (sofa cushion) rather than stood at
  social: boolean; // a second robot may join and chat
  capacity: number;
  dwell: [number, number]; // how long a visit lasts, ms
  glyph: string | null; // intent pictogram shown over the walker
  weight: number; // how attractive it is when choosing an outing
}

interface Sprite {
  sessionId: string;
  roomId: string;
  cellIdx: number;
  x: number;
  y: number;
  alpha: number;
  mode: Mode;
  path: P[];
  waitUntil: number;
  status: RobotStatus;
  walkPhase: number;
  scale: number;
  seat: P;
  nextWanderAt: number; // cooldown so outings stay rare
  nextChatAt: number; // cooldown for desk-side chats
  teleportTo: P | null; // "hallway" hop: fade out at own door, in at this point
  teleportTarget: P | null; // where to walk after the hop
  lastActivity: string | null; // wall-clock ISO from the transcript
  needsApproval: boolean; // live run blocked on a permission request
  carrying: boolean; // a handoff parcel is in hand (visit walk)
  mug: boolean; // walking back from the coffee machine with a fresh one
  visitLabel: string | null; // bubble shown at the receiver's desk on arrival
  visitTo: string | null; // receiver's sessionId
  mingleWith: string | null; // visit-to-chat: who it walked over to see
  place: Place | null; // the outing's destination (or where it is now)
  sitting: boolean; // parked ON furniture — drawn with the seated sprite
  glyph: string | null; // intent pictogram while walking / at the place
  chatWith: string | null; // mid-conversation with this robot
  chatUntil: number;
}

interface Bubble {
  sessionId: string;
  text: string;
  born: number;
}

const SPEED = 62; // px/s at scale 1
const BUBBLE_MS = 6500;
// Outings are RARE and purposeful: the first one shortly after going idle
// (idle is when you're watching for signs of life), then every few minutes.
const WANDER_MIN_MS = 90_000;
const WANDER_JITTER_MS = 150_000;
const FIRST_WANDER_MIN_MS = 20_000;
const FIRST_WANDER_JITTER_MS = 60_000;
const CHAT_MIN_MS = 90_000;
const CHAT_JITTER_MS = 150_000;

const ATTN = (s: RobotStatus) => s === 'waiting_input' || s === 'error';

/**
 * Does this agent need a person? A waiting or stopped agent, or one blocked
 * on a tool approval. It stays at its desk either way: the amber monitor,
 * the "!" over its head and the desk label say so. It used to walk to the
 * door, which read as an agent leaving its work rather than waiting on it,
 * and put the one robot you had to find in the one place its desk was not.
 * The only movement attention causes now is the way back: an agent out on a
 * break returns to its seat the moment it needs you.
 */
function needsPerson(sprite: { status: RobotStatus; needsApproval: boolean }): boolean {
  return sprite.needsApproval || ATTN(sprite.status);
}

/**
 * What each kind of furniture is FOR. An item without an entry is scenery —
 * rugs and lamps are walked past, not visited. `dy` places the robot's
 * head-top anchor relative to the item's floor anchor: standing puts feet a
 * step in front (-20 = feet at +8); sitting tucks the torso onto the cushion.
 */
const OUTINGS: Record<
  string,
  {
    dwell: [number, number];
    weight: number;
    glyph?: string;
    social?: boolean;
    capacity?: number;
    sit?: boolean;
    dy?: number;
    /** multi-seat furniture: one place per cushion, at these x offsets */
    seats?: number[];
  }
> = {
  coffee: { dwell: [4000, 7000], weight: 2.5, glyph: 'mug', social: true, capacity: 2 },
  cooler: { dwell: [5000, 9000], weight: 2.5, glyph: 'mug', social: true, capacity: 2 },
  vending: { dwell: [3000, 5000], weight: 1.5, glyph: 'mug' },
  fish: { dwell: [7000, 11000], weight: 3, glyph: 'fish', social: true, capacity: 2 },
  tv: { dwell: [6000, 10000], weight: 2, social: true, capacity: 2 },
  board: { dwell: [5000, 8000], weight: 2, glyph: 'book' },
  shelf: { dwell: [5000, 8000], weight: 2, glyph: 'book' },
  arcade: { dwell: [8000, 12000], weight: 3, glyph: 'game' },
  dart: { dwell: [6000, 9000], weight: 2, glyph: 'game', dy: -10 },
  window: { dwell: [6000, 10000], weight: 1.5, glyph: 'star' },
  cat: { dwell: [4000, 7000], weight: 4, glyph: 'heart' },
  plant_l: { dwell: [2500, 4000], weight: 1 },
  plant_s: { dwell: [2500, 4000], weight: 1 },
  cactus: { dwell: [2500, 4000], weight: 1 },
  sofa: { dwell: [9000, 15000], weight: 3, sit: true, social: true, seats: [-13, 13], dy: -28 },
  beanbag: { dwell: [9000, 15000], weight: 2.5, sit: true, dy: -26 },
  chair: { dwell: [8000, 13000], weight: 2, sit: true, dy: -27 },
  stool: { dwell: [6000, 9000], weight: 1.5, sit: true, dy: -30 },
};

/**
 * Every place a robot could visit, derived from the rooms' ACTUAL furniture —
 * the user's arrangement, or the same auto-furnishing the renderer draws. The
 * lounge contributes its sofa cushions and coffee machine. Recomputed by the
 * host whenever layout or decor changes and handed to the sim via setPlaces.
 */
export function buildPlaces(layout: Layout, decorByRoom: Record<string, DecorItem[]>): Place[] {
  const out: Place[] = [];
  for (const cell of layout.cells) {
    if (cell.kind === 'lounge') {
      const a = loungeAnchors(cell);
      for (const p of a.sofa)
        out.push({
          kind: 'sofa',
          cellIdx: cell.idx,
          x: Math.round(p.x),
          y: Math.round(p.y),
          sit: true,
          social: true,
          capacity: 1,
          dwell: [9000, 16000],
          glyph: null,
          weight: 3.5,
        });
      out.push({
        kind: 'coffee',
        cellIdx: cell.idx,
        x: Math.round(a.machine.x),
        y: Math.round(a.machine.y),
        sit: false,
        social: true,
        capacity: 2,
        dwell: [4000, 8000],
        glyph: 'mug',
        weight: 2.5,
      });
      continue;
    }
    if (!cell.room) continue;
    const items = decorByRoom[cell.room.id] ?? autoDecor(cell.room.id, cell.room.robotCount);
    const s = cell.scale;
    for (const p of layoutDecor(cell, items)) {
      const prof = OUTINGS[p.def.key];
      if (!prof) continue;
      const dy = prof.dy ?? -20;
      for (const dx of prof.seats ?? [0])
        out.push({
          kind: p.def.key,
          cellIdx: cell.idx,
          x: Math.round(p.x + dx * s),
          y: Math.round(p.y + dy * s),
          sit: !!prof.sit,
          social: !!prof.social,
          // a two-seater splits into two places of one; everything else
          // carries its own capacity
          capacity: prof.seats ? 1 : (prof.capacity ?? 1),
          dwell: prof.dwell,
          glyph: prof.glyph ?? null,
          weight: prof.weight,
        });
    }
  }
  return out;
}

const placeKey = (p: Place) => `${p.cellIdx}|${p.x}|${p.y}`;

export class Sim {
  private sprites = new Map<string, Sprite>();
  private bubbles: Bubble[] = [];
  private lastSpoken = new Map<string, string>();
  private lastStatus = new Map<string, RobotStatus>();
  private places: Place[] = [];
  private booted = false;

  /** The current furniture map — call whenever layout or decor changes. */
  setPlaces(places: Place[]) {
    this.places = places;
    // A place can vanish under a visitor (redecorating, a relayout). Send
    // anyone attached to a missing place home rather than leave them parked
    // at coordinates that no longer mean anything.
    const live = new Set(places.map(placeKey));
    for (const s of this.sprites.values())
      if (s.place && !live.has(placeKey(s.place)) && (s.mode === 'wander' || s.mode === 'toLounge' || s.mode === 'pause'))
        s.waitUntil = 0; // the pause branch (or arrival) will route it home
  }

  /** Sync sprites with the latest snapshot + layout (call on layout change). */
  /** The last layout the sim was reconciled against — a handoff needs it to
   *  route a parcel through the doorway between two rooms. */
  private lastLayout: Layout | null = null;

  reconcile(layout: Layout, robots: Robot[], now: number) {
    this.lastLayout = layout;
    const deskBy = new Map<string, Desk>();
    for (const d of layout.desks) deskBy.set(d.robot.sessionId, d);

    let enterIdx = 0;
    for (const robot of robots) {
      const desk = deskBy.get(robot.sessionId);
      const sprite = this.sprites.get(robot.sessionId);
      if (!desk) {
        // overflow robot (no desk shown) — no sprite
        if (sprite) {
          this.endChat(sprite);
          this.sprites.delete(robot.sessionId);
        }
        continue;
      }
      const cell = layout.cells[desk.cellIdx];

      if (!sprite) {
        const door = doorInside(cell);
        this.sprites.set(robot.sessionId, {
          sessionId: robot.sessionId,
          roomId: robot.roomId,
          cellIdx: cell.idx,
          x: door.x,
          y: door.y,
          alpha: 0,
          mode: 'enter',
          path: benchDetour(layout, cell.idx, door, desk.seat),
          waitUntil: now + 250 + enterIdx++ * 260,
          status: robot.status,
          walkPhase: 0,
          scale: cell.scale,
          seat: desk.seat,
          nextWanderAt: now + FIRST_WANDER_MIN_MS + Math.random() * FIRST_WANDER_JITTER_MS,
          nextChatAt: now + CHAT_MIN_MS / 2 + Math.random() * CHAT_JITTER_MS,
          teleportTo: null,
          teleportTarget: null,
          lastActivity: robot.lastActivity,
          needsApproval: !!robot.needsApproval,
          carrying: false,
          mug: false,
          visitLabel: null,
          visitTo: null,
          mingleWith: null,
          place: null,
          sitting: false,
          glyph: null,
          chatWith: null,
          chatUntil: 0,
        });
      } else {
        // status transitions → sounds
        const prev = this.lastStatus.get(robot.sessionId);
        if (this.booted && prev !== undefined && !ATTN(prev) && ATTN(robot.status)) sound.ding();
        if (this.booted && prev === 'working' && robot.status === 'done') sound.chime();

        sprite.status = robot.status;
        sprite.scale = cell.scale;
        sprite.seat = desk.seat;
        sprite.lastActivity = robot.lastActivity;
        sprite.needsApproval = !!robot.needsApproval;
        if (sprite.roomId !== robot.roomId || sprite.cellIdx !== cell.idx) {
          // the agent moved rooms (cwd changed) or the grid re-flowed
          this.endChat(sprite);
          sprite.roomId = robot.roomId;
          sprite.cellIdx = cell.idx;
          const door = doorInside(cell);
          sprite.x = door.x;
          sprite.y = door.y;
          sprite.mode = 'enter';
          sprite.path = benchDetour(layout, cell.idx, door, desk.seat);
          sprite.waitUntil = now;
          sprite.place = null;
          sprite.sitting = false;
          sprite.glyph = null;
        } else if (sprite.mode === 'seated') {
          sprite.x = desk.seat.x;
          sprite.y = desk.seat.y;
        } else if ((sprite.mode === 'enter' || sprite.mode === 'return') && sprite.path.length) {
          sprite.path[sprite.path.length - 1] = desk.seat;
        }
      }
      this.lastStatus.set(robot.sessionId, robot.status);

      // speech bubbles: newly finished assistant text
      const lastText = [...robot.recentSteps].reverse().find((s) => s.kind === 'assistant_text')?.label;
      if (lastText) {
        const prev = this.lastSpoken.get(robot.sessionId);
        if (this.booted && prev !== undefined && prev !== lastText) {
          this.bubbles.push({ sessionId: robot.sessionId, text: lastText, born: now });
          if (this.bubbles.length > 4) this.bubbles.shift();
        }
        this.lastSpoken.set(robot.sessionId, lastText);
      }
    }

    // sessions that disappeared → walk out (or vanish if their room is gone)
    const liveIds = new Set(robots.map((r) => r.sessionId));
    for (const sprite of [...this.sprites.values()]) {
      if (liveIds.has(sprite.sessionId)) continue;
      const cell = layout.cells[sprite.cellIdx];
      if (!cell || sprite.mode === 'leave') {
        if (!cell) {
          this.endChat(sprite);
          this.sprites.delete(sprite.sessionId);
        }
        continue;
      }
      this.endChat(sprite);
      sprite.mode = 'leave';
      sprite.path = benchDetour(layout, cell.idx, { x: sprite.x, y: sprite.y }, doorInside(cell));
      sprite.waitUntil = now;
      sprite.place = null;
      sprite.sitting = false;
      sprite.glyph = null;
    }

    this.booted = true;
  }

  tick(dtMs: number, now: number, layout: Layout, lockedOut = false) {
    // Two reasons for the office to go still: the caller asked for it, or the
    // person asked their OS for less motion. Same treatment either way —
    // seats, work and attention still read; nobody strolls to the arcade.
    const frozen = lockedOut || prefersCalm;
    this.bubbles = this.bubbles.filter((b) => now - b.born < BUBBLE_MS);

    for (const sprite of [...this.sprites.values()]) {
      // Asked to stand still: the life layer stands down. Anyone mid-outing walks
      // back to their seat and the office goes still — no wandering, no bench
      // chats, no parcel deliveries. A locked app that keeps bustling in the
      // background reads as "working fine, just covered up".
      if (frozen && ['wander', 'pause', 'toLounge', 'lounging', 'visit'].includes(sprite.mode)) {
        this.endChat(sprite);
        sprite.mode = 'return';
        sprite.place = null; // free the spot they were visiting
        sprite.carrying = false;
        sprite.visitLabel = null;
        sprite.visitTo = null;
        sprite.teleportTo = null;
        sprite.teleportTarget = null;
        sprite.path = [sprite.seat];
        sprite.waitUntil = now;
      }
      // Chat upkeep runs even while paused: a conversation ends when its time
      // is up, when the partner left, or when either side got real work.
      if (sprite.chatWith) {
        const partner = this.sprites.get(sprite.chatWith);
        const busy = sprite.mode === 'seated' && sprite.status !== 'idle';
        if (!partner || partner.chatWith !== sprite.sessionId || now > sprite.chatUntil || busy)
          this.endChat(sprite);
      }

      if (now < sprite.waitUntil && sprite.mode !== 'pause') continue;
      if (sprite.alpha < 1) sprite.alpha = Math.min(1, sprite.alpha + dtMs / 260);

      if (sprite.path.length) {
        // Real work preempts a leisure walk mid-stride — nobody saunters to
        // the aquarium while their run is generating.
        if (
          (sprite.mode === 'wander' || sprite.mode === 'visit') &&
          !sprite.carrying &&
          (sprite.status === 'working' || needsPerson(sprite))
        ) {
          this.goHome(sprite, layout, now);
        }
        sprite.walkPhase += dtMs;
        const target = sprite.path[0];
        const spd = (SPEED * sprite.scale * dtMs) / 1000;
        const dx = target.x - sprite.x;
        const dy = target.y - sprite.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= spd) {
          sprite.x = target.x;
          sprite.y = target.y;
          sprite.path.shift();
          if (!sprite.path.length) this.arrive(sprite, now, layout);
        } else {
          sprite.x += (dx / dist) * spd;
          sprite.y += (dy / dist) * spd;
        }
        continue;
      }

      // safety net: a leaver with nowhere to walk is simply gone
      if (sprite.mode === 'leave') {
        this.sprites.delete(sprite.sessionId);
        continue;
      }

      // stationary decisions
      const cell = layout.cells[sprite.cellIdx];
      if (!cell) continue;
      switch (sprite.mode) {
        case 'seated':
          if (needsPerson(sprite)) {
            // Stays put. A bench chat ends, because a waiting agent is not
            // idle company; nothing else changes at the desk.
            this.endChat(sprite);
          } else if (
            !frozen &&
            sprite.status === 'idle' &&
            !sprite.chatWith &&
            now > sprite.nextWanderAt &&
            Math.random() < dtMs * 0.002 && // spread triggers — no thundering herd after catch-up
            this.roamerCount() < 2 // the office stays calm: at most 2 on a break
          ) {
            sprite.nextWanderAt = now + WANDER_MIN_MS + Math.random() * WANDER_JITTER_MS;
            this.startOuting(sprite, layout, now);
          } else if (
            !frozen &&
            sprite.status === 'idle' &&
            !sprite.chatWith &&
            now > sprite.nextChatAt &&
            Math.random() < dtMs * 0.0015
          ) {
            this.tryBenchChat(sprite, now);
          }
          break;
        case 'atDoor':
          if (!ATTN(sprite.status)) {
            sprite.mode = 'return';
            sprite.path = benchDetour(layout, cell.idx, { x: sprite.x, y: sprite.y }, sprite.seat);
          }
          break;
        case 'pause':
          // Chatting robots stay put past their own timer — leaving mid-
          // sentence is for status changes, not the clock.
          if (needsPerson(sprite)) {
            // Needed while out: straight back to the desk, not to the door.
            this.endChat(sprite);
            sprite.place = null;
            sprite.sitting = false;
            sprite.glyph = null;
            this.goHome(sprite, layout, now);
          } else if (
            sprite.status === 'working' ||
            (now > sprite.waitUntil && !(sprite.chatWith && now < sprite.chatUntil))
          ) {
            this.goHome(sprite, layout, now);
          }
          break;
        default:
          break;
      }

      // quiet keyboard from working robots
      if (!frozen && sprite.status === 'working' && sprite.mode === 'seated' && Math.random() < dtMs * 0.0012)
        sound.clack();
    }
  }

  // ---- outings ---------------------------------------------------------------

  private usersAt(place: Place, except?: Sprite): number {
    const key = placeKey(place);
    let n = 0;
    for (const s of this.sprites.values()) {
      if (s === except || !s.place) continue;
      if ((s.mode === 'wander' || s.mode === 'toLounge' || s.mode === 'pause') && placeKey(s.place) === key) n++;
    }
    return n;
  }

  private roamerCount(): number {
    let n = 0;
    for (const s of this.sprites.values())
      if (['wander', 'pause', 'toLounge'].includes(s.mode)) n++;
    return n;
  }

  /**
   * Choose what an idle robot does with its break. Company first: joining a
   * colleague already out beats a solo trip. Then a chat at a desk, then a
   * weighted pick over the room's own furniture and the lounge. A room with
   * nothing to offer produces no outing at all.
   */
  private startOuting(sprite: Sprite, layout: Layout, now: number) {
    const join = this.findJoin(sprite, layout);
    if (join && Math.random() < 0.6) {
      this.travelTo(sprite, layout, join, now);
      return;
    }
    const buddy = this.findBuddy(sprite);
    if (buddy && Math.random() < 0.22) {
      this.startMingle(sprite, buddy, layout, now);
      return;
    }
    const loungeIdx = layout.cells.find((c) => c.kind === 'lounge')?.idx;
    const amb = ambiance();
    const cands = this.places.filter(
      (p) => (p.cellIdx === sprite.cellIdx || p.cellIdx === loungeIdx) && this.usersAt(p) < p.capacity,
    );
    if (!cands.length) {
      sprite.nextWanderAt = now + 60_000; // nothing worth visiting — try later
      return;
    }
    let total = 0;
    const weights = cands.map((p) => {
      // stars are worth looking at after dark
      const night = p.kind === 'window' && amb.darkness > 0.5 ? 3 : 1;
      const d = Math.hypot(p.x - sprite.x, p.y - sprite.y);
      const w = (p.weight * night) / (1 + d / 700);
      total += w;
      return w;
    });
    let roll = Math.random() * total;
    let pick = cands[0];
    for (let i = 0; i < cands.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        pick = cands[i];
        break;
      }
    }
    this.travelTo(sprite, layout, pick, now);
  }

  /** A social place someone is already at (or heading to), with room left —
   *  including the seat beside them on a two-cushion sofa. */
  private findJoin(sprite: Sprite, layout: Layout): Place | null {
    const loungeIdx = layout.cells.find((c) => c.kind === 'lounge')?.idx;
    for (const other of this.sprites.values()) {
      if (other === sprite || !other.place || !other.place.social) continue;
      if (!['wander', 'toLounge', 'pause'].includes(other.mode)) continue;
      const p = other.place;
      if (p.cellIdx !== sprite.cellIdx && p.cellIdx !== loungeIdx) continue;
      if (this.usersAt(p, sprite) < p.capacity) return p;
      // the sibling cushion: same kind, same room, right next to it
      const sibling = this.places.find(
        (q) =>
          q !== p &&
          q.cellIdx === p.cellIdx &&
          q.kind === p.kind &&
          Math.abs(q.x - p.x) < 60 &&
          Math.abs(q.y - p.y) < 24 &&
          this.usersAt(q, sprite) < q.capacity,
      );
      if (sibling) return sibling;
    }
    return null;
  }

  /** An idle colleague at a desk in the same room, not already talking. */
  private findBuddy(sprite: Sprite): Sprite | null {
    for (const other of this.sprites.values()) {
      if (other === sprite || other.cellIdx !== sprite.cellIdx) continue;
      if (other.mode !== 'seated' || other.status !== 'idle' || other.chatWith) continue;
      return other;
    }
    return null;
  }

  private travelTo(sprite: Sprite, layout: Layout, place: Place, now: number) {
    sprite.place = place;
    sprite.glyph = place.glyph;
    sprite.sitting = false;
    const target = { x: place.x, y: place.y };
    if (place.cellIdx === sprite.cellIdx) {
      sprite.mode = 'wander';
      sprite.path = benchDetour(layout, sprite.cellIdx, { x: sprite.x, y: sprite.y }, target);
      return;
    }
    // another room: through the doors if a route exists, else the hallway hop
    sprite.mode = 'toLounge';
    const walked = pathBetween(layout, sprite.cellIdx, place.cellIdx, target, { x: sprite.x, y: sprite.y });
    if (walked) {
      const first = walked[0];
      sprite.path = [...benchDetour(layout, sprite.cellIdx, { x: sprite.x, y: sprite.y }, first), ...walked.slice(1)];
      return;
    }
    const home = layout.cells[sprite.cellIdx];
    const away = layout.cells[place.cellIdx];
    if (!home || !away) {
      sprite.mode = 'seated';
      sprite.place = null;
      sprite.glyph = null;
      return;
    }
    sprite.path = benchDetour(layout, sprite.cellIdx, { x: sprite.x, y: sprite.y }, doorInside(home));
    sprite.teleportTo = doorInside(away);
    sprite.teleportTarget = target;
    sprite.waitUntil = now;
  }

  /** Walk over to a seated colleague for a wordless chat (no parcel). */
  private startMingle(sprite: Sprite, buddy: Sprite, layout: Layout, now: number) {
    const dir = sprite.seat.x <= buddy.seat.x ? -1 : 1;
    sprite.mode = 'visit';
    sprite.mingleWith = buddy.sessionId;
    sprite.place = null;
    sprite.glyph = null;
    sprite.path = benchDetour(layout, sprite.cellIdx, { x: sprite.x, y: sprite.y }, {
      x: buddy.seat.x + dir * 26 * buddy.scale,
      y: buddy.seat.y + 6 * buddy.scale,
    });
    sprite.waitUntil = now;
  }

  /** Two neighbours turning to each other for a moment — no walking at all. */
  private tryBenchChat(sprite: Sprite, now: number) {
    let best: Sprite | null = null;
    for (const other of this.sprites.values()) {
      if (other === sprite || other.cellIdx !== sprite.cellIdx) continue;
      if (other.mode !== 'seated' || other.status !== 'idle' || other.chatWith) continue;
      if (Math.abs(other.seat.x - sprite.seat.x) > 110 * sprite.scale) continue;
      if (!best || Math.abs(other.seat.x - sprite.seat.x) < Math.abs(best.seat.x - sprite.seat.x)) best = other;
    }
    if (!best) {
      sprite.nextChatAt = now + 45_000;
      return;
    }
    this.linkChat(sprite, best, now, 5000 + Math.random() * 4000);
    sprite.nextChatAt = now + CHAT_MIN_MS + Math.random() * CHAT_JITTER_MS;
    best.nextChatAt = sprite.nextChatAt;
  }

  private linkChat(a: Sprite, b: Sprite, now: number, ms: number) {
    a.chatWith = b.sessionId;
    b.chatWith = a.sessionId;
    a.chatUntil = b.chatUntil = now + ms;
    // neither walks off mid-sentence
    if (a.mode === 'pause') a.waitUntil = Math.max(a.waitUntil, a.chatUntil + 400);
    if (b.mode === 'pause') b.waitUntil = Math.max(b.waitUntil, b.chatUntil + 400);
  }

  private endChat(sprite: Sprite) {
    const partner = sprite.chatWith ? this.sprites.get(sprite.chatWith) : null;
    sprite.chatWith = null;
    if (partner && partner.chatWith === sprite.sessionId) partner.chatWith = null;
  }

  /** Head back to the desk, from wherever the outing got to. */
  private goHome(sprite: Sprite, layout: Layout, now: number) {
    this.endChat(sprite);
    const awayCell = sprite.place && sprite.place.cellIdx !== sprite.cellIdx ? sprite.place.cellIdx : null;
    // A drinks run comes back holding the drink — it lands next to the mug
    // already painted on the desk, which is where it was headed all along.
    if (sprite.mode === 'pause' && sprite.place && ['coffee', 'cooler', 'vending'].includes(sprite.place.kind))
      sprite.mug = true;
    sprite.mode = 'return';
    sprite.sitting = false;
    sprite.glyph = null;
    if (awayCell != null) {
      const walked = pathBetween(layout, awayCell, sprite.cellIdx, sprite.seat, { x: sprite.x, y: sprite.y });
      if (walked) sprite.path = walked;
      else {
        const away = layout.cells[awayCell];
        const home = layout.cells[sprite.cellIdx];
        if (away && home) {
          sprite.path = [doorInside(away)];
          sprite.teleportTo = doorInside(home);
          sprite.teleportTarget = sprite.seat;
        } else sprite.path = [sprite.seat];
      }
    } else {
      sprite.path = benchDetour(layout, sprite.cellIdx, { x: sprite.x, y: sprite.y }, sprite.seat);
    }
    sprite.place = null;
    sprite.waitUntil = now;
  }

  private arrive(sprite: Sprite, now: number, layout: Layout) {
    // Hallway hop: fade out at the door, reappear at the destination door.
    if ((sprite.mode === 'toLounge' || sprite.mode === 'return') && sprite.teleportTo) {
      sprite.x = sprite.teleportTo.x;
      sprite.y = sprite.teleportTo.y;
      sprite.alpha = 0;
      const target = sprite.teleportTarget ?? sprite.seat;
      const cellIdx = sprite.mode === 'return' ? sprite.cellIdx : (sprite.place?.cellIdx ?? sprite.cellIdx);
      sprite.path = benchDetour(layout, cellIdx, sprite.teleportTo, target);
      sprite.teleportTo = null;
      sprite.teleportTarget = null;
      sprite.waitUntil = now + 350; // a beat "in the hallway"
      return;
    }
    switch (sprite.mode) {
      case 'enter':
      case 'return':
        sprite.mode = 'seated';
        sprite.alpha = 1;
        sprite.x = sprite.seat.x;
        sprite.y = sprite.seat.y;
        sprite.mug = false; // set down next to the painted one
        break;
      case 'toDoor':
        sprite.mode = 'atDoor';
        break;
      case 'wander':
      case 'toLounge': {
        const p = sprite.place;
        sprite.mode = 'pause';
        if (!p) {
          sprite.waitUntil = now + 3000;
          break;
        }
        // the seat can be taken by the time we get there — stand beside it
        if (this.usersAt(p, sprite) >= p.capacity) {
          sprite.x += 16 * sprite.scale;
          sprite.sitting = false;
        } else {
          sprite.sitting = p.sit;
        }
        sprite.waitUntil = now + p.dwell[0] + Math.random() * (p.dwell[1] - p.dwell[0]);
        // company at a social spot starts a conversation
        if (p.social) {
          for (const other of this.sprites.values()) {
            if (other === sprite || other.mode !== 'pause' || !other.place || other.chatWith) continue;
            if (other.place.cellIdx !== p.cellIdx) continue;
            if (Math.hypot(other.x - sprite.x, other.y - sprite.y) > 64 * sprite.scale) continue;
            this.linkChat(sprite, other, now, 6000 + Math.random() * 3500);
            break;
          }
        }
        break;
      }
      case 'visit': {
        sprite.carrying = false;
        if (sprite.visitLabel && sprite.visitTo && this.sprites.has(sprite.visitTo)) {
          this.bubbles.push({ sessionId: sprite.visitTo, text: sprite.visitLabel, born: now });
          if (this.bubbles.length > 4) this.bubbles.shift();
        }
        sprite.visitLabel = null;
        sprite.visitTo = null;
        if (sprite.mingleWith) {
          // walked over for a chat — if the colleague is still free, talk
          const buddy = this.sprites.get(sprite.mingleWith);
          sprite.mingleWith = null;
          if (buddy && buddy.mode === 'seated' && buddy.status === 'idle' && !buddy.chatWith) {
            this.linkChat(sprite, buddy, now, 6000 + Math.random() * 3500);
            sprite.mode = 'pause';
            sprite.waitUntil = sprite.chatUntil + 400;
            break;
          }
        }
        sprite.mode = 'pause';
        sprite.waitUntil = now + 900 + Math.random() * 500; // a beat at the desk, then home
        break;
      }
      case 'leave':
        this.endChat(sprite);
        this.sprites.delete(sprite.sessionId);
        break;
      default:
        break;
    }
  }

  /**
   * A handoff was routed: the sender stands up, carries the parcel to the
   * receiver's desk, and walks back. Pure theatre — the message already
   * arrived over the wire — but it is the theatre that makes orchestration
   * legible from across the room.
   */
  handoff(fromId: string, toId: string, label: string, now: number) {
    const from = this.sprites.get(fromId);
    const to = this.sprites.get(toId);
    if (!from || !to || fromId === toId) return;
    if (from.mode !== 'seated') return; // busy walking something else
    // Two rooms: the parcel goes through the doorway between them, which is
    // the whole point of drawing a team's lanes as rooms off the project.
    // Anything but a shared wall (a lane in another building, a room that has
    // scrolled out of the plan) has no walkable route, so it stays put.
    let via: P | null = null;
    if (from.cellIdx !== to.cellIdx) {
      via = this.doorwayBetween(from.cellIdx, to.cellIdx);
      if (!via) return;
    }
    this.endChat(from);
    const dir = from.seat.x <= to.seat.x ? -1 : 1;
    from.mode = 'visit';
    from.carrying = true;
    from.visitLabel = label;
    from.visitTo = toId;
    from.mingleWith = null;
    const desk = { x: to.seat.x + dir * 26 * to.scale, y: to.seat.y + 6 * to.scale };
    from.path = via ? [via, desk] : [desk];
    from.waitUntil = now;
  }

  /** The point on the wall two side-by-side rooms share, at the height of the
   *  opening between them. Null when they do not touch. */
  private doorwayBetween(a: number, b: number): P | null {
    const layout = this.lastLayout;
    if (!layout) return null;
    const ca = layout.cells[a];
    const cb = layout.cells[b];
    if (!ca || !cb || ca.row !== cb.row) return null;
    const left = ca.x < cb.x ? ca : cb;
    const right = left === ca ? cb : ca;
    if (Math.abs(left.x + left.w - right.x) > 2) return null; // not neighbours
    if (!left.archRight || !right.archLeft) return null; // a wall, not a door
    const { iY, iH } = interiorOf(left);
    return { x: right.x, y: iY + iH * 0.5 - BODY_H / 2 };
  }

  views(layout: Layout, now: number): { sprites: SpriteView[]; bubbles: BubbleView[] } {
    void layout;
    const sprites: SpriteView[] = [];
    for (const s of this.sprites.values()) {
      const chatting = !!s.chatWith && now <= s.chatUntil;
      sprites.push({
        sessionId: s.sessionId,
        x: s.x,
        y: s.y,
        status: s.status,
        alpha: s.alpha,
        scale: s.scale,
        seated: s.mode === 'seated' || s.sitting,
        walking: s.path.length > 0 && now >= s.waitUntil,
        walkPhase: s.walkPhase,
        attention: (s.mode === 'seated' || s.mode === 'atDoor') && needsPerson(s),
        carrying: s.carrying,
        mug: s.mug,
        chatting,
        glyph: chatting ? null : s.glyph,
      });
    }
    const bubbles: BubbleView[] = [];
    for (const b of this.bubbles) {
      const s = this.sprites.get(b.sessionId);
      if (!s) continue;
      bubbles.push({ x: s.x, y: s.y - 10 * s.scale, text: b.text, age: (now - b.born) / BUBBLE_MS });
    }
    return { sprites, bubbles };
  }

  spriteAt(sx: number, sy: number): string | null {
    for (const s of this.sprites.values()) {
      if (Math.abs(sx - s.x) < 16 * s.scale && sy > s.y - 10 * s.scale && sy < s.y + 32 * s.scale) return s.sessionId;
    }
    return null;
  }

  positionOf(sessionId: string): P | null {
    const s = this.sprites.get(sessionId);
    return s ? { x: s.x, y: s.y } : null;
  }

  // ---- dev hooks (the fixture drives these; nothing in the app calls them) ----

  /** Force an outing right now, optionally to a specific kind of place. */
  debugOuting(sessionId: string, layout: Layout, kind?: string): string | null {
    const sprite = this.sprites.get(sessionId);
    if (!sprite || sprite.mode !== 'seated') return null;
    if (kind) {
      const loungeIdx = layout.cells.find((c) => c.kind === 'lounge')?.idx;
      const p = this.places.find(
        (q) => q.kind === kind && (q.cellIdx === sprite.cellIdx || q.cellIdx === loungeIdx) && this.usersAt(q) < q.capacity,
      );
      if (!p) return null;
      this.travelTo(sprite, layout, p, performance.now());
      return p.kind;
    }
    this.startOuting(sprite, layout, performance.now());
    return sprite.place?.kind ?? (sprite.mingleWith ? 'mingle' : null);
  }

  /** Force a desk-side chat between two seated robots. */
  debugChat(aId: string, bId: string): boolean {
    const a = this.sprites.get(aId);
    const b = this.sprites.get(bId);
    if (!a || !b) return false;
    this.linkChat(a, b, performance.now(), 8000);
    return true;
  }
}

// ---- geometry helpers --------------------------------------------------------

function doorInside(cell: Cell): P {
  return { x: bottomDoorX(cell), y: cell.y + cell.h - WALL_BOT - BODY_H };
}

/**
 * One waypoint around the shared bench when a straight walk would cross it.
 * The zone's entrance is at the front and the seats are behind the desks, so
 * without this every walk cut straight across the bench top — robots strolling
 * over their own monitors. People walk around the end of a desk row; so do
 * these.
 */
function benchDetour(layout: Layout, cellIdx: number, from: P, to: P): P[] {
  const benches = layout.benches.filter((b) => b.cellIdx === cellIdx);
  if (!benches.length) return [to];
  const s = layout.cells[cellIdx]?.scale ?? 1;
  const pts: P[] = [];
  let cur = from;
  // A crowded zone has several bench ROWS; walk around each one the leg
  // would cross, nearest first. The guard is belt — a waypoint at a bench's
  // end can't re-cross that bench.
  for (let guard = 0; guard < 4; guard++) {
    let hit: (typeof benches)[number] | null = null;
    let hitDy = Infinity;
    for (const b of benches) {
      const top = b.deskTop - 26 * s; // the chair band
      const bot = b.deskTop + 36 * s; // past the desk legs
      const curSide = cur.y < top ? -1 : cur.y > bot ? 1 : 0;
      const toSide = to.y < top ? -1 : to.y > bot ? 1 : 0;
      if (curSide === toSide && curSide !== 0) continue; // never enters the band
      const t = (b.deskTop - cur.y) / (to.y - cur.y || 1);
      const crossX = cur.x + (to.x - cur.x) * Math.max(0, Math.min(1, t));
      if (crossX < b.x0 - 6 * s || crossX > b.x0 + b.w + 6 * s) continue; // passes beside it
      const dy = Math.abs(b.deskTop - cur.y);
      if (dy < hitDy) {
        hitDy = dy;
        hit = b;
      }
    }
    if (!hit) break;
    const x0 = hit.x0 - 6 * s;
    const x1 = hit.x0 + hit.w + 6 * s;
    const leftCost = Math.abs(cur.x - x0) + Math.abs(to.x - x0);
    const rightCost = Math.abs(cur.x - x1) + Math.abs(to.x - x1);
    const ex = Math.round(leftCost <= rightCost ? x0 - 10 * s : x1 + 10 * s);
    const wp = { x: ex, y: Math.round(hit.deskTop) };
    pts.push(wp);
    cur = wp;
  }
  pts.push(to);
  return pts;
}

/** BFS over cells: vertical neighbors connect via bottom doors, horizontal only via family archways. */
function pathBetween(layout: Layout, fromIdx: number, toIdx: number, target: P, from: P): P[] | null {
  if (fromIdx === toIdx) return [target];
  const prev = new Map<number, number>();
  const queue = [fromIdx];
  prev.set(fromIdx, -1);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === toIdx) break;
    for (const nb of neighborsOf(layout, cur)) {
      if (!prev.has(nb)) {
        prev.set(nb, cur);
        queue.push(nb);
      }
    }
  }
  if (!prev.has(toIdx)) return null;
  const chain: number[] = [];
  for (let c = toIdx; c !== -1; c = prev.get(c)!) chain.unshift(c);

  const pts: P[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = layout.cells[chain[i]];
    const b = layout.cells[chain[i + 1]];
    if (a.row !== b.row) {
      // vertical: through the UPPER cell's bottom door
      const upper = a.row < b.row ? a : b;
      const doorX = bottomDoorX(upper);
      const boundary = upper.y + upper.h;
      const above = { x: doorX, y: boundary - WALL_BOT - BODY_H };
      const below = { x: doorX, y: boundary + WALL_TOP + WALL_FACE + 12 };
      if (a.row < b.row) pts.push(above, below);
      else pts.push(below, above);
    } else {
      // horizontal: through the family archway in the shared wall
      const left = a.x < b.x ? a : b;
      const boundaryX = left.x + left.w;
      const { iY, iH } = interiorOf(left);
      const archY = iY + iH * 0.5;
      if (a.x < b.x) {
        pts.push({ x: boundaryX - WALL_SIDE - 10, y: archY });
        pts.push({ x: boundaryX + WALL_SIDE + 10, y: archY });
      } else {
        pts.push({ x: boundaryX + WALL_SIDE + 10, y: archY });
        pts.push({ x: boundaryX - WALL_SIDE - 10, y: archY });
      }
    }
  }
  pts.push(target);
  if (pts.length > 1 && Math.hypot(pts[0].x - from.x, pts[0].y - from.y) < 4) pts.shift();
  return pts;
}

function neighborsOf(layout: Layout, idx: number): number[] {
  const cell = layout.cells[idx];
  const res: number[] = [];
  const down = cellBelow(layout, cell);
  if (down) res.push(down.idx);
  for (const up of cellsAbove(layout, cell)) res.push(up.idx);
  if (cell.archRight) res.push(idx + 1);
  if (cell.archLeft) res.push(idx - 1);
  return res;
}

// NOTE: no wall fade any more. Robots used to dim while crossing a wall band
// ("through the doorway") — over waist-high glass there is nothing to phase
// through, and the crossings line up with the gaps drawZone leaves in the
// panes, so a walking robot stays fully visible the whole way.
