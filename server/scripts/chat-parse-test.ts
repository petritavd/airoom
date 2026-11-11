/**
 * The chat's reading of a transcript: slash commands, their output, and
 * compaction must all be visible — and must land with the right status.
 *
 * Record shapes are copied from real ~/.claude transcripts (CLI 2.1.233).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAllSteps, parseSession } from '../src/parse/sessionParser';
import { LocalClaudeDataSource } from '../src/datasource/LocalClaudeDataSource';

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

const line = (o: object) => JSON.stringify(o);
const user = (content: string, ts: string, uuid: string) =>
  line({ type: 'user', uuid, timestamp: ts, sessionId: 's1', cwd: '/tmp/x', message: { role: 'user', content } });
/** A record Claude Code flags as machinery, content in the array form the skill loader uses. */
const metaUser = (text: string, ts: string, uuid: string) =>
  line({ type: 'user', uuid, timestamp: ts, sessionId: 's1', cwd: '/tmp/x', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } });
const assistant = (text: string, ts: string, uuid: string) =>
  line({ type: 'assistant', uuid, timestamp: ts, sessionId: 's1', cwd: '/tmp/x', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] } });

console.log('\nslash commands in history');

test('a /compact invocation renders as the user turn it was', () => {
  const raw = [
    user('hello there', '2026-08-30T10:00:00Z', 'u1'),
    assistant('hi!', '2026-08-30T10:00:05Z', 'a1'),
    user('<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>', '2026-08-30T10:01:00Z', 'u2'),
  ].join('\n');
  const steps = parseAllSteps(raw);
  const labels = steps.map((s) => `${s.kind}:${s.label}`);
  assert.ok(labels.includes('user:/compact'), `missing /compact user step in ${JSON.stringify(labels)}`);
});

test('command args ride along, tags in either order', () => {
  const raw = user('<command-message>design</command-message>\n<command-name>/design</command-name>\n<command-args>a new logo</command-args>', '2026-08-30T10:00:00Z', 'u1');
  const steps = parseAllSteps(raw);
  assert.equal(steps[0]?.kind, 'user');
  assert.equal(steps[0]?.label, '/design a new logo');
});

test('what a command printed shows as its reply', () => {
  const raw = [
    user('<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>', '2026-08-30T10:00:00Z', 'u1'),
    user('<local-command-stdout>## Context Usage\n\n27k / 1m (3%)</local-command-stdout>', '2026-08-30T10:00:01Z', 'u2'),
  ].join('\n');
  const steps = parseAllSteps(raw);
  assert.equal(steps.length, 2);
  assert.equal(steps[1].kind, 'assistant_text');
  assert.ok(steps[1].label.includes('27k / 1m'));
});

test('a bare "Compacted" stdout is folded into the boundary marker', () => {
  const raw = [
    user('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>', '2026-08-30T10:00:00Z', 'u1'),
    line({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', timestamp: '2026-08-30T10:00:30Z', sessionId: 's1', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 976951, postTokens: 8192 } }),
    user('<local-command-stdout>Compacted </local-command-stdout>', '2026-08-30T10:00:31Z', 'u2'),
  ].join('\n');
  const steps = parseAllSteps(raw);
  const kinds = steps.map((s) => s.kind);
  assert.deepEqual(kinds, ['user', 'marker']);
  assert.equal(steps[1].label, 'Conversation compacted');
  assert.equal(steps[1].detail, '977k → 8k tokens');
});

test('an automatic compaction is labelled as such and keeps its numbers', () => {
  const raw = line({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', timestamp: '2026-08-30T10:00:30Z', sessionId: 's1', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 150000, postTokens: 9000 } });
  // A lone boundary is not a conversation; anchor it with a real turn.
  const steps = parseAllSteps([user('long chat', '2026-08-30T09:59:00Z', 'u0'), raw].join('\n'));
  const marker = steps.find((s) => s.kind === 'marker');
  assert.ok(marker, 'no marker step');
  assert.equal(marker!.detail, '150k → 9k tokens · automatic');
});

test('after /context answers, the robot is done — not "Thinking…" for ten minutes', () => {
  const now = new Date().toISOString();
  const raw = [
    user('real question', new Date(Date.now() - 60_000).toISOString(), 'u1'),
    assistant('real answer', new Date(Date.now() - 50_000).toISOString(), 'a1'),
    user('<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>', now, 'u2'),
    user('<local-command-stdout>## Context Usage</local-command-stdout>', now, 'u3'),
  ].join('\n');
  const robot = parseSession(raw, 's1');
  assert.ok(robot, 'no robot');
  assert.notEqual(robot!.currentAction, 'Thinking…');
});

test('a manual compact closes its turn instead of leaving the robot thinking', () => {
  const now = new Date().toISOString();
  const raw = [
    user('real question', new Date(Date.now() - 120_000).toISOString(), 'u1'),
    assistant('real answer', new Date(Date.now() - 110_000).toISOString(), 'a1'),
    user('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>', now, 'u2'),
    line({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', timestamp: now, sessionId: 's1', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 90000, postTokens: 8000 } }),
    user('<local-command-stdout>Compacted </local-command-stdout>', now, 'u3'),
  ].join('\n');
  const robot = parseSession(raw, 's1');
  assert.ok(robot, 'no robot');
  assert.notEqual(robot!.status, 'working');
});

test('ordinary chat is untouched by any of this', () => {
  const raw = [
    user('hello', '2026-08-30T10:00:00Z', 'u1'),
    assistant('hi!', '2026-08-30T10:00:05Z', 'a1'),
  ].join('\n');
  const steps = parseAllSteps(raw);
  assert.deepEqual(steps.map((s) => s.kind), ['user', 'assistant_text']);
});

test('a command with no persisted output (SDK sessions) leaves status alone', () => {
  const now = new Date().toISOString();
  const raw = [
    user('real question', new Date(Date.now() - 120_000).toISOString(), 'u1'),
    assistant('real answer', new Date(Date.now() - 110_000).toISOString(), 'a1'),
    user('<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>', now, 'u2'),
  ].join('\n');
  const robot = parseSession(raw, 's1');
  assert.ok(robot, 'no robot');
  assert.notEqual(robot!.status, 'working');
  assert.notEqual(robot!.currentAction, 'Thinking…');
});

test('an attached image becomes a chip, not a wall of scaling arithmetic', () => {
  const raw = [
    user('look at this screenshot', '2026-08-31T10:00:00Z', 'u1'),
    user('[Image: original 3458x1176, displayed at 2000x680. Multiply coordinates by 1.73 to map to original image.]', '2026-08-31T10:00:01Z', 'u2'),
  ].join('\n');
  const steps = parseAllSteps(raw);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].label, 'look at this screenshot');
  assert.equal(steps[1].images, 1);
  assert.equal(steps[1].imageDims, '3458×1176');
  assert.equal(steps[1].label, '', 'the machinery text never renders');
});

test('two scaling notes in one record become one two-image chip turn', () => {
  const raw = user('[Image: original 3102x462, displayed at 2000x298. Multiply coordinates by 1.55 to map to original image.] [Image: original 3102x462, displayed at 2000x298. Multiply coordinates by 1.55 to map to original image.]', '2026-09-01T10:00:00Z', 'u1');
  const steps = parseAllSteps(raw);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].images, 2);
  assert.equal(steps[0].imageDims, '3102×462');
  assert.equal(steps[0].label, '', 'no arithmetic in the chat');
});

test('a note embedded in real prose is stripped, counted, and the prose survives', () => {
  const raw = user('here is the look [Image: original 800x600, displayed at 400x300. Multiply coordinates by 2 to map to original image.] what do you think?', '2026-09-01T10:00:00Z', 'u1');
  const steps = parseAllSteps(raw);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, 'here is the look what do you think?');
  assert.equal(steps[0].images, 1);
});

test('image refs address the bytes for on-demand thumbnails', () => {
  const raw = line({
    type: 'user', uuid: 'rec-77', timestamp: '2026-08-31T10:00:00Z', sessionId: 's1',
    message: { role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'text', text: 'two attached' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
    ] },
  });
  const steps = parseAllSteps(raw);
  assert.equal(steps[0].images, 2);
  assert.deepEqual(steps[0].imageRefs, [
    { id: 'rec-77:0', media: 'image/jpeg' },
    { id: 'rec-77:2', media: 'image/png' },
  ]);
});

test('an image block riding a text message counts on that turn', () => {
  const raw = line({
    type: 'user', uuid: 'u1', timestamp: '2026-08-31T10:00:00Z', sessionId: 's1',
    message: { role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'what is this?' },
    ] },
  });
  const steps = parseAllSteps(raw);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, 'what is this?');
  assert.equal(steps[0].images, 1);
});

test('an image-only message still shows up as a turn', () => {
  const raw = line({
    type: 'user', uuid: 'u1', timestamp: '2026-08-31T10:00:00Z', sessionId: 's1',
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
  });
  const steps = parseAllSteps(raw);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].images, 1);
});

test('a tool orphaned by a dead process stops claiming "working" once the human moves on', () => {
  const now = new Date().toISOString();
  const raw = [
    user('do the thing', new Date(Date.now() - 300_000).toISOString(), 'u1'),
    line({ type: 'assistant', uuid: 'a1', timestamp: new Date(Date.now() - 290_000).toISOString(), sessionId: 's1',
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 'tu_dead', name: 'Bash', input: { command: 'sleep forever' } }] } }),
    // the process died here — no tool_result ever lands
    user('are you alive?', new Date(Date.now() - 60_000).toISOString(), 'u2'),
    assistant('yes — picking back up', now, 'a2'),
  ].join('\n');
  const robot = parseSession(raw, 's1');
  assert.ok(robot, 'no robot');
  assert.notEqual(robot!.status, 'working', `still working: ${robot!.currentAction}`);
  assert.ok(!/Running Bash/.test(robot!.currentAction), robot!.currentAction);
});

test('a genuinely running tool still reads as working', () => {
  const raw = [
    user('do the thing', new Date(Date.now() - 90_000).toISOString(), 'u1'),
    line({ type: 'assistant', uuid: 'a1', timestamp: new Date(Date.now() - 5_000).toISOString(), sessionId: 's1',
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 'tu_live', name: 'Bash', input: { command: 'npm test' } }] } }),
  ].join('\n');
  const robot = parseSession(raw, 's1');
  assert.equal(robot!.status, 'working');
  assert.match(robot!.currentAction, /Running Bash/);
});

test('the post-compact continuation summary never renders as a user turn', () => {
  const raw = [
    user('real question', '2026-08-30T10:00:00Z', 'u1'),
    line({ type: 'user', uuid: 'u2', timestamp: '2026-08-30T10:01:00Z', sessionId: 's1', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context…' } }),
  ].join('\n');
  const steps = parseAllSteps(raw);
  assert.deepEqual(steps.map((s) => s.kind), ['user']);
  assert.equal(steps[0].label, 'real question');
});

await test('the image endpoint round-trips bytes by ref, and refuses nonsense', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'airoom-img-'));
  try {
    const proj = path.join(root, '-tmp-imgproj');
    mkdirSync(proj, { recursive: true });
    const pixels = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    writeFileSync(
      path.join(proj, 'sess-img.jsonl'),
      [
        line({ type: 'user', uuid: 'ab12cd34-0000-1111-2222-333344445555', timestamp: '2026-08-31T10:00:00Z', sessionId: 'sess-img', cwd: '/tmp/imgproj',
          message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pixels.toString('base64') } }, { type: 'text', text: 'look' }] } }),
      ].join('\n'),
    );
    const source = new LocalClaudeDataSource(root);
    const hit = await source.getSessionImage('sess-img', 'ab12cd34-0000-1111-2222-333344445555:0');
    assert.ok(hit, 'image found by ref');
    assert.equal(hit!.media, 'image/png');
    assert.deepEqual(hit!.data, pixels, 'bytes round-trip exactly');
    assert.equal(await source.getSessionImage('sess-img', 'ab12cd34-0000-1111-2222-333344445555:1'), null, 'a text block is not an image');
    assert.equal(await source.getSessionImage('sess-img', '../../etc/passwd:0'), null, 'traversal-shaped refs die at the regex');
    assert.equal(await source.getSessionImage('no-such-session', 'ab12cd34-0000-1111-2222-333344445555:0'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log('\nwhat Claude Code marks as machinery');

test("a skill's expanded instructions never render as something the user pasted", () => {
  const raw = [
    user('<command-message>design</command-message>\n<command-name>/design</command-name>\n<command-args>a demo video</command-args>', '2026-09-02T21:20:00Z', 'u1'),
    metaUser('Base directory for this skill: /private/tmp/bundled-skills/abc/design\n\n# Create a design canvas\n\n**Two quick exits.** ' + 'x'.repeat(6000), '2026-09-02T21:20:00Z', 'u2'),
    assistant("I'll build this as an animated demo artboard.", '2026-09-02T21:20:05Z', 'a1'),
  ].join('\n');
  const steps = parseAllSteps(raw);
  assert.ok(!steps.some((s) => s.kind === 'user' && s.label.includes('Base directory')), 'skill body leaked as a user turn');
  assert.deepEqual(steps.map((s) => s.kind), ['user', 'marker', 'assistant_text']);
  assert.equal(steps[0].label, '/design a demo video');
  assert.equal(steps[1].label, 'Skill loaded: design');
});

test("the harness's own nudge after a compaction stays hidden", () => {
  const steps = parseAllSteps(metaUser('Continue from where you left off.', '2026-09-02T21:20:00Z', 'u1'));
  assert.equal(steps.length, 0);
});

test('an isMeta scaling note still becomes the image chip', () => {
  const steps = parseAllSteps(metaUser('[Image: original 2200x1800, displayed at 2000x1636. Multiply coordinates by 1.1 to map to original image coordinates.]', '2026-09-02T21:20:00Z', 'u1'));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, 'user');
  assert.equal(steps[0].images, 1);
  assert.equal(steps[0].imageDims, '2200×1800');
});

test('a multi-paragraph message keeps its line breaks', () => {
  const steps = parseAllSteps(user('First line.\n\nSecond paragraph,\nwith a wrapped line.', '2026-09-02T21:20:00Z', 'u1'));
  assert.equal(steps[0].label, 'First line.\n\nSecond paragraph,\nwith a wrapped line.');
});

test('a note beside prose is stripped without flattening the prose', () => {
  const steps = parseAllSteps(user('look at this\n[Image: original 100x50, displayed at 100x50.]\n\nand fix the header', '2026-09-02T21:20:00Z', 'u1'));
  assert.equal(steps[0].images, 1);
  assert.equal(steps[0].label, 'look at this\n\nand fix the header');
  assert.ok(!steps[0].label.includes('[Image'));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
