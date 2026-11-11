/**
 * The update check, pinned without the network: how versions order, what
 * counts as a manifest, when an announcement expires, and that a bad or
 * missing answer never disturbs the last good one. One test does use a real
 * socket, to prove the URL override is read at call time and that nothing
 * about the machine rides along on the request.
 *
 *   tsx scripts/release-test.ts
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkNow, compareVersions, parseManifest, releaseState, resetReleaseForTests } from '../src/release';

let passed = 0;
const failures: [string, Error][] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push([name, err as Error]);
    console.log(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

/** A fetch that answers with a fixed body and counts how often it was asked. */
function answering(body: unknown, ok = true) {
  const state = { calls: 0 };
  const impl = (async () => {
    state.calls++;
    return { ok, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, state };
}
const throwing = (async () => {
  throw new Error('offline');
}) as unknown as typeof fetch;

const GOOD = { version: '0.1.16', url: 'https://airoom.dev/download' };

(async () => {
  console.log('\nversion order');
  await test('numeric per part, not lexical', () => {
    assert.equal(compareVersions('0.1.15', '0.1.9'), 1);
    assert.equal(compareVersions('0.1.9', '0.1.15'), -1);
    assert.equal(compareVersions('0.1.15', '0.1.15'), 0);
    assert.equal(compareVersions('1.0', '1.0.0'), 0);
    assert.equal(compareVersions('v0.2.0', '0.1.99'), 1);
    assert.equal(compareVersions('0.1.16-beta.1', '0.1.15'), 1);
    assert.equal(compareVersions('0.1.15', '0.2'), -1);
  });

  console.log('\nwhat counts as a manifest');
  await test('a version and an https link are enough', () => {
    assert.deepEqual(parseManifest(GOOD), GOOD);
    assert.deepEqual(parseManifest({ version: 'v0.1.16', url: GOOD.url }), GOOD);
  });
  await test('a windows block rides along when it is https, and is ignored when it is not', () => {
    const m = parseManifest({ ...GOOD, windows: { url: 'https://airoom.dev/download?os=windows' } });
    assert.equal(m?.windowsUrl, 'https://airoom.dev/download?os=windows');
    assert.equal(parseManifest({ ...GOOD, windows: { url: 'http://x' } })?.windowsUrl, undefined);
    assert.equal(parseManifest({ ...GOOD, windows: 'later' })?.windowsUrl, undefined);
  });
  await test('a non-https link or a garbage version rejects the whole manifest', () => {
    assert.equal(parseManifest({ version: '0.1.16', url: 'http://airoom.dev/download' }), null);
    assert.equal(parseManifest({ version: 'latest', url: GOOD.url }), null);
    assert.equal(parseManifest({ url: GOOD.url }), null);
    assert.equal(parseManifest('0.1.16'), null);
    assert.equal(parseManifest(null), null);
  });
  await test('an announcement needs an id and text; the text is one line, capped', () => {
    const long = 'x'.repeat(400);
    const m = parseManifest({ ...GOOD, message: { id: ' teams ', text: `  hello\n\n  world ${long}` } });
    assert.equal(m?.message?.id, 'teams');
    assert.ok(m!.message!.text.startsWith('hello world '));
    assert.equal(m!.message!.text.length, 200);
    assert.ok(m!.message!.text.endsWith('…'));
    assert.equal(parseManifest({ ...GOOD, message: { text: 'no id' } })?.message, undefined);
    assert.equal(parseManifest({ ...GOOD, message: { id: 'x', text: '   ' } })?.message, undefined);
  });
  await test('links inside the announcement must be https too', () => {
    assert.equal(parseManifest({ ...GOOD, message: { id: 'a', text: 't', url: 'javascript:alert(1)' } })?.message?.url, undefined);
    assert.equal(
      parseManifest({ ...GOOD, message: { id: 'a', text: 't', url: 'https://airoom.dev/blog' } })?.message?.url,
      'https://airoom.dev/blog',
    );
    assert.equal(parseManifest({ ...GOOD, notes: 'ftp://x' })?.notes, undefined);
  });

  console.log('\nwhat the app is told');
  await test('a newer build than the one running is an update', async () => {
    resetReleaseForTests();
    process.env.AIROOM_VERSION = '0.1.15';
    assert.equal(await checkNow(answering(GOOD).impl, () => 1_000), true);
    const s = releaseState();
    assert.equal(s.current, '0.1.15');
    assert.equal(s.updateAvailable, true);
    assert.equal(s.latest?.version, '0.1.16');
    assert.equal(s.latest?.url, GOOD.url);
    assert.equal(s.latest?.windowsUrl, undefined, 'no windows build, no windows link');
    assert.equal(s.checkedAt, new Date(1_000).toISOString());
    assert.equal(s.message, null);
  });
  await test('the windows link reaches the app when the manifest carries one', async () => {
    resetReleaseForTests();
    process.env.AIROOM_VERSION = '0.1.15';
    await checkNow(answering({ ...GOOD, windows: { url: 'https://airoom.dev/download?os=windows' } }).impl);
    assert.equal(releaseState().latest?.windowsUrl, 'https://airoom.dev/download?os=windows');
  });
  await test('the same or an older build is not an update', async () => {
    resetReleaseForTests();
    process.env.AIROOM_VERSION = '0.1.16';
    await checkNow(answering(GOOD).impl);
    assert.equal(releaseState().updateAvailable, false);
    process.env.AIROOM_VERSION = '0.2.0';
    assert.equal(releaseState().updateAvailable, false);
  });
  await test('in dev, with no version, nothing is ever out of date — but notes still show', async () => {
    resetReleaseForTests();
    delete process.env.AIROOM_VERSION;
    await checkNow(answering({ ...GOOD, message: { id: 'hi', text: 'Teams are here.' } }).impl);
    const s = releaseState();
    assert.equal(s.current, null);
    assert.equal(s.updateAvailable, false);
    assert.deepEqual(s.message, { id: 'hi', text: 'Teams are here.' });
  });
  await test('an announcement past its date is dropped, on time, without another fetch', async () => {
    resetReleaseForTests();
    const until = '2026-10-01T00:00:00Z';
    await checkNow(
      answering({ ...GOOD, message: { id: 'offer', text: 'Launch offer ends soon.', url: 'https://airoom.dev/#buy', until } })
        .impl,
    );
    const before = Date.parse(until) - 60_000;
    const after = Date.parse(until) + 60_000;
    assert.deepEqual(releaseState(() => before).message, {
      id: 'offer',
      text: 'Launch offer ends soon.',
      url: 'https://airoom.dev/#buy',
    });
    assert.equal(releaseState(() => after).message, null);
  });

  console.log('\nwhen airoom.dev does not answer well');
  await test('a failed fetch keeps the last good answer', async () => {
    resetReleaseForTests();
    process.env.AIROOM_VERSION = '0.1.15';
    await checkNow(answering(GOOD).impl, () => 1_000);
    assert.equal(await checkNow(answering(null, false).impl, () => 2_000), false);
    assert.equal(await checkNow(throwing, () => 3_000), false);
    const s = releaseState();
    assert.equal(s.latest?.version, '0.1.16');
    assert.equal(s.checkedAt, new Date(1_000).toISOString());
  });
  await test('a manifest that does not parse is ignored whole, not half-applied', async () => {
    resetReleaseForTests();
    process.env.AIROOM_VERSION = '0.1.15';
    await checkNow(answering(GOOD).impl, () => 1_000);
    assert.equal(await checkNow(answering({ version: '0.1.17', url: 'http://evil' }).impl, () => 2_000), false);
    assert.equal(releaseState().latest?.version, '0.1.16');
    assert.equal(releaseState().checkedAt, new Date(1_000).toISOString());
  });
  await test('AIROOM_NO_UPDATE_CHECK=1 never asks at all', async () => {
    resetReleaseForTests();
    process.env.AIROOM_NO_UPDATE_CHECK = '1';
    const a = answering(GOOD);
    assert.equal(await checkNow(a.impl), false);
    assert.equal(a.state.calls, 0);
    assert.equal(releaseState().latest, null);
    delete process.env.AIROOM_NO_UPDATE_CHECK;
  });

  console.log('\nthe real fetch');
  await test('reads AIROOM_RELEASE_URL at call time, and nothing about the machine rides along', async () => {
    resetReleaseForTests();
    process.env.AIROOM_VERSION = '0.1.15';
    let hits = 0;
    let seenUrl = '';
    const srv = http.createServer((req, res) => {
      hits++;
      seenUrl = req.url ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(GOOD));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address() as AddressInfo;
    process.env.AIROOM_RELEASE_URL = `http://127.0.0.1:${port}/release.json`;
    try {
      assert.equal(await checkNow(), true);
      assert.equal(hits, 1);
      assert.equal(seenUrl, '/release.json');
      assert.equal(releaseState().updateAvailable, true);
    } finally {
      delete process.env.AIROOM_RELEASE_URL;
      srv.close();
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
})();
