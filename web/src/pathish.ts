/**
 * The two things the UI ever needs to know about a path, for either
 * separator. Room ids are folders from the user's machine — `/Users/p/proj`
 * on a Mac, `C:\Users\p\proj` on Windows — and they reach the UI as opaque
 * strings. Nothing here may split on '/' by hand; that is how a Windows room
 * got a one-letter name.
 */

/** The last folder in a path: `proj` for both `/x/proj/` and `C:\x\proj`. */
export function basename(p: string): string {
  const parts = p.trim().replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** `/x`, `C:\x`, `C:/x` and `\\server\share` are absolute; `x/y` is not. */
export function isAbsolutePath(p: string): boolean {
  const t = p.trim();
  return t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t) || t.startsWith('\\\\');
}
