/**
 * What to call the machine airoom runs on, in the words its owner would use.
 *
 * The desktop shell tells the page its platform through the preload bridge;
 * in a plain browser (the dev rig, the landing demo) we fall back to what the
 * browser says. "this Mac" on a Windows PC reads as a bug, because it is one.
 */
const native = (window as unknown as { airoomNative?: { platform?: string } }).airoomNative;
const fromBrowser =
  typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent)
    ? 'win32'
    : typeof navigator !== 'undefined' && /Linux/i.test(navigator.platform || navigator.userAgent)
      ? 'linux'
      : 'darwin';

export const platform = native?.platform ?? fromBrowser;
export const isWindows = platform === 'win32';

/** "Mac", "PC" or "computer" — the noun for the machine airoom is running on. */
export const machine = isWindows ? 'PC' : platform === 'linux' ? 'computer' : 'Mac';
export const thisMachine = `this ${machine}`;
export const yourMachine = `your ${machine}`;

/** Where the API key lives, written the way that platform's users write paths. */
export const tokenPath = isWindows ? '%USERPROFILE%\\.airoom\\token' : '~/.airoom/token';
