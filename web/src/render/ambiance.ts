/**
 * Time-of-day ambiance: the world follows your real local clock. Windows show
 * dawn/day/dusk/night skies, rooms dim as it gets dark, and lamps carve warm
 * light pools out of the gloom.
 *
 * Testing tip: `localStorage.setItem('airoom.hour', '23')` freezes the clock
 * at any hour (fractional ok, e.g. '6.5'); remove the key to go live again.
 */

export type DayPhase = 'dawn' | 'day' | 'dusk' | 'night';

export interface Ambiance {
  phase: DayPhase;
  /** 0 = full daylight → 1 = deep night. Drives room dimming + lamp strength. */
  darkness: number;
  skyTop: string;
  skyBot: string;
  /** 0..1 — how visible the stars are through windows. */
  stars: number;
}

// Sky keyframes across the day: [hour, skyTop, skyBot, darkness].
const KEYS: [number, string, string, number][] = [
  [0, '#0a1026', '#16204a', 1],
  [4.5, '#0a1026', '#16204a', 1],
  [6.5, '#3a3f78', '#c96a5a', 0.55], // sunrise
  [8.5, '#5aa7d8', '#a8d8f0', 0],
  [16.5, '#5aa7d8', '#a8d8f0', 0],
  [18.5, '#7a5a9a', '#e8945a', 0.45], // sunset
  [20.5, '#141a3a', '#1c2650', 0.9],
  [24, '#0a1026', '#16204a', 1],
];

/** Blend two hex colors — used for keyframe interpolation and sky bands. */
export function hexLerp(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) => {
    const va = (pa >> sh) & 0xff;
    const vb = (pb >> sh) & 0xff;
    return Math.round(va + (vb - va) * t);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

function hourNow(): number {
  // Dev/preview override — lets you see any time of day on demand.
  try {
    const o = localStorage.getItem('airoom.hour');
    if (o) {
      const f = parseFloat(o);
      if (Number.isFinite(f)) return ((f % 24) + 24) % 24;
    }
  } catch {
    /* storage unavailable — use the real clock */
  }
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

let cached: Ambiance | null = null;
let cachedAt = 0;

/** Current ambiance, cached for a second (called per room per frame). */
export function ambiance(): Ambiance {
  const now = Date.now();
  if (cached && now - cachedAt < 1000) return cached;

  const h = hourNow();
  let i = 0;
  while (i < KEYS.length - 2 && h >= KEYS[i + 1][0]) i++;
  const [h0, top0, bot0, d0] = KEYS[i];
  const [h1, top1, bot1, d1] = KEYS[i + 1];
  const t = Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));

  const darkness = d0 + (d1 - d0) * t;
  const phase: DayPhase =
    h >= 4.5 && h < 8.5 ? 'dawn' : h < 16.5 && h >= 8.5 ? 'day' : h >= 16.5 && h < 20.5 ? 'dusk' : 'night';

  cached = {
    phase,
    darkness,
    skyTop: hexLerp(top0, top1, t),
    skyBot: hexLerp(bot0, bot1, t),
    stars: Math.min(1, Math.max(0, (darkness - 0.5) / 0.5)),
  };
  cachedAt = now;
  return cached;
}
