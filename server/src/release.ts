/**
 * Is there a newer airoom, and is there anything worth telling people?
 *
 * The app has no auto-updater, so until now the only way to learn that a
 * release existed was to visit airoom.dev — and re-type an email to download
 * it. This asks quietly instead: a small public manifest, airoom.dev/release.json,
 * lists the current version, where to get it and, occasionally, a short
 * announcement. It is fetched shortly after boot and then every few hours.
 *
 * The request carries nothing about this machine — no key, no device id, no
 * version in the query. It is the GET a browser would make for the same file.
 * Failures are silent and keep the last good answer; a manifest that does not
 * parse is ignored whole rather than half-applied, so the strip at the top of
 * the window never leads nowhere.
 *
 * AIROOM_NO_UPDATE_CHECK=1 turns it off entirely. AIROOM_RELEASE_URL points it
 * elsewhere (tests). AIROOM_VERSION is what the shell says this build is; unset
 * in dev, where nothing is ever "out of date".
 */
import type { ReleaseInfo } from '../../shared/types';

const DEFAULT_URL = 'https://airoom.dev/release.json';
const EVERY = 6 * 60 * 60_000;
const FIRST_DELAY = 15_000;
const TIMEOUT = 8_000;
const MAX_TEXT = 200;

// Read at call time, not import time — tests point these somewhere else after
// importing this module (the same lesson the lanes directory taught).
const manifestUrl = () => process.env.AIROOM_RELEASE_URL?.trim() || DEFAULT_URL;
const disabled = () => process.env.AIROOM_NO_UPDATE_CHECK === '1';
const currentVersion = () => process.env.AIROOM_VERSION?.trim() || null;

export interface Manifest {
  version: string;
  url: string;
  notes?: string;
  /** The Windows installer, when a release has one. */
  windowsUrl?: string;
  message?: { id: string; text: string; url?: string; until?: string };
}

let latest: Manifest | null = null;
let checkedAt: string | null = null;
let started = false;

/**
 * "0.1.15" against "0.1.9": numeric per part, so 15 beats 9. Missing parts
 * count as 0 (1.0 equals 1.0.0), a leading v is ignored, and anything after a
 * dash or plus is dropped — releases here are plain x.y.z.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((p) => parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const VERSION = /^v?\d+(\.\d+){1,3}$/;
const isHttps = (s: unknown): s is string => typeof s === 'string' && s.length <= 500 && /^https:\/\/\S+$/i.test(s);

/**
 * The manifest as served, checked field by field. Anything that is not a
 * manifest we would act on — a bad version, a non-https link — rejects the
 * whole thing. An announcement is optional and is dropped on its own if it is
 * malformed; its text is squashed to one line and capped.
 */
export function parseManifest(raw: unknown): Manifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.version !== 'string' || !VERSION.test(m.version.trim())) return null;
  if (!isHttps(m.url)) return null;
  const out: Manifest = { version: m.version.trim().replace(/^v/i, ''), url: m.url };
  if (isHttps(m.notes)) out.notes = m.notes;
  const win = m.windows;
  if (win && typeof win === 'object' && isHttps((win as Record<string, unknown>).url))
    out.windowsUrl = (win as Record<string, unknown>).url as string;
  if (m.message && typeof m.message === 'object') {
    const x = m.message as Record<string, unknown>;
    if (typeof x.id === 'string' && x.id.trim() && typeof x.text === 'string' && x.text.trim()) {
      const text = x.text.replace(/\s+/g, ' ').trim();
      out.message = {
        id: x.id.trim().slice(0, 64),
        text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1).trimEnd()}…` : text,
      };
      if (isHttps(x.url)) out.message.url = x.url;
      if (typeof x.until === 'string' && !Number.isNaN(Date.parse(x.until))) out.message.until = x.until;
    }
  }
  return out;
}

/** Fetch the manifest once. True when a fresh, valid manifest was taken. */
export async function checkNow(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<boolean> {
  if (disabled()) return false;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetchImpl(manifestUrl(), { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return false;
    const m = parseManifest(await res.json());
    if (!m) return false;
    latest = m;
    checkedAt = new Date(now()).toISOString();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * What the UI is told. Computed on every call, so an announcement with an
 * `until` disappears on time without another fetch.
 */
export function releaseState(now: () => number = Date.now): ReleaseInfo {
  const current = currentVersion();
  const l = latest;
  const m = l?.message;
  const message =
    m && !(m.until && Date.parse(m.until) < now()) ? { id: m.id, text: m.text, ...(m.url ? { url: m.url } : {}) } : null;
  return {
    current,
    latest: l
      ? { version: l.version, url: l.url, ...(l.notes ? { notes: l.notes } : {}), ...(l.windowsUrl ? { windowsUrl: l.windowsUrl } : {}) }
      : null,
    updateAvailable: Boolean(current && l && compareVersions(l.version, current) > 0),
    message,
    checkedAt,
  };
}

/**
 * The quiet schedule: once shortly after boot, then every few hours. Neither
 * timer keeps the process alive on its own.
 */
export function startReleaseChecks(): void {
  if (started || disabled()) return;
  started = true;
  const first = setTimeout(() => {
    void checkNow();
    setInterval(() => void checkNow(), EVERY).unref();
  }, FIRST_DELAY);
  first.unref();
}

/** Forget everything — tests only. */
export function resetReleaseForTests(): void {
  latest = null;
  checkedAt = null;
  started = false;
}
