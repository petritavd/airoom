/**
 * Two rules the session lifetime turns on, pinned offline.
 *
 * Both were learned from a live failure: a session wound down while it still
 * had work running, and — after the first attempt at fixing that — an idle
 * session that never stopped looking busy because the stream's housekeeping
 * traffic was read as a turn.
 */
import assert from 'node:assert/strict';
import { isTurnTraffic, windDownWindow } from '../src/agent/SdkClaudeController';

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

console.log('\nwhat counts as a session working');

test('a turn is under way for assistant, user and streamed traffic', () => {
  for (const t of ['assistant', 'user', 'stream_event']) assert.equal(isTurnTraffic(t), true, t);
});

test('housekeeping is not a turn — a rate-limit notice must not look like work', () => {
  // Measured: this one arrives on its own between turns, and reading it as a
  // turn left an idle session permanently "busy".
  assert.equal(isTurnTraffic('rate_limit_event'), false);
  assert.equal(isTurnTraffic('system'), false);
  assert.equal(isTurnTraffic('result'), false);
  assert.equal(isTurnTraffic(''), false);
});

console.log('\nhow long a quiet session is kept');

test('a session holding background work is kept far longer than a plain one', () => {
  const plain = windDownWindow(false);
  const holding = windDownWindow(true);
  assert.equal(plain, 2 * 60 * 1000, 'the ordinary warm window is two minutes');
  assert.ok(holding >= 20 * 60 * 1000, `background work needs a long window, got ${holding}ms`);
  assert.ok(holding > plain);
});

test('the long window covers a wait that the two-minute one killed', () => {
  // The reported case: a dev server started at 03:13, its first notification at
  // 03:29. Two minutes cut the session — and the server — down at 03:15.
  const waited = 16 * 60 * 1000;
  assert.ok(waited > windDownWindow(false), 'the old window was the bug');
  assert.ok(waited < windDownWindow(true), 'the new one survives it');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
