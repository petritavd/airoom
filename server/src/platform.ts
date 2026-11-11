/**
 * The one place that knows a path can start with `C:\`.
 *
 * airoom grew up on a Mac, where "absolute" meant "starts with a slash" and
 * the last folder in a path was whatever followed the last one. On Windows a
 * room lives at `C:\Users\petrit\proj`, a transcript's `cwd` says so, and the
 * folder picker hands the server the same string. Everything that used to
 * split on `/` or test for a leading `/` goes through here instead, so there
 * is exactly one file to read when a path looks wrong on either platform.
 *
 * Node's `path` module is deliberately not used for the separator-agnostic
 * helpers: on a Mac `path.basename('C:\\x\\y')` is the whole string, and the
 * tests for this file run on both platforms with the same expectations.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

/** Absolute on either platform: `/x`, `C:\x`, `C:/x` or `\\server\share`. */
export function isAbsolutePath(p: string): boolean {
  const t = p.trim();
  if (!t) return false;
  return path.posix.isAbsolute(t) || path.win32.isAbsolute(t);
}

/** The last folder of a path, whichever separator it uses. `C:\` is `C:`. */
export function basename(p: string): string {
  const parts = segments(p);
  return parts[parts.length - 1] || p;
}

/** Every folder in a path, drive letter included: `C:\a\b` → `['C:', 'a', 'b']`. */
export function segments(p: string): string[] {
  return p
    .trim()
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean);
}

/**
 * A path as airoom stores it: trimmed, no trailing separator — except that a
 * root keeps its separator, because `C:` on its own means the drive's current
 * directory to Windows, not the drive.
 */
export function normalizePath(p: string): string {
  const t = p.trim();
  const stripped = t.replace(/[\\/]+$/, '');
  if (stripped === '') return t.startsWith('\\') ? '\\' : '/';
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`;
  return stripped;
}

/** The parent folder, or null at a root. Works for either separator. */
export function parentPath(p: string): string | null {
  const n = normalizePath(p);
  const parent = path.dirname(n);
  return parent === n ? null : parent;
}

/**
 * What the folder picker starts from when asked for the very top: the root
 * on Unix, and every drive that exists on Windows (`C:\`, `D:\`, …).
 */
export function listRoots(exists: (p: string) => boolean = existsSync): string[] {
  if (!isWindows) return ['/'];
  const roots: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`;
    if (exists(d)) roots.push(d);
  }
  return roots.length ? roots : ['C:\\'];
}

export function homeDir(): string {
  return os.homedir();
}
