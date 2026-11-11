/**
 * Where is the user's Claude Code?
 *
 * A packaged Mac app inherits launchd's minimal PATH, so `which claude` from
 * inside airoom misses every real install. And "I have Claude Code" means
 * many different things: the native installer, Homebrew, npm under whichever
 * version manager, the copy the Claude desktop app carries, the one an
 * editor extension carries. A user who has it via the desktop app alone was
 * told by 0.1.12 that the SDK's native binary was missing — the least
 * helpful sentence in the product. So: every known location, newest first
 * where versions live side by side; the user's own login shell asked once;
 * and a saved path for anything else.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type BinSource = 'env' | 'saved' | 'found' | 'shell';

export const SAVED_BIN_PATH = path.join(os.homedir(), '.airoom', 'claude-bin');

export interface FsLike {
  exists: (p: string) => boolean;
  list: (dir: string) => string[];
}
const realFs: FsLike = {
  exists: (p) => existsSync(p),
  list: (d) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  },
};

/** Every place a Claude Code binary lands, in the order tried. A single `*`
 *  segment (or segment prefix) expands newest-first. Windows has its own
 *  list: the native installer's exe, npm's global install (the cli.js behind
 *  the .cmd shim is what can actually be run without a shell), and the copies
 *  editor extensions carry. */
export function candidatePatterns(home = os.homedir(), platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    const w = (...p: string[]) => path.win32.join(home, ...p);
    return [
      w('.local', 'bin', 'claude.exe'), // native installer and winget
      w('AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), // npm -g
      w('AppData', 'Roaming', 'npm', 'claude.cmd'),
      w('.vscode', 'extensions', 'anthropic.claude-code-*', 'resources', 'native-binary', 'claude.exe'),
      w('.vscode-insiders', 'extensions', 'anthropic.claude-code-*', 'resources', 'native-binary', 'claude.exe'),
      w('.cursor', 'extensions', 'anthropic.claude-code-*', 'resources', 'native-binary', 'claude.exe'),
      w('.windsurf', 'extensions', 'anthropic.claude-code-*', 'resources', 'native-binary', 'claude.exe'),
    ];
  }
  // posix on purpose: the Mac list must read the same on a Windows runner.
  const j = (...p: string[]) => path.posix.join(home, ...p);
  return [
    j('.local', 'bin', 'claude'), // native installer (curl | bash)
    j('.claude', 'local', 'claude'), // `claude migrate-installer`
    j('.claude', 'local', 'node_modules', '.bin', 'claude'),
    '/opt/homebrew/bin/claude', // npm -g or brew, Apple Silicon
    '/usr/local/bin/claude', // npm -g, Intel
    j('.npm-global', 'bin', 'claude'),
    j('.volta', 'bin', 'claude'),
    j('.bun', 'bin', 'claude'),
    j('Library', 'pnpm', 'claude'),
    j('.asdf', 'shims', 'claude'),
    j('.nvm', 'versions', 'node', '*', 'bin', 'claude'),
    j('Library', 'Application Support', 'fnm', 'node-versions', '*', 'installation', 'bin', 'claude'),
    j('.local', 'share', 'fnm', 'node-versions', '*', 'installation', 'bin', 'claude'),
    '/usr/local/n/versions/node/*/bin/claude',
    // the Claude desktop app carries its own Claude Code
    j('Library', 'Application Support', 'Claude', 'claude-code', '*', 'claude.app', 'Contents', 'MacOS', 'claude'),
    j('Library', 'Application Support', 'Claude', 'claude-code', '*', 'claude'),
    // editor extensions carry one too
    j('.vscode', 'extensions', 'anthropic.claude-code-*', 'resources', 'native-binary', 'claude'),
    j('.vscode-insiders', 'extensions', 'anthropic.claude-code-*', 'resources', 'native-binary', 'claude'),
    j('.cursor', 'extensions', 'anthropic.claude-code-*', 'resources', 'native-binary', 'claude'),
    j('.windsurf', 'extensions', 'anthropic.claude-code-*', 'resources', 'native-binary', 'claude'),
  ];
}

/** Expand a pattern with at most one `*` segment; existing hits, newest first.
 *  The pattern's own separator is used throughout, so a Mac pattern expands
 *  the same way on a Windows runner and a Windows one on a Mac. */
export function expandPattern(pattern: string, fs: FsLike = realFs): string[] {
  const sep = pattern.includes('\\') ? '\\' : '/';
  const segs = pattern.split(sep);
  const i = segs.findIndex((s) => s.includes('*'));
  if (i < 0) return fs.exists(pattern) ? [pattern] : [];
  const base = segs.slice(0, i).join(sep) || sep;
  const [prefix, suffix] = segs[i].split('*');
  const rest = segs.slice(i + 1);
  const names = fs
    .list(base)
    .filter((n) => n.startsWith(prefix) && n.endsWith(suffix ?? ''))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); // newest version first
  return names.map((n) => [base, n, ...rest].join(sep)).filter((p) => fs.exists(p));
}

export function readSavedBin(): string | null {
  try {
    const p = readFileSync(SAVED_BIN_PATH, 'utf8').trim();
    return p || null;
  } catch {
    return null;
  }
}

/** Pick the path out of `command -v claude` from an interactive shell (which
 *  may also print rc-file noise or an alias line), or out of `where claude` on
 *  Windows, which prints one match per line in PATH order with the first the
 *  one a terminal would run. */
export function pickPathFromShellOutput(out: string, exists: (p: string) => boolean = existsSync): string | null {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/') || /^[A-Za-z]:[\\/]/.test(l));
  const windows = lines.some((l) => /^[A-Za-z]:/.test(l));
  // `where` lists PATH order (first wins); a Unix shell's last line is the answer.
  const ordered = windows ? lines : [...lines].reverse();
  return ordered.find((l) => exists(l)) ?? null;
}

/**
 * The runnable file behind an npm shim. `claude.cmd` cannot be spawned
 * without a shell — and a shell plus a prompt as an argument is an injection
 * waiting to happen — but the cli.js it wraps runs fine under node.
 */
export function npmCliBeside(shim: string, fs: FsLike = realFs): string | null {
  if (!/\.cmd$/i.test(shim)) return null;
  const dir = path.win32.dirname(shim);
  const cli = path.win32.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  return fs.exists(cli) ? cli : null;
}

let shellHit: string | null = null;
let shellProbedAt = 0;
let shellProbe: Promise<string | null> | null = null;

/** Ask the user's own login shell once — it knows about installs that live
 *  only on their PATH. Cheap, cached, never blocks a send. */
export function probeShell(): Promise<string | null> {
  if (shellProbe) return shellProbe;
  shellProbedAt = Date.now();
  // Windows has no login shell to ask, but `where` walks PATH the same way a
  // terminal would.
  const win = process.platform === 'win32';
  const shell = win ? 'cmd.exe' : process.env.SHELL || '/bin/zsh';
  const args = win ? ['/d', '/c', 'where', 'claude'] : ['-ilc', 'command -v claude'];
  shellProbe = new Promise((resolve) => {
    execFile(
      shell,
      args,
      { timeout: 6000, env: { ...process.env, TERM: 'dumb' } },
      (_err, stdout) => {
        shellProbe = null;
        const hit = pickPathFromShellOutput(String(stdout ?? ''));
        if (hit !== shellHit) cache = null; // let the next lookup see it
        shellHit = hit;
        resolve(hit);
      },
    );
  });
  return shellProbe;
}

export function findClaudeBinSync(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  fs: FsLike = realFs,
  saved: string | null = readSavedBin(),
  shell: string | null = shellHit,
  platform: NodeJS.Platform = process.platform,
): { bin: string; source: BinSource } | null {
  if (env.AIROOM_CLAUDE_BIN && fs.exists(env.AIROOM_CLAUDE_BIN)) return { bin: env.AIROOM_CLAUDE_BIN, source: 'env' };
  if (saved && fs.exists(saved)) return { bin: saved, source: 'saved' };
  for (const pat of candidatePatterns(home, platform)) {
    const hit = expandPattern(pat, fs)[0];
    if (hit) return { bin: hit, source: 'found' };
  }
  if (shell && fs.exists(shell)) return { bin: shell, source: 'shell' };
  return null;
}

// Re-discovered lazily (cached 10s) so the first-run "waiting for install…"
// card resolves without restarting the server.
let cache: { at: number; hit: { bin: string; source: BinSource } | null } | null = null;
export function claudeBinInfo(): { bin: string; source: BinSource } | null {
  if (!cache || Date.now() - cache.at > 10_000) {
    const hit = findClaudeBinSync();
    if (hit?.bin !== cache?.hit?.bin) {
      if (hit) console.log(`[engine] using claude binary: ${hit.bin} (${hit.source})`);
      else console.log('[engine] no claude binary found yet — asking the login shell');
    }
    cache = { at: Date.now(), hit };
    // Nothing on disk in the known places: ask the shell, at most once a minute.
    if (!hit && Date.now() - shellProbedAt > 60_000) void probeShell();
  }
  return cache.hit;
}
export function claudeBin(): string | undefined {
  return claudeBinInfo()?.bin;
}

/** For /health and the connect card: what was found, how, and where airoom looked. */
export function claudeBinDiagnostics(): { bin: string | null; source: BinSource | null; searched: string[] } {
  const info = claudeBinInfo();
  return { bin: info?.bin ?? null, source: info?.source ?? null, searched: candidatePatterns() };
}

/** Save (or clear) a user-chosen path. Cleared with null. */
export function saveClaudeBin(p: string | null): void {
  cache = null;
  if (!p) {
    try {
      rmSync(SAVED_BIN_PATH);
    } catch {
      /* nothing saved */
    }
    return;
  }
  mkdirSync(path.dirname(SAVED_BIN_PATH), { recursive: true });
  writeFileSync(SAVED_BIN_PATH, p + '\n', { mode: 0o600 });
}

/** Is this really a runnable Claude Code? Exists, executable, answers --version. */
export function validateClaudeBin(p: string): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    if (!path.isAbsolute(p)) return resolve({ ok: false, error: 'Paste the full path — it starts with a slash.' });
    try {
      if (!statSync(p).isFile()) return resolve({ ok: false, error: `${p} is not a file.` });
      accessSync(p, constants.X_OK);
    } catch {
      return resolve({ ok: false, error: `Nothing runnable at ${p}. In a terminal, \`which claude\` prints the right path.` });
    }
    execFile(p, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      const out = String(stdout ?? '').trim();
      if (err || !out) return resolve({ ok: false, error: `${p} did not answer --version like Claude Code does.` });
      resolve({ ok: true, version: out.split('\n')[0] });
    });
  });
}

/** The sentence a user reads when nothing was found — every place named. */
export const NOT_FOUND_MESSAGE =
  process.platform === 'win32'
    ? "airoom can't find Claude Code on this computer. It looked where the native installer, npm and editor extensions put it, and asked `where claude`. If it is installed somewhere else, run `where claude` in a terminal and paste the path into the connect card — or save it to %USERPROFILE%\\.airoom\\claude-bin."
    : "airoom can't find Claude Code on this Mac. It looked where the native installer, Homebrew, npm (including nvm, fnm, volta, bun and pnpm), the Claude desktop app and editor extensions put it, and asked your login shell. If it is installed somewhere else, run `which claude` in a terminal and paste the path into the connect card — or save it to ~/.airoom/claude-bin.";

/** Directories a terminal reliably has on PATH; a binary elsewhere (the
 *  desktop app's copy, an extension's, a saved path) must be run by full path. */
const PATH_DIRS = (home: string, platform: NodeJS.Platform) =>
  platform === 'win32'
    ? [path.win32.join(home, '.local', 'bin'), path.win32.join(home, 'AppData', 'Roaming', 'npm')]
    : [path.posix.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];

/** The command the connect card tells the user to run. `claude setup-token`
 *  when their terminal will find `claude`; otherwise the full path, quoted. */
export function setupTokenCommand(
  bin: string | null,
  source: BinSource | null,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const dirname = platform === 'win32' ? path.win32.dirname : path.posix.dirname;
  const dirs = PATH_DIRS(home, platform).map((d) => d.toLowerCase());
  if (!bin || source === 'shell' || dirs.includes(dirname(bin).toLowerCase())) return 'claude setup-token';
  return `"${bin}" setup-token`;
}
