/**
 * Sharing playbooks with a team, proven against a stand-in server.
 *
 *   npx tsx scripts/playbook-share-test.ts
 *
 * What is on trial: that a room with no Cognivio connector makes no request,
 * that the address and key come only from the room's own connector, that only
 * the card travels, and that a teammate's card arrives as a checked proposal.
 * The stand-in listens on 127.0.0.1; nothing here leaves the machine.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Playbook } from '../../shared/types';

const dir = mkdtempSync(path.join(os.tmpdir(), 'airoom-share-'));
const claudeJson = path.join(dir, 'claude.json');
process.env.AIROOM_CLAUDE_JSON = claudeJson;
process.env.AIROOM_CONNECTORS_FILE = path.join(dir, 'connectors.json');
const { connectionFor, fromDoc, getTeamCard, projectTag, shareCard, SHARE_TAG, teamCards, toDoc } = await import('../src/playbook/share');

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

// ---- the stand-in Cognivio ---------------------------------------------------

interface Doc {
  id: string;
  title: string;
  content: string;
  tags: string[];
  type: string;
  status: string;
  updatedAt: string;
}
const KEY = 'ak_test_key';
const seen: Array<{ method: string; url: string; auth: string }> = [];
let teams = [{ id: 't1', name: 'Platform' }];
let review = false;
const docs = new Map<string, Doc[]>();

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const url = req.url ?? '';
    seen.push({ method: req.method ?? '', url, auth: String(req.headers.authorization ?? '') });
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { detail: 'Invalid API key' });
    if (url === '/api/v1/teams') return json(200, teams);
    const list = /^\/api\/v1\/teams\/([^/]+)\/memories(\?.*)?$/.exec(url);
    if (list && req.method === 'GET') {
      const tag = new URLSearchParams(list[2]?.slice(1)).get('tag');
      const rows = (docs.get(list[1]) ?? []).filter((d) => d.status !== 'draft' && (!tag || d.tags.includes(tag)));
      return json(200, { memories: rows.map(({ content: _c, ...row }) => row) });
    }
    if (list && req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Omit<Doc, 'id' | 'status' | 'updatedAt'>;
      const mine = docs.get(list[1]) ?? [];
      const doc: Doc = { ...body, id: `d${mine.length + 1}`, status: review ? 'draft' : 'active', updatedAt: '2026-01-02T00:00:00Z' };
      const at = mine.findIndex((d) => d.title === body.title);
      if (at >= 0) mine[at] = { ...doc, id: mine[at].id };
      else mine.push(doc);
      docs.set(list[1], mine);
      return json(201, at >= 0 ? mine[at] : doc);
    }
    const one = /^\/api\/v1\/memories\/([^/]+)$/.exec(url);
    if (one) {
      const doc = [...docs.values()].flat().find((d) => d.id === one[1]);
      return doc ? json(200, doc) : json(404, { detail: 'Not found' });
    }
    json(404, { detail: 'Not found' });
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// ---- rooms -------------------------------------------------------------------

function room(name: string, mcp?: Record<string, unknown>): string {
  const cwd = path.join(dir, name);
  mkdirSync(cwd, { recursive: true });
  if (mcp) writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: mcp }));
  return cwd;
}
const hosted = (key = KEY) => ({ cognivio: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: `Bearer ${key}` } } });
const setClaude = (j: unknown) => writeFileSync(claudeJson, JSON.stringify(j));
setClaude({});

const billing = room('billing-api', hosted());
const bare = room('no-connector', { github: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: `Bearer ${KEY}` } } });

const card = (roomId: string, over: Partial<Playbook> = {}): Playbook => ({
  id: 'pb-1',
  roomId,
  name: 'Add a CSV export',
  goal: 'Add a CSV export next to the JSON one.',
  inputs: [{ key: 'endpoint', label: 'Endpoint', example: 'reports' }],
  rules: [{ id: 'r1', text: 'Never write the header row when there are no rows.', from: 'session', at: '2026-01-01T00:00:00Z' }],
  steps: [{ text: 'Read the endpoint.' }, { text: 'Show the plan.', pause: true }],
  checks: ['npm test passes'],
  output: 'A summary of the change.',
  allow: ['Bash(npm test:*)', 'Edit'],
  mode: 'bypassPermissions' as Playbook['mode'],
  model: 'some-model',
  source: { sessionId: 'sess-private', messages: 7, approvals: 12, corrections: 2 },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  runs: [{ id: 'run-1', sessionId: 'sess-run', startedAt: '2026-01-01T00:00:00Z', state: 'done', inputs: { endpoint: 'secret-endpoint' }, messages: 1, approvals: 0, rulesAdded: 0, costUsd: 1, summary: 'private summary' }],
  ...over,
});

// ---- the connection ----------------------------------------------------------

await test('the connection is the room’s own Cognivio connector, and nothing else', () => {
  assert.deepEqual(connectionFor(billing), { name: 'cognivio', api: `${origin}/api/v1`, key: KEY });
  assert.equal(connectionFor(bare), null, 'another connector with a bearer key is not Cognivio');
  assert.equal(connectionFor(room('empty')), null);
  assert.equal(connectionFor(room('no-key', { cognivio: { type: 'http', url: `${origin}/mcp` } })), null);
  assert.equal(connectionFor(room('not-http', { cognivio: { type: 'http', url: 'ftp://x/mcp', headers: { Authorization: `Bearer ${KEY}` } } })), null);
});

await test('the local connector and ${VAR} keys are read the way Claude Code reads them', () => {
  const stdio = room('stdio', { cognivio: { command: 'uvx', args: ['cognivio-mcp'], env: { KB_BASE_URL: origin, KB_API_KEY: KEY } } });
  assert.deepEqual(connectionFor(stdio), { name: 'cognivio', api: `${origin}/api/v1`, key: KEY });
  process.env.SHARE_TEST_KEY = 'ak_from_env';
  const viaEnv = room('via-env', { 'team-cognivio': { url: `${origin}/kb/mcp/`, headers: { authorization: 'Bearer ${SHARE_TEST_KEY}' } } });
  assert.deepEqual(connectionFor(viaEnv), { name: 'team-cognivio', api: `${origin}/kb/api/v1`, key: 'ak_from_env' });
  delete process.env.SHARE_TEST_KEY;
  assert.equal(connectionFor(viaEnv), null, 'an unset variable is no key');
});

await test('a connector switched off for the project is not used', () => {
  const user = room('user-scope');
  setClaude({ mcpServers: hosted() });
  assert.ok(connectionFor(user));
  setClaude({ mcpServers: hosted(), projects: { [user]: { disabledMcpServers: ['cognivio'] } } });
  assert.equal(connectionFor(user), null);
  setClaude({ projects: { [billing]: { disabledMcpjsonServers: ['cognivio'] } } });
  assert.equal(connectionFor(billing), null);
  setClaude({ projects: { [user]: { mcpServers: hosted() } } });
  assert.ok(connectionFor(user), 'a connector added for this project only');
  setClaude({});
});

// ---- the document ------------------------------------------------------------

await test('only the card travels', () => {
  const doc = toDoc(card(billing));
  assert.equal(doc.title, 'Playbook: Add a CSV export');
  for (const secret of ['sess-private', 'sess-run', 'secret-endpoint', 'private summary', 'bypassPermissions', 'some-model', dir])
    assert.ok(!doc.content.includes(secret), `"${secret}" must not be shared`);
  assert.ok(doc.content.includes('## Rules\n\n- Never write the header row'));
  assert.ok(doc.content.includes('2. Show the plan. (stop here for review)'));
});

await test('a card reads back as an unsaved proposal with a checked allowlist', () => {
  const sent = card(billing, { allow: ['Bash(npm test:*)', 'Edit', 'Bash(rm -rf:*)', 'Bash', 'Bash(sudo make install)'], rules: [{ id: 'r1', text: 'Keep ``` fences intact.', from: 'run', runId: 'run-1', at: 'x' }] });
  const back = fromDoc(toDoc(sent).content, '/other/machine/billing-api', '2026-02-02T00:00:00Z');
  assert.ok(back.ok);
  if (!back.ok) return;
  const d = back.draft;
  assert.equal(d.id, '');
  assert.equal(d.roomId, '/other/machine/billing-api');
  assert.deepEqual(d.allow, ['Bash(npm test:*)', 'Edit']);
  assert.deepEqual(d.rules, [{ id: 'r1', text: 'Keep ``` fences intact.', from: 'session', at: '2026-02-02T00:00:00Z' }]);
  assert.deepEqual(d.steps, [{ text: 'Read the endpoint.' }, { text: 'Show the plan.', pause: true }]);
  assert.deepEqual(d.inputs, sent.inputs);
  assert.deepEqual(d.source, { sessionId: '', messages: 7, approvals: 12, corrections: 2 });
  assert.deepEqual(d.runs, []);
  assert.equal(d.mode, undefined);
  assert.equal(d.model, undefined);
});

await test('a document that is not a card says so', () => {
  assert.deepEqual(fromDoc('# Just notes', billing, 'now'), { ok: false, error: 'That document has no airoom card in it.' });
  assert.equal(fromDoc('```airoom-playbook\n{ not json\n```', billing, 'now').ok, false);
  assert.equal(fromDoc('```airoom-playbook\n{"v":2,"name":"x"}\n```', billing, 'now').ok, false);
  assert.equal(fromDoc('```airoom-playbook\n{"v":1,"name":""}\n```', billing, 'now').ok, false);
});

// ---- the calls ---------------------------------------------------------------

await test('a room with no Cognivio connector makes no request', async () => {
  seen.length = 0;
  const r = await shareCard(card(bare));
  assert.equal(r.ok, false);
  assert.match(r.text, /no Cognivio connector/);
  assert.deepEqual(await teamCards([bare, room('empty')], []), { rooms: [], items: [] });
  assert.match((await getTeamCard(bare, 'd1', 'now')).error ?? '', /no Cognivio connector/);
  assert.equal(seen.length, 0);
});

await test('sharing writes one document to the team, and sharing again updates it', async () => {
  seen.length = 0;
  const r = await shareCard(card(billing));
  assert.deepEqual(r, { ok: true, text: '"Add a CSV export" is shared with Platform.' });
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ['GET /api/v1/teams', 'POST /api/v1/teams/t1/memories']);
  assert.ok(seen.every((s) => s.auth === `Bearer ${KEY}`));
  const doc = docs.get('t1')![0];
  assert.equal(doc.type, 'playbook');
  assert.deepEqual(doc.tags, [SHARE_TAG, projectTag(billing)]);
  assert.equal(projectTag('/Users/someone/Code/Billing API'), 'airoom-project-billing-api');
  await shareCard(card(billing, { goal: 'A better goal.' }));
  assert.equal(docs.get('t1')!.length, 1);
  assert.ok(docs.get('t1')![0].content.includes('A better goal.'));
});

await test('with several teams the one named after the project is used, and no match is refused', async () => {
  teams = [{ id: 't1', name: 'Platform' }, { id: 't2', name: 'Billing-API' }];
  const r = await shareCard(card(billing, { name: 'Second card' }));
  assert.equal(r.text, '"Second card" is shared with Billing-API.');
  assert.equal(docs.get('t2')!.length, 1);
  teams = [{ id: 't1', name: 'Platform' }, { id: 't3', name: 'Web' }];
  const no = await shareCard(card(billing, { name: 'Third card' }));
  assert.equal(no.ok, false);
  assert.match(no.text, /reaches 2 teams and none is named "billing-api"/);
  teams = [{ id: 't1', name: 'Platform' }];
});

await test('a team that reviews writes is said to', async () => {
  review = true;
  const r = await shareCard(card(billing, { name: 'Held card' }));
  assert.ok(r.ok);
  assert.match(r.text, /once approved/);
  review = false;
});

await test('the team’s cards are offered per project, minus the ones already here', async () => {
  const web = room('web', hosted());
  await shareCard(card(web, { name: 'Ship the site' }));
  teams = [{ id: 't1', name: 'Platform' }, { id: 't2', name: 'Billing-API' }];
  seen.length = 0;
  const mine = [card(billing)];
  const r = await teamCards([billing, web, bare], mine);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.rooms, [billing, web], 'the rooms with somewhere to share to');
  assert.deepEqual(
    r.items.map((i) => `${path.basename(i.roomId)}: ${i.name} (${i.team})`).sort(),
    ['billing-api: Second card (Billing-API)', 'web: Ship the site (Platform)'],
    'not the card this machine has, not the held draft, not another project’s',
  );
  assert.equal(seen.filter((s) => s.url === '/api/v1/teams').length, 1, 'two rooms on one connection ask once');
  teams = [{ id: 't1', name: 'Platform' }];
});

await test('getting a card returns a proposal for the room, saved by nobody', async () => {
  const offered = (await teamCards([billing], [])).items.find((i) => i.name === 'Add a CSV export')!;
  const r = await getTeamCard(billing, offered.docId, '2026-03-03T00:00:00Z');
  assert.equal(r.error, undefined);
  assert.equal(r.draft!.id, '');
  assert.equal(r.draft!.roomId, billing);
  assert.equal(r.draft!.goal, 'A better goal.');
  assert.match((await getTeamCard(billing, 'nope', 'now')).error ?? '', /answered 404/);
});

await test('a refused key and an unreachable server are reported, not thrown', async () => {
  const wrong = room('wrong-key', hosted('ak_wrong'));
  assert.match((await shareCard(card(wrong))).text, /did not accept the key in the "cognivio" connector/);
  assert.match((await teamCards([wrong], [])).error ?? '', /did not accept the key/);
  const gone = room('gone', { cognivio: { url: 'http://127.0.0.1:9/mcp', headers: { Authorization: `Bearer ${KEY}` } } });
  assert.equal((await shareCard(card(gone))).text, 'Could not reach 127.0.0.1:9.');
});

await new Promise((r) => server.close(r));
rmSync(dir, { recursive: true, force: true });

console.log(`playbook-share-test: ${passed} passed, ${failures.length} failed`);
for (const [name, err] of failures) console.error(`  ✗ ${name}\n    ${err.message}`);
if (failures.length) process.exit(1);
