/**
 * Letting agents go, and deleting them, against a real transcript tree.
 *
 *   npx tsx scripts/agent-removal-test.ts
 *
 * Builds a throwaway ~/.claude/projects-shaped directory and drives the real
 * LocalClaudeDataSource over it. The point is the promises the UI makes:
 * "let go" must never touch a transcript, "delete" must be recoverable, and
 * neither may strand an agent somewhere unreachable.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalClaudeDataSource } from '../src/datasource/LocalClaudeDataSource';

let passed = 0;
const failures: Array<[string, Error]> = [];
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push([name, err as Error]);
    console.log(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'airoom-removal-'));
const root = path.join(tmp, 'projects');
const home = path.join(tmp, 'home');
mkdirSync(root, { recursive: true });
mkdirSync(home, { recursive: true });
// The datasource writes config + graveyard under the real homedir; point it at
// our sandbox so a test can never touch the user's own ~/.airoom. Node reads
// the home from HOME on Unix and from USERPROFILE on Windows — set both, or
// the Windows runner quietly writes into the real profile (it did).
process.env.HOME = home;
process.env.USERPROFILE = home;

/** One session file, shaped enough for parseSession to build a Robot. */
function session(cwd: string, id: string, prompt: string, turns = 2) {
  const dir = path.join(root, cwd.replace(/[/._]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const now = new Date().toISOString();
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ type: 'user', uuid: `u${id}${i}`, cwd, sessionId: id, timestamp: now, message: { role: 'user', content: i === 0 ? prompt : `follow up ${i}` } }));
    lines.push(JSON.stringify({ type: 'assistant', uuid: `a${id}${i}`, cwd, sessionId: id, timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] } }));
  }
  const file = path.join(dir, `${id}.jsonl`);
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

const ROOM_A = '/tmp/proj-alpha';
const ROOM_B = '/tmp/proj-beta';
const fileKeep = session(ROOM_A, 'sess-keep', 'keep me around');
const fileFire = session(ROOM_A, 'sess-fire', 'fire me', 3);
session(ROOM_B, 'sess-only', 'the only one in beta');

const ds = new LocalClaudeDataSource(root);
const ids = async () => (await ds.getSnapshot()).robots.map((r) => r.sessionId).sort();
const awayIds = async () => (await ds.getSnapshot()).away.map((a) => a.sessionId).sort();

console.log('\nletting an agent go');

await test('all three start out at desks', async () => {
  assert.deepEqual(await ids(), ['sess-fire', 'sess-keep', 'sess-only']);
  assert.deepEqual(await awayIds(), []);
});

await test('letting one go removes its robot but keeps the transcript', async () => {
  assert.equal(await ds.setSessionHidden('sess-fire', true), null);
  assert.deepEqual(await ids(), ['sess-keep', 'sess-only']);
  assert.ok(existsSync(fileFire), 'the transcript must still be on disk');
});

await test('it is listed as away, carrying what the desk showed', async () => {
  // The away card has to be recognisable: same title and size the robot had,
  // because "bring back sess-fire?" is not a question anyone can answer.
  await ds.setSessionHidden('sess-fire', false);
  const before = (await ds.getSnapshot()).robots.find((r) => r.sessionId === 'sess-fire')!;
  await ds.setSessionHidden('sess-fire', true);
  const gone = (await ds.getSnapshot()).away.find((a) => a.sessionId === 'sess-fire');
  assert.ok(gone, 'expected an away entry');
  assert.equal(gone.roomId, ROOM_A);
  assert.equal(gone.title, before.title);
  assert.equal(gone.messageCount, before.messageCount);
  assert.equal(gone.lastActivity, before.lastActivity);
  assert.ok(gone.title.length > 0, 'a bare session id is not something anyone can act on');
});

await test('the room it left still counts only the agents at desks', async () => {
  const room = (await ds.getSnapshot()).rooms.find((r) => r.id === ROOM_A);
  assert.equal(room?.robotCount, 1);
});

await test('bringing it back restores it exactly', async () => {
  assert.equal(await ds.setSessionHidden('sess-fire', false), null);
  assert.deepEqual(await ids(), ['sess-fire', 'sess-keep', 'sess-only']);
  assert.deepEqual(await awayIds(), []);
});

await test('the decision survives a restart', async () => {
  await ds.setSessionHidden('sess-fire', true);
  const fresh = new LocalClaudeDataSource(root); // new process, same config file
  assert.deepEqual((await fresh.getSnapshot()).robots.map((r) => r.sessionId).sort(), ['sess-keep', 'sess-only']);
  await fresh.close();
});

await test('letting go twice is not an error, and does not duplicate', async () => {
  assert.equal(await ds.setSessionHidden('sess-fire', true), null);
  const cfg = JSON.parse(readFileSync(path.join(home, '.airoom', 'projects.json'), 'utf8'));
  assert.deepEqual(cfg.hiddenSessions, ['sess-fire']);
});

console.log('\nthe room must not disappear underneath them');

await test('letting the LAST agent in a room go keeps the room on the map', async () => {
  // Otherwise the room vanishes, and with it the only route back to the agent.
  assert.equal(await ds.setSessionHidden('sess-only', true), null);
  const snap = await ds.getSnapshot();
  assert.ok(snap.rooms.some((r) => r.id === ROOM_B), 'room B must survive with zero robots');
  assert.equal(snap.rooms.find((r) => r.id === ROOM_B)?.robotCount, 0);
  assert.ok(snap.away.some((a) => a.sessionId === 'sess-only'), 'and its agent must still be offerable');
  await ds.setSessionHidden('sess-only', false);
});

console.log('\ndeleting for real');

await test('delete moves the transcript instead of destroying it', async () => {
  const res = await ds.deleteSession('sess-keep');
  assert.equal(res.error, undefined);
  assert.ok(res.movedTo, 'the caller must be told where it went');
  assert.equal(existsSync(fileKeep), false, 'gone from the projects tree');
  assert.ok(existsSync(res.movedTo!), 'but present in the graveyard');
  // The graveyard is ~/.airoom/deleted on a Mac and ~\.airoom\deleted on
  // Windows; the test cares about the folder, not the separator.
  assert.match(res.movedTo!, /[\\/]\.airoom[\\/]deleted[\\/]/, res.movedTo!);
  assert.match(readFileSync(res.movedTo!, 'utf8'), /keep me around/, 'and intact');
});

await test('the deleted agent leaves the office', async () => {
  assert.equal((await ids()).includes('sess-keep'), false);
  assert.equal((await awayIds()).includes('sess-keep'), false);
});

await test('the graveyard name records which project it came from', async () => {
  const files = readdirSync(path.join(home, '.airoom', 'deleted'));
  assert.equal(files.length, 1);
  assert.match(files[0], /proj-alpha.*sess-keep\.jsonl/);
});

await test('deleting an agent that was let go clears it from the away list too', async () => {
  await ds.setSessionHidden('sess-fire', true);
  const res = await ds.deleteSession('sess-fire');
  assert.equal(res.error, undefined);
  const cfg = JSON.parse(readFileSync(path.join(home, '.airoom', 'projects.json'), 'utf8'));
  assert.deepEqual(cfg.hiddenSessions, [], 'a deleted id must not linger in config forever');
  assert.deepEqual(await awayIds(), []);
});

await test('deleting something that is not there fails cleanly', async () => {
  const res = await ds.deleteSession('no-such-session');
  assert.match(res.error ?? '', /No transcript/);
});

await test('a session id cannot escape the projects tree', async () => {
  for (const evil of ['../../etc/passwd', 'a/b', '..']) {
    const res = await ds.deleteSession(evil);
    assert.match(res.error ?? '', /not valid|No transcript/, `${evil} was not refused`);
  }
});

await ds.close();
console.log('\nwhich projects appear');

await test('a fresh install has not been asked yet', async () => {
  // This sandbox home had no projects.json when the datasource first loaded;
  // everything persisted since carried the answer forward as "not yet".
  const snap = await ds.getSnapshot();
  assert.equal(snap.curated, false);
  assert.deepEqual(snap.hiddenProjects, []);
});

await test('the answer puts the unticked rooms away and settles the question', async () => {
  const before = (await ds.getSnapshot()).rooms.map((r) => r.id);
  assert.ok(before.includes(ROOM_B), 'beta is on the floor to begin with');
  assert.equal(await ds.curate([ROOM_B]), null);
  const snap = await ds.getSnapshot();
  assert.equal(snap.curated, true);
  assert.deepEqual(snap.hiddenProjects, [ROOM_B]);
  assert.deepEqual(
    snap.rooms.map((r) => r.id),
    before.filter((id) => id !== ROOM_B),
    'beta is off the floor and nothing else moved',
  );
  assert.ok(existsSync(path.join(root, ROOM_B.replace(/[/._]/g, '-'))), 'its transcripts were not touched');
});

await test('the answer survives a restart', async () => {
  const again = new LocalClaudeDataSource(root);
  const snap = await again.getSnapshot();
  assert.equal(snap.curated, true);
  assert.deepEqual(snap.hiddenProjects, [ROOM_B]);
});

await test('asking again replaces the whole list — what is left unticked IS the list', async () => {
  assert.equal(await ds.curate([]), null);
  const snap = await ds.getSnapshot();
  assert.deepEqual(snap.hiddenProjects, []);
  assert.ok(snap.rooms.some((r) => r.id === ROOM_B), 'beta is back');
});

await test('an office that was already lived in is not asked', async () => {
  // A projects.json from before the question existed has no `curated` key.
  // Those users have been using airoom for weeks; a "welcome, choose your
  // projects" card would be nonsense to them.
  const older = path.join(tmp, 'older-home');
  mkdirSync(path.join(older, '.airoom'), { recursive: true });
  writeFileSync(path.join(older, '.airoom', 'projects.json'), JSON.stringify({ projects: [], hidden: [], hiddenSessions: [] }));
  const saved = process.env.HOME;
  process.env.HOME = older;
  process.env.USERPROFILE = older;
  try {
    const snap = await new LocalClaudeDataSource(root).getSnapshot();
    assert.equal(snap.curated, true);
  } finally {
    process.env.HOME = saved;
    process.env.USERPROFILE = saved;
  }
});

rmSync(tmp, { recursive: true, force: true });

console.log(
  failures.length
    ? `\n${passed} passed, ${failures.length} FAILED\n${failures.map(([n, e]) => `  ${n}\n    ${e.stack}`).join('\n')}`
    : `\n${passed} passed, 0 failed\n`,
);
process.exit(failures.length ? 1 : 0);
