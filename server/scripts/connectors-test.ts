/**
 * Connectors, proven without a runtime.
 *
 *   AIROOM_CLAUDE_JSON=<scratch> npx tsx scripts/connectors-test.ts
 *
 * The shape the office shows, the project's .mcp.json edits, the per-project
 * on/off choice written where Claude Code keeps it, and the cache's promise
 * that a room is only ever asked once at a time.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'airoom-cn-'));
const claudeJson = path.join(dir, 'claude.json');
writeFileSync(claudeJson, JSON.stringify({ projects: {}, mcpServers: { pencil: { command: '/x/pencil', type: 'stdio' } }, other: 1 }));
process.env.AIROOM_CLAUDE_JSON = claudeJson;

process.env.AIROOM_CONNECTORS_FILE = path.join(dir, 'connectors.json');
const { addProjectServer, adoptedIn, ConnectorsService, projectChoice, projectServers, removeProjectServer, setAdopted, setProjectChoice, setSharedLoaded, sharedLoaded, toConnectors } = await import('../src/connectors');
import type { ActiveRun, AgentController, RawMcpStatus, SendOptions } from '../src/agent/AgentController';
import type { RunUpdate, RoomConnectors } from '../../shared/types';

let passed = 0;
const failures: Array<[string, Error]> = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push([name, e as Error]);
  }
}

await test('the runtime report becomes the office shape, secrets left behind', () => {
  const list = toConnectors([
    { name: 'github', status: 'connected', scope: 'project', config: { type: 'stdio', command: '/usr/local/bin/npx', args: ['-y', 'gh-mcp'], env: { TOKEN: 'secret' } }, tools: [{ name: 'list', annotations: { readOnly: true } }, { name: 'nuke', annotations: { destructive: true } }], serverInfo: { name: 'gh', version: '1.2' } },
    { name: 'slack', status: 'needs-auth', scope: 'claudeai', config: { type: 'claudeai-proxy', url: 'https://claude.ai/x' } },
    { name: 'db', status: 'failed', scope: 'user', error: 'ECONNREFUSED', config: { type: 'http', url: 'https://db.example/mcp', headers: { Authorization: 'Bearer x' } } },
    { name: 'airoom-team', status: 'connected', scope: 'dynamic' },
    { name: 'weird', status: 'whatever' },
  ]);
  assert.deepEqual(
    list.map((c) => [c.name, c.scope, c.status, c.transport]),
    [
      ['github', 'project', 'connected', 'stdio'],
      ['db', 'user', 'failed', 'http'],
      ['slack', 'claudeai', 'needs-auth', 'claudeai'],
      ['weird', 'unknown', 'failed', 'unknown'],
    ],
  );
  const gh = list[0];
  assert.equal(gh.target, 'npx -y gh-mcp');
  assert.equal(gh.version, '1.2');
  assert.deepEqual(gh.tools, [{ name: 'list', readOnly: true }, { name: 'nuke', destructive: true }]);
  assert.ok(!JSON.stringify(list).includes('secret'));
  assert.ok(!JSON.stringify(list).includes('Bearer'));
  assert.equal(list[1].error, 'ECONNREFUSED');
});

const room = path.join(dir, 'proj');
await test('adding a project connector writes .mcp.json and approves it for the room', () => {
  assert.equal(addProjectServer(room, { name: 'bad name!', transport: 'stdio', command: 'x' }), 'A connector name is letters, digits, dots, dashes or underscores.');
  assert.equal(addProjectServer(room, { name: 'gh', transport: 'stdio' }), 'A stdio connector needs a command.');
  assert.equal(addProjectServer(room, { name: 'gh', transport: 'http', url: 'ftp://x' }), 'An HTTP or SSE connector needs an http(s) url.');
  assert.equal(addProjectServer(room, { name: 'gh', transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { TOKEN: 't' } }), null);
  assert.equal(addProjectServer(room, { name: 'api', transport: 'http', url: 'https://api.example/mcp', headers: { Authorization: 'Bearer t' } }), null);
  assert.equal(addProjectServer(room, { name: 'gh', transport: 'stdio', command: 'x' }), '"gh" is already in this project\'s .mcp.json.');
  const on = JSON.parse(readFileSync(path.join(room, '.mcp.json'), 'utf8'));
  assert.deepEqual(on.mcpServers.gh, { type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { TOKEN: 't' } });
  assert.deepEqual(on.mcpServers.api, { type: 'http', url: 'https://api.example/mcp', headers: { Authorization: 'Bearer t' } });
  assert.equal(projectChoice(room, 'gh'), 'enabled');
  assert.deepEqual(Object.keys(projectServers(room)), ['gh', 'api']);
});

await test('the on/off choice lands in the runtime file, touching nothing else', () => {
  assert.equal(setProjectChoice(room, 'gh', false), null);
  assert.equal(projectChoice(room, 'gh'), 'disabled');
  assert.equal(projectChoice(room, 'api'), 'enabled');
  assert.equal(setProjectChoice(room, 'gh', true), null);
  assert.equal(projectChoice(room, 'gh'), 'enabled');
  const j = JSON.parse(readFileSync(claudeJson, 'utf8'));
  assert.equal(j.other, 1, 'unrelated keys survive');
  assert.deepEqual(j.mcpServers, { pencil: { command: '/x/pencil', type: 'stdio' } });
  assert.deepEqual(j.projects[room].enabledMcpjsonServers.sort(), ['api', 'gh']);
  assert.deepEqual(j.projects[room].disabledMcpjsonServers, []);
  assert.equal(projectChoice(room, 'never'), 'unset');
});

await test('removing only touches .mcp.json entries', () => {
  assert.equal(removeProjectServer(room, 'pencil'), '"pencil" is not in this project\'s .mcp.json — it comes from somewhere the office cannot edit.');
  assert.equal(removeProjectServer(room, 'api'), null);
  assert.deepEqual(Object.keys(projectServers(room)), ['gh']);
});

class FakeController implements AgentController {
  calls: string[] = [];
  answer: RawMcpStatus[] = [{ name: 'gh', status: 'connected', scope: 'project' }];
  activeRuns(): ActiveRun[] {
    return [];
  }
  async send(_o: SendOptions, _u: (u: RunUpdate) => void): Promise<void> {}
  interrupt(): boolean {
    return true;
  }
  respondPermission(): boolean {
    return true;
  }
  async close(): Promise<void> {}
  async mcpStatus(cwd: string): Promise<RawMcpStatus[]> {
    this.calls.push(cwd);
    await new Promise((r) => setTimeout(r, 10));
    return this.answer;
  }
}

await test('the cache asks once, answers "checking" meanwhile, and lists disabled project servers', async () => {
  const engine = new FakeController();
  const pushed: RoomConnectors[] = [];
  const svc = new ConnectorsService(engine, (r) => pushed.push(r));
  setProjectChoice(room, 'gh', false);
  assert.equal(addProjectServer(room, { name: 'sentry', transport: 'http', url: 'https://s.example/mcp' }), null);
  setProjectChoice(room, 'sentry', false);
  const first = svc.list(room);
  assert.equal(first.checking, true);
  assert.equal(first.checkedAt, null);
  svc.list(room); // a second ask while the first is out
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(engine.calls.length, 1, 'one runtime spawn per room at a time');
  const done = svc.get(room)!;
  assert.equal(done.checking, false);
  assert.ok(done.checkedAt);
  assert.deepEqual(
    done.connectors.map((c) => [c.name, c.status]),
    [
      ['gh', 'connected'],
      ['sentry', 'disabled'],
    ],
  );
  assert.equal(pushed.length, 1);
  // cached now
  assert.equal(svc.list(room).checking, false);
  assert.equal(engine.calls.length, 1);
  // a live run's report replaces it without a spawn
  svc.ingest(room, [{ name: 'gh', status: 'failed', scope: 'project', error: 'boom' }]);
  assert.equal(svc.get(room)!.connectors[0].status, 'failed');
  assert.equal(engine.calls.length, 1);
  assert.equal(pushed.length, 2);
  // refresh asks again
  svc.list(room, true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(engine.calls.length, 2);
});

await test('shared connectors are off the wall until turned on for the room; disabling is the runtime list', async () => {
  const engine = new FakeController();
  engine.answer = [{ name: 'pencil', status: 'connected', scope: 'user' }, { name: 'gh', status: 'connected', scope: 'project' }];
  const pushed: RoomConnectors[] = [];
  const svc = new ConnectorsService(engine, (r) => pushed.push(r));
  svc.list(room, true);
  await new Promise((r) => setTimeout(r, 40));
  const by = (n: string) => svc.get(room)!.connectors.find((c) => c.name === n)!;
  assert.equal(by('gh').onWall, true, 'an enabled project connector is on the wall');
  assert.equal(by('pencil').onWall, false, 'a shared one is not, until asked');
  assert.equal(by('pencil').loaded, true);
  // turn it on for this room only
  assert.equal(setAdopted(room, 'pencil', true), null);
  svc.reannotate(room);
  assert.equal(by('pencil').onWall, true);
  assert.deepEqual([...adoptedIn(room)], ['pencil']);
  assert.equal(engine.calls.length, 1, 'no spawn to change a wall');
  // off the wall again: runtime untouched
  setAdopted(room, 'pencil', false);
  svc.reannotate(room);
  assert.equal(by('pencil').onWall, false);
  assert.equal(sharedLoaded(room, 'pencil'), true);
  // disable it for the project: the runtime's own list
  assert.equal(setSharedLoaded(room, 'pencil', false), null);
  assert.equal(sharedLoaded(room, 'pencil'), false);
  const j = JSON.parse(readFileSync(claudeJson, 'utf8'));
  assert.deepEqual(j.projects[room].disabledMcpServers, ['pencil']);
  // the runtime then leaves it out of its report; the room still lists it, disabled
  engine.answer = [{ name: 'gh', status: 'connected', scope: 'project' }];
  svc.list(room, true);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(by('pencil') && [by('pencil').status, by('pencil').loaded, by('pencil').onWall], ['disabled', false, false]);
  assert.equal(setSharedLoaded(room, 'pencil', true), null);
  assert.deepEqual(JSON.parse(readFileSync(claudeJson, 'utf8')).projects[room].disabledMcpServers, []);
});

rmSync(dir, { recursive: true, force: true });
console.log(`connectors-test: ${passed} passed, ${failures.length} failed`);
for (const [name, err] of failures) console.error(`  ✗ ${name}\n    ${err.message}`);
if (failures.length) process.exit(1);
