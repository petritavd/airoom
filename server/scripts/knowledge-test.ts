/**
 * What a session used from its knowledge base, proven without a model.
 *
 *   npx tsx scripts/knowledge-test.ts
 *
 * What is on trial: that the list is read from the transcript alone, in the
 * shapes Cognivio's tools answer in, that a session still being written is
 * followed without being read again, that a rewritten file is noticed, and
 * that all of it is off until a room switches it on. Nothing here opens a
 * socket.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'airoom-knowledge-'));
process.env.HOME = dir;
process.env.USERPROFILE = dir;
const claudeJson = path.join(dir, 'claude.json');
process.env.AIROOM_CLAUDE_JSON = claudeJson;
process.env.AIROOM_CONNECTORS_FILE = path.join(dir, 'connectors.json');
const { isKnowledgeBase, knowledgeIn } = await import('../src/knowledge/scan');
const { sessionKnowledge } = await import('../src/knowledge/session');
const { adoptedIn, ConnectorsService, knowledgeOn, setAdopted, setKnowledgeOn } = await import('../src/connectors');
const { LocalClaudeDataSource } = await import('../src/datasource/LocalClaudeDataSource');

let passed = 0;
const failures: Array<[string, Error]> = [];
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
    })
    .catch((e) => failures.push([name, e]));
}

// ---- a transcript, a record at a time ----------------------------------------

let n = 0;
const use = (name: string, input: Record<string, unknown>, id = `toolu_${++n}`) => ({
  id,
  line: JSON.stringify({ type: 'assistant', timestamp: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }),
});
const result = (id: string, body: unknown, isError = false) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, ...(isError ? { is_error: true } : {}), content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) }] }] } });
const say = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const T = 'mcp__cognivio__';
// The shapes below are the ones Cognivio answers in (backend/app/models/schemas.py
// there): prime_context {index, results}, search_memory {memories, total},
// get_memory and write_memory a document, read_map {teamId, mapMemory, nodes, edges}.
const doc = (id: string, title: string, type = 'decision') => ({ id, title, type, content: 'x'.repeat(50) });

await test('each kind of call becomes one event, with the documents its answer named', () => {
  const prime = use(`${T}prime_context`, { query: 'make the workspace work on phones' });
  const search = use(`${T}search_memory`, { team_id: 't', query: 'drawer' });
  const read = use(`${T}get_memory`, { memory_id: 'd2' });
  const map = use(`${T}read_map`, { team_id: 't' });
  const write = use(`${T}write_memory`, { team_id: 't', title: 'How the workspace behaves on small screens', type: 'architecture', content: 'long' });
  const gone = use(`${T}delete_memory`, { memory_id: 'd9' });
  const events = knowledgeIn(
    [
      prime.line,
      result(prime.id, { query: 'q', index: [doc('m1', 'Project Map', 'map')], results: [doc('d1', 'Frontend workspace', 'architecture'), doc('d2', 'Theme is platform-wide')] }),
      search.line,
      result(search.id, { memories: [], total: 0 }),
      read.line,
      result(read.id, doc('d2', 'Theme is platform-wide')),
      map.line,
      result(map.id, { teamId: 't', mapMemory: doc('m1', 'Project Map', 'map'), nodes: [{ id: 'd1', title: 'Frontend workspace', type: 'architecture' }], edges: [] }),
      write.line,
      result(write.id, doc('d7', 'How the workspace behaves on small screens', 'architecture')),
      gone.line,
      result(gone.id, { ok: true }),
    ].join('\n'),
  );
  assert.deepEqual(
    events.map((e) => [e.kind, e.query ?? '', e.docs.map((d) => `${d.id}:${d.title}`).join(' | ')]),
    [
      ['primed', 'make the workspace work on phones', 'd1:Frontend workspace | d2:Theme is platform-wide'],
      ['searched', 'drawer', ''],
      ['read', '', 'd2:Theme is platform-wide'],
      ['read', '', 'm1:Project Map'],
      ['wrote', '', 'd7:How the workspace behaves on small screens'],
      ['removed', '', 'd9:A document'],
    ],
  );
  assert.equal(events[0].ts, '2026-01-01T00:00:01Z');
  assert.equal(events[0].docs[0].type, 'architecture');
  assert.ok(events.every((e) => !e.pending && !e.failed));
  assert.ok(!JSON.stringify(events).includes('xxxxx'), 'a document’s text is not kept, only what names it');
});

await test('other tools, other connectors and plain talk about Cognivio are not events', () => {
  const other = use('mcp__github__search_memory', { query: 'cognivio' });
  const bash = use('Bash', { command: 'curl https://cognivio.app' });
  const whoami = use(`${T}whoami`, {});
  const plugin = use('mcp__plugin_kb_team-cognivio__get_memory', { memory_id: 'd1' });
  const events = knowledgeIn([say('I will ask Cognivio.'), other.line, bash.line, whoami.line, plugin.line, result(plugin.id, doc('d1', 'From a plugin'))].join('\n'));
  assert.deepEqual(events.map((e) => e.docs[0].title), ['From a plugin']);
});

await test('a connector is recognised whatever the case of its name, and with __ in it', () => {
  const upper = use('mcp__COGNIVIO__prime_context', { query: 'upper' });
  const split = use('mcp__cognivio__prod__get_memory', { memory_id: 'd3' });
  const events = knowledgeIn(
    [upper.line, result(upper.id, { index: [], results: [doc('d1', 'For the upper-case one')] }), split.line, result(split.id, doc('d3', 'For the split one'))].join('\n'),
  );
  assert.deepEqual(
    events.map((e) => [e.kind, e.docs.map((d) => d.title).join()]),
    [
      ['primed', 'For the upper-case one'],
      ['read', 'For the split one'],
    ],
  );
  // The name the row's switch is offered on and the name a call is counted
  // under are the same test, so one cannot be had without the other.
  for (const name of ['COGNIVIO', 'cognivio__prod', 'team-cognivio']) assert.equal(isKnowledgeBase(name), true);
});

await test('a map with no map document keeps what the call said', () => {
  const map = use(`${T}read_map`, { team_id: 't' });
  const events = knowledgeIn([map.line, result(map.id, { teamId: 't', mapMemory: null, nodes: [], edges: [] })].join('\n'));
  assert.deepEqual(events[0].docs, [{ title: 'The project map', type: 'map' }]);
});

await test('a call with no answer yet is pending, and a failed one says so', () => {
  const write = use(`${T}write_memory`, { title: 'Half written', type: 'lesson' });
  const read = use(`${T}get_memory`, { memory_id: 'd404' });
  const events = knowledgeIn([write.line, read.line, result(read.id, 'Error: 404 Not Found', true)].join('\n'));
  assert.deepEqual(events[0], { id: write.id, ts: events[0].ts, kind: 'wrote', docs: [{ title: 'Half written', type: 'lesson' }], pending: true });
  assert.equal(events[1].failed, true);
  assert.equal(events[1].pending, undefined);
});

await test('an answer the transcript does not hold is not shown as an empty one', () => {
  const write = use(`${T}write_memory`, { title: 'Kept from the call', type: 'decision' });
  const prime = use(`${T}prime_context`, { query: 'q' });
  const none = use(`${T}prime_context`, { query: 'nothing matches' });
  const events = knowledgeIn(
    [write.line, result(write.id, 'Output too large, saved to a file'), prime.line, result(prime.id, '<persisted-output>'), none.line, result(none.id, { index: [], results: [] }), '{ torn line'].join('\n'),
  );
  assert.deepEqual(events[0].docs, [{ title: 'Kept from the call', type: 'decision' }]);
  assert.equal(events[0].unlisted, undefined, 'the call named its document, so nothing is missing');
  assert.deepEqual([events[1].docs, events[1].unlisted, events[1].query], [[], true, 'q']);
  assert.deepEqual([events[2].docs, events[2].unlisted], [[], undefined], 'a real empty answer is still empty');
});

/** How many times JSON.parse ran while `fn` did: the scan's only parser. */
async function parsesDuring<T>(fn: () => T | Promise<T>): Promise<[T, number]> {
  const realParse = JSON.parse;
  let parses = 0;
  JSON.parse = ((...a: Parameters<typeof JSON.parse>) => (parses++, realParse(...a))) as typeof JSON.parse;
  try {
    return [await fn(), parses];
  } finally {
    JSON.parse = realParse;
  }
}

await test('a line that cannot matter is never parsed', async () => {
  const big = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_other', content: 'A'.repeat(200_000) }] } });
  const [none, skipped] = await parsesDuring(() => knowledgeIn([big, big, say('I will ask Cognivio.'), say('nothing to see')].join('\n')));
  assert.deepEqual(none, []);
  assert.equal(skipped, 0);
  // The counter is live: a line that does matter is parsed, once.
  const prime = use(`${T}prime_context`, { query: 'q' });
  const [one, parsed] = await parsesDuring(() => knowledgeIn([big, prime.line].join('\n')));
  assert.equal(one.length, 1);
  assert.equal(parsed, 1);
});

// ---- following a file --------------------------------------------------------

const root = path.join(dir, 'projects');
const projectDir = path.join(root, '-tmp-proj');
mkdirSync(projectDir, { recursive: true });
const file = path.join(projectDir, 'sess-1.jsonl');
const head = JSON.stringify({ type: 'user', cwd: '/tmp/proj', sessionId: 'sess-1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'do the thing' } });

await test('a session still being written is followed from where the last read stopped', async () => {
  const ds = new LocalClaudeDataSource(root);
  const prime = use(`${T}prime_context`, { query: 'first' });
  writeFileSync(file, [head, prime.line].join('\n') + '\n');
  assert.deepEqual((await ds.getKnowledge('sess-1')).map((e) => [e.kind, !!e.pending]), [['primed', true]]);
  // The answer arrives, then a write whose line is not finished yet.
  const write = use(`${T}write_memory`, { title: 'Later', type: 'lesson' });
  appendFileSync(file, result(prime.id, { results: [doc('d1', 'First doc')] }) + '\n' + write.line.slice(0, 40));
  let events = await ds.getKnowledge('sess-1');
  assert.deepEqual(events.map((e) => [e.kind, !!e.pending, e.docs.length]), [['primed', false, 1]], 'the half-written line waits');
  // Only what was appended is read: the one line that is now whole, not the
  // two before it again.
  appendFileSync(file, write.line.slice(40) + '\n');
  let parsed: number;
  [events, parsed] = await parsesDuring(() => ds.getKnowledge('sess-1'));
  assert.deepEqual(events.map((e) => e.kind), ['primed', 'wrote']);
  assert.equal(parsed, 1);
  [events, parsed] = await parsesDuring(() => ds.getKnowledge('sess-1'));
  assert.equal(parsed, 0, 'an unchanged file is not read at all');
  assert.equal(events.length, 2);
  assert.deepEqual(await ds.getKnowledge('nobody'), []);
  await ds.close();
});

await test('a file rewritten in place is read again from the top', async () => {
  const ds = new LocalClaudeDataSource(root);
  const before = (await ds.getKnowledge('sess-1')).length;
  assert.equal(before, 2);
  // What /compact does: the same file, different content, and longer.
  const read = use(`${T}get_memory`, { memory_id: 'd5' });
  writeFileSync(file, [head, say('compacted '.repeat(400)), read.line, result(read.id, doc('d5', 'After the rewrite'))].join('\n') + '\n');
  const events = await ds.getKnowledge('sess-1');
  assert.deepEqual(events.map((e) => e.docs[0].title), ['After the rewrite']);
  await ds.close();
});

// ---- the switch -------------------------------------------------------------

function room(name: string, mcp?: Record<string, unknown>): string {
  const cwd = path.join(dir, name);
  mkdirSync(cwd, { recursive: true });
  if (mcp) writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: mcp }));
  return cwd;
}
writeFileSync(claudeJson, '{}');
const billing = room('billing-api', { cognivio: { type: 'http', url: 'https://kb.example/mcp', headers: { Authorization: 'Bearer ak_test_key' } } });
const bare = room('no-connector');

await test('nothing is read until the room’s sheet is switched on, and nothing again once it is off', async () => {
  assert.equal(knowledgeOn(billing), false);
  let asked = 0;
  const source = { getKnowledge: async () => (asked++, [{ id: 't1', ts: null, kind: 'read' as const, docs: [{ id: 'd1', title: 'A doc' }] }]) };
  assert.deepEqual(await sessionKnowledge(source, 'sess-1', billing), []);
  assert.equal(asked, 0, 'no transcript is read while it is off');

  assert.equal(setKnowledgeOn(billing, true), null);
  assert.equal(knowledgeOn(billing), true);
  assert.equal(knowledgeOn(bare), false, 'the switch is per room');
  assert.equal((await sessionKnowledge(source, 'sess-1', billing)).length, 1);
  assert.equal(asked, 1);
  assert.deepEqual(await sessionKnowledge(source, 'sess-1', bare), []);
  assert.equal(asked, 1);

  // Off does not need the connector's row: a room whose connector is gone
  // can still be switched off, and leaves nothing behind in the file.
  assert.equal(setKnowledgeOn(bare, true), null);
  assert.equal(setKnowledgeOn(bare, false), null);
  assert.equal(knowledgeOn(bare), false);
  assert.equal(bare in (JSON.parse(readFileSync(process.env.AIROOM_CONNECTORS_FILE!, 'utf8')).rooms ?? {}), false);
});

await test('the switch and the room’s other connector choices do not overwrite each other', () => {
  assert.equal(setAdopted(billing, 'github', true), null);
  assert.equal(knowledgeOn(billing), true);
  assert.equal(setKnowledgeOn(billing, false), null);
  assert.deepEqual([...adoptedIn(billing)], ['github']);
  assert.equal(setKnowledgeOn(billing, true), null);
  assert.equal(setAdopted(billing, 'github', false), null);
  assert.equal(knowledgeOn(billing), true);
});

await test('only a knowledge base’s row carries the switch', async () => {
  const engine = {
    activeRuns: () => [],
    send: async () => {},
    interrupt: () => true,
    respondPermission: () => true,
    close: async () => {},
    mcpStatus: async () => [
      { name: 'cognivio', status: 'connected', scope: 'project' },
      { name: 'github', status: 'connected', scope: 'project' },
    ],
  };
  const rooms: Array<{ roomId: string; connectors: Array<{ name: string; knowledge?: boolean }> }> = [];
  const service = new ConnectorsService(engine as never, (r) => rooms.push(r));
  service.list(billing);
  for (let i = 0; i < 50 && !rooms.length; i++) await new Promise((r) => setTimeout(r, 10));
  const row = (name: string) => rooms[rooms.length - 1].connectors.find((c) => c.name === name)!;
  assert.equal(row('cognivio').knowledge, true);
  assert.equal('knowledge' in row('github'), false);
  setKnowledgeOn(billing, false);
  service.reannotate(billing);
  assert.equal(row('cognivio').knowledge, false);
  setKnowledgeOn(billing, true);
});

rmSync(dir, { recursive: true, force: true });

console.log(`knowledge-test: ${passed} passed, ${failures.length} failed`);
for (const [name, err] of failures) console.error(`  ✗ ${name}\n    ${err.message}`);
if (failures.length) process.exit(1);
