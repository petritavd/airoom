/**
 * Per-room customization, persisted locally (rooms are a view of the user's
 * own machine, so localStorage is the right home for now — a future
 * multi-machine hub would move this behind the DataSource seam).
 */
/** One placed decoration. Coordinates are FRACTIONS of the room interior
 *  (0..1), so layouts survive the building re-flowing as the fleet changes. */
import type { PermissionMode, TeamAutonomy } from '@shared/types';

export interface DecorItem {
  item: string; // catalog key (see render/decor.ts)
  fx: number;
  fy: number;
  v?: number; // variant, reserved
}

export type FloorMat = 'checker' | 'wood' | 'tile' | 'carpet' | 'stone' | 'grass';

export interface RoomConfig {
  theme?: string; // THEMES id
  logo?: string; // data URL, downscaled on upload
  name?: string; // custom display name (falls back to the folder name)
  floor?: FloorMat; // floor material (default: checker)
  decor?: DecorItem[]; // user-placed furniture/objects
  notes?: string; // whiteboard sticky notes, one per line
  /** Default autonomy for teams hired in this room (the hire form's preset). */
  teamAutonomy?: TeamAutonomy;
  teamRoundCap?: number;
  /** Permissions and model every member of a team hired here will run with. */
  teamMode?: PermissionMode;
  teamModel?: string;
}

const KEY = 'airoom.rooms.v1';
const LEGACY_THEMES = 'airoom.themes.v1'; // theme-only store from earlier builds

export type RoomConfigs = Record<string, RoomConfig>;

export function loadRoomConfigs(): RoomConfigs {
  let cfgs: RoomConfigs = {};
  try {
    cfgs = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    cfgs = {};
  }
  // one-time migration of the old themes-only store
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_THEMES) || '{}');
    let changed = false;
    for (const [roomId, theme] of Object.entries(legacy)) {
      if (typeof theme === 'string' && !cfgs[roomId]?.theme) {
        cfgs[roomId] = { ...cfgs[roomId], theme };
        changed = true;
      }
    }
    if (changed) saveRoomConfigs(cfgs);
  } catch {
    /* nothing to migrate */
  }
  return cfgs;
}

export function saveRoomConfigs(cfgs: RoomConfigs): string | null {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfgs));
    return null;
  } catch {
    return 'Could not save — browser storage is full (try a smaller logo).';
  }
}

/** Split configs into the flat maps the renderer wants. */
export function deriveMaps(cfgs: RoomConfigs) {
  const themes: Record<string, string> = {};
  const logos: Record<string, string> = {};
  const names: Record<string, string> = {};
  const floors: Record<string, FloorMat> = {};
  const decor: Record<string, DecorItem[]> = {};
  const notes: Record<string, string[]> = {};
  for (const [id, c] of Object.entries(cfgs)) {
    if (c?.theme) themes[id] = c.theme;
    if (c?.logo) logos[id] = c.logo;
    if (c?.name?.trim()) names[id] = c.name.trim();
    if (c?.floor) floors[id] = c.floor;
    // An EMPTY array is meaningful: it means "I cleared this room", which is
    // different from "I never touched it" (the latter gets auto-furnished).
    // Collapsing the two made a cleared room refill itself.
    if (c?.decor) decor[id] = c.decor;
    if (c?.notes?.trim()) {
      const lines = c.notes
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 6); // the whiteboard fits six stickies
      if (lines.length) notes[id] = lines;
    }
  }
  return { themes, logos, names, floors, decor, notes };
}

/** Read an image file and downscale it to a compact PNG data URL. */
export function fileToLogo(file: File, max = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image'));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas unavailable'));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
