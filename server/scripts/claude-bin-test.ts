/**
 * Finding the user's Claude Code — the pure parts, pinned: the search order,
 * newest-first expansion of versioned locations, and reading a shell's answer.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { candidatePatterns, expandPattern, findClaudeBinSync, npmCliBeside, pickPathFromShellOutput, setupTokenCommand, type FsLike } from '../src/agent/claudeBin';

let passed = 0;
const failures: [string, Error][] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push([name, err as Error]);
    console.log(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}
const HOME = '/Users/u';
const fake = (present: string[], dirs: Record<string, string[]> = {}): FsLike => ({
  exists: (p) => present.includes(p),
  list: (d) => dirs[d] ?? [],
});

console.log('\nfinding claude');

test("the Claude desktop app's bundled binary is found, newest version first", () => {
  const dir = path.posix.join(HOME, 'Library/Application Support/Claude/claude-code');
  const fs = fake(
    [path.posix.join(dir, '2.1.240/claude.app/Contents/MacOS/claude'), path.posix.join(dir, '2.1.255/claude.app/Contents/MacOS/claude')],
    { [dir]: ['2.1.240', '2.1.255', 'other'] },
  );
  const hit = findClaudeBinSync({}, HOME, fs, null, null, 'darwin');
  assert.equal(hit?.bin, path.posix.join(dir, '2.1.255/claude.app/Contents/MacOS/claude'));
  assert.equal(hit?.source, 'found');
});

test('an editor extension binary is found through its versioned folder name', () => {
  const ext = path.posix.join(HOME, '.vscode/extensions');
  const fs = fake([path.posix.join(ext, 'anthropic.claude-code-2.1.252-darwin-arm64/resources/native-binary/claude')], {
    [ext]: ['ms-python.python-2024', 'anthropic.claude-code-2.1.252-darwin-arm64'],
  });
  assert.equal(findClaudeBinSync({}, HOME, fs, null, null, 'darwin')?.bin, path.posix.join(ext, 'anthropic.claude-code-2.1.252-darwin-arm64/resources/native-binary/claude'));
});

test('a plain install wins over the desktop copy, and the env override wins over everything', () => {
  const dir = path.posix.join(HOME, 'Library/Application Support/Claude/claude-code');
  const fs = fake([path.posix.join(HOME, '.local/bin/claude'), path.posix.join(dir, '2.1.255/claude')], { [dir]: ['2.1.255'] });
  assert.equal(findClaudeBinSync({}, HOME, fs, null, null, 'darwin')?.bin, path.posix.join(HOME, '.local/bin/claude'));
  assert.equal(findClaudeBinSync({ AIROOM_CLAUDE_BIN: '/x/claude' }, HOME, fake(['/x/claude']), null, null, 'darwin')?.source, 'env');
  assert.equal(findClaudeBinSync({ AIROOM_CLAUDE_BIN: '/stale/claude' }, HOME, fs, null, null, 'darwin')?.bin, path.posix.join(HOME, '.local/bin/claude'), 'a stale env path must not win');
});

test('a saved path is used when it still exists, ignored when it is gone', () => {
  const fs = fake(['/opt/homebrew/bin/claude', '/somewhere/claude']);
  assert.deepEqual(findClaudeBinSync({}, HOME, fs, '/somewhere/claude', null, 'darwin'), { bin: '/somewhere/claude', source: 'saved' });
  assert.equal(findClaudeBinSync({}, HOME, fs, '/gone/claude', null, 'darwin')?.bin, '/opt/homebrew/bin/claude');
});

test("the login shell's answer is the last resort, and only if it exists", () => {
  assert.deepEqual(findClaudeBinSync({}, HOME, fake(['/custom/claude']), null, '/custom/claude', 'darwin'), { bin: '/custom/claude', source: 'shell' });
  assert.equal(findClaudeBinSync({}, HOME, fake([]), null, '/custom/claude', 'darwin'), null);
});

test('shell output may carry rc noise and alias lines; the real path is picked', () => {
  const out = 'Welcome back!\nclaude: aliased to claude --dangerously\n/Users/u/.local/bin/claude\n';
  assert.equal(pickPathFromShellOutput(out, (p) => p === '/Users/u/.local/bin/claude'), '/Users/u/.local/bin/claude');
  assert.equal(pickPathFromShellOutput('claude not found\n', () => true), null);
});

test('every pattern is absolute and the native installer is tried first', () => {
  const pats = candidatePatterns(HOME, 'darwin');
  assert.ok(pats.every((p) => p.startsWith('/')));
  assert.equal(pats[0], path.posix.join(HOME, '.local/bin/claude'));
  assert.deepEqual(expandPattern('/nope/claude', fake([])), []);
});

console.log('\nthe command the connect card shows');

test('a PATH install or a shell-found binary keeps the short command', () => {
  assert.equal(setupTokenCommand(path.posix.join(HOME, '.local/bin/claude'), 'found', HOME, 'darwin'), 'claude setup-token');
  assert.equal(setupTokenCommand('/opt/homebrew/bin/claude', 'found', HOME, 'darwin'), 'claude setup-token');
  assert.equal(setupTokenCommand('/custom/claude', 'shell', HOME, 'darwin'), 'claude setup-token');
  assert.equal(setupTokenCommand(null, null, HOME, 'darwin'), 'claude setup-token');
});

test("the desktop app's or an extension's copy is run by its full, quoted path", () => {
  const d = path.posix.join(HOME, 'Library/Application Support/Claude/claude-code/2.1.255/claude.app/Contents/MacOS/claude');
  assert.equal(setupTokenCommand(d, 'found', HOME, 'darwin'), `"${d}" setup-token`);
  assert.equal(setupTokenCommand('/somewhere/claude', 'saved', HOME, 'darwin'), '"/somewhere/claude" setup-token');
});

console.log('\nthe same discovery on Windows');

const HOME_WIN = 'C:\\Users\\u';

test('Windows has its own list: the native exe first, then npm, then editor copies — no Unix paths', () => {
  const pats = candidatePatterns(HOME_WIN, 'win32');
  assert.equal(pats[0], 'C:\\Users\\u\\.local\\bin\\claude.exe');
  assert.ok(pats.some((p) => p.endsWith('\\@anthropic-ai\\claude-code\\cli.js')), 'npm global cli.js');
  assert.ok(pats.some((p) => p.includes('anthropic.claude-code-*') && p.endsWith('claude.exe')), 'editor extension');
  assert.ok(!pats.some((p) => p.startsWith('/')), 'nothing Unix-shaped on Windows');
  assert.ok(!candidatePatterns(HOME, 'darwin').some((p) => p.endsWith('.exe')), 'and nothing Windows-shaped on a Mac');
});

test('`where claude` output is read in PATH order, the first existing match wins', () => {
  const out = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\Users\\u\\.local\\bin\\claude.exe\r\n';
  assert.equal(pickPathFromShellOutput(out, () => true), 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(pickPathFromShellOutput(out, (p) => p.endsWith('.exe')), 'C:\\Users\\u\\.local\\bin\\claude.exe');
  assert.equal(pickPathFromShellOutput('INFO: Could not find files for the given pattern(s).\r\n', () => true), null);
});

test('an npm .cmd shim resolves to the cli.js it wraps, or to nothing', () => {
  const shim = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd';
  const cli = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  assert.equal(npmCliBeside(shim, fake([cli])), cli);
  assert.equal(npmCliBeside(shim, fake([])), null);
  assert.equal(npmCliBeside('C:\\Users\\u\\.local\\bin\\claude.exe', fake([])), null, 'only shims are unwrapped');
});

test('the connect card keeps the short command for a Windows PATH install, quotes the rest', () => {
  assert.equal(setupTokenCommand('C:\\Users\\u\\.local\\bin\\claude.exe', 'found', HOME_WIN, 'win32'), 'claude setup-token');
  assert.equal(setupTokenCommand('C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd', 'found', HOME_WIN, 'win32'), 'claude setup-token');
  assert.equal(
    setupTokenCommand('C:\\Users\\u\\.vscode\\extensions\\anthropic.claude-code-1.0\\resources\\native-binary\\claude.exe', 'found', HOME_WIN, 'win32'),
    '"C:\\Users\\u\\.vscode\\extensions\\anthropic.claude-code-1.0\\resources\\native-binary\\claude.exe" setup-token',
  );
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
