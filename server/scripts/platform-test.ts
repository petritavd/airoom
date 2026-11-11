/**
 * The path helpers, pinned with both separators at once. These run on the Mac
 * and on the Windows runner with the same expectations: the helpers are
 * separator-agnostic by construction, not by platform detection.
 */
import assert from 'node:assert/strict';
import { basename, isAbsolutePath, listRoots, normalizePath, parentPath, segments } from '../src/platform';

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

console.log('\nabsolute paths');
test('unix, drive-letter and UNC paths are absolute; relative ones are not', () => {
  for (const p of ['/Users/p/x', 'C:\\Users\\p', 'C:/Users/p', '\\\\srv\\share\\x', '/', 'D:\\']) assert.equal(isAbsolutePath(p), true, p);
  for (const p of ['x/y', 'Users\\p', '', '   ', 'proj']) assert.equal(isAbsolutePath(p), false, JSON.stringify(p));
});

console.log('\nbasenames and segments');
test('the last folder, whichever separator', () => {
  assert.equal(basename('/Users/p/Documents/airoom'), 'airoom');
  assert.equal(basename('C:\\Users\\petrit\\proj'), 'proj');
  assert.equal(basename('C:/Users/p/proj/'), 'proj');
  assert.equal(basename('/Users/p/x///'), 'x');
  assert.equal(basename('C:\\'), 'C:');
  assert.equal(basename('/'), '/');
});
test('segments keep the drive letter and drop empties', () => {
  assert.deepEqual(segments('/Users/p/x'), ['Users', 'p', 'x']);
  assert.deepEqual(segments('C:\\Users\\p\\x\\'), ['C:', 'Users', 'p', 'x']);
  assert.deepEqual(segments('C:/mixed\\seps/here'), ['C:', 'mixed', 'seps', 'here']);
});

console.log('\nnormalising');
test('trailing separators go, roots keep theirs', () => {
  assert.equal(normalizePath('/Users/p/x/'), '/Users/p/x');
  assert.equal(normalizePath('  C:\\Users\\p\\  '), 'C:\\Users\\p');
  assert.equal(normalizePath('C:\\'), 'C:\\');
  assert.equal(normalizePath('C:'), 'C:\\');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('///'), '/');
});
test('parents stop at the root', () => {
  assert.equal(parentPath('/Users/p/x'), '/Users/p');
  assert.equal(parentPath('/'), null);
  // path.dirname is platform-bound, so drive-letter parents are only exact on Windows;
  // what must hold everywhere is that a root has no parent.
  if (process.platform === 'win32') {
    assert.equal(parentPath('C:\\Users\\p'), 'C:\\Users');
    assert.equal(parentPath('C:\\'), null);
  }
});

console.log('\nroots');
test('unix has one root; windows lists the drives that exist', () => {
  if (process.platform === 'win32') {
    const roots = listRoots((p) => p === 'C:\\' || p === 'D:\\');
    assert.deepEqual(roots, ['C:\\', 'D:\\']);
    assert.deepEqual(listRoots(() => false), ['C:\\'], 'never an empty picker');
  } else {
    assert.deepEqual(listRoots(), ['/']);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
