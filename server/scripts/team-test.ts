/**
 * The team referee, proven without a model.
 *
 *   npm test   (tsx scripts/team-test.ts)
 *
 * A fake AgentController records every send; the tool handlers are called
 * directly, exactly as the MCP layer calls them. What is verified here is the
 * REFEREE — caps, gates, roles, persistence — which must hold no matter what
 * any model decides to do. The lead's judgement is the only thing not on
 * trial, because it is the one part that is allowed to be wrong.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TeamController, type TeamDeps } from '../src/team/TeamController';
import { runKeyFor, type ActiveRun, type AgentController, type SendOptions } from '../src/agent/AgentController';
import type { Handoff, RunUpdate, Team } from '../../shared/types';

class FakeController implements AgentController {
  sends: SendOptions[] = [];
  interrupted: string[] = [];
  updaters = new Map<string, (u: RunUpdate) => void>();
  /** sessions the referee should treat as mid-turn */
  busy = new Set<string>();

  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId);
  }

  activeRuns(): ActiveRun[] {
    return [];
  }
  async send(opts: SendOptions, onUpdate: (u: RunUpdate) => void): Promise<void> {
    this.sends.push(opts);
    this.updaters.set(runKeyFor(opts), onUpdate);
  }
  interrupt(runKey: string): boolean {
    this.interrupted.push(runKey);
    return true;
  }
  respondPermission(): boolean {
    return true;
  }
  async close(): Promise<void> {}

  /** simulate the run resolving its session id / finishing a turn */
  emit(key: string, u: Partial<RunUpdate> & { phase: RunUpdate['phase'] }) {
    const fn = this.updaters.get(key);
    assert.ok(fn, `no updater registered for ${key}`);
    fn({ runKey: key, roomId: '/tmp/x', sessionId: null, ...u });
  }
  lastSend(): SendOptions {
    assert.ok(this.sends.length, 'expected a send');
    return this.sends[this.sends.length - 1];
  }
}

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

const dir = mkdtempSync(path.join(os.tmpdir(), 'airoom-team-test-'));
const ROOM = '/tmp/scratch-project';

function rig(fileName: string, extra: Partial<TeamDeps> = {}) {
  const fake = new FakeController();
  const handoffs: Handoff[] = [];
  let changes = 0;
  const tc = new TeamController({
    controller: fake,
    onUpdate: () => {},
    onHandoff: (h) => handoffs.push(h),
    onTeamsChanged: () => changes++,
    file: path.join(dir, fileName),
    // This fake never starts follow-up turns, so the settle window has
    // nothing to wait for: judge at once (team-reliability-test waits).
    defer: (fn) => fn(),
    ...extra,
  });
  return { fake, tc, handoffs, changed: () => changes };
}

/** The reviewer signs off on its lane's live task. The gate wants this before
 *  any close — every test that finishes work has to earn it the same way. */
async function approve(tc: TeamController, id: string, reviewer = 'reviewer') {
  await tc.handlersFor(id, reviewer).give_verdict({ verdict: 'approve', notes: 'ran the tests; green' });
}

function hire(tc: TeamController, autonomy: Team['autonomy'], roundCap = 2) {
  const r = tc.hire({ roomId: ROOM, task: 'Add a --version flag', autonomy, roundCap });
  assert.equal(r.ok, true, r.error);
  return r.teamId!;
}

console.log('\nspawning and identity');

await test('hiring seats all three at once, each with its own role and tools', async () => {
  // The bench should be full the moment you hire: staffing lazily made the
  // team trickle in over minutes and read as the feature failing.
  const { fake, tc } = rig('a.json');
  const id = hire(tc, 'auto_capped');
  assert.equal(fake.sends.length, 3);
  const by = (role: string) => fake.sends.find((x) => x.spawnTag === `${id}:${role}`)!;

  for (const role of ['lead', 'builder', 'reviewer']) {
    const s = by(role);
    assert.ok(s, `${role} was not hired`);
    assert.equal(s.roomId, ROOM);
    assert.ok(s.mcpServers && 'airoom-team' in s.mcpServers, `${role} must carry the team MCP server`);
    assert.match(s.systemPromptAppend ?? '', new RegExp(role.toUpperCase()));
    assert.deepEqual(s.autoAllowToolPrefixes, ['mcp__airoom-team__']);
    assert.match(s.text, /Add a --version flag/, `${role} should know the task`);
  }
  assert.ok(by('lead').extraDisallowedTools?.includes('Edit'), 'the lead does not edit files');
  assert.ok(by('reviewer').extraDisallowedTools?.includes('Edit'), 'the reviewer does not edit files');
  assert.deepEqual(by('builder').extraDisallowedTools, [], 'the builder is the single writer');
});

await test('the two who are waiting are told, firmly, not to start', async () => {
  const { fake, tc } = rig('a2.json');
  const id = hire(tc, 'auto_capped');
  for (const role of ['builder', 'reviewer']) {
    const s = fake.sends.find((x) => x.spawnTag === `${id}:${role}`)!;
    assert.match(s.text, /DO NOT START YET/);
    assert.match(s.text, /wait/i);
  }
  // …and being hired early must not count as an assignment, or the first real
  // one would already be a "fix round".
  assert.equal(tc.list()[0].roundsUsed, 0);
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'first pass' });
  assert.equal(tc.list()[0].roundsUsed, 0, 'the first real assignment is not a fix round');
});

await test('concurrent spawns in one room get distinct run keys', () => {
  const a = runKeyFor({ roomId: ROOM, spawnTag: 't:lead' });
  const b = runKeyFor({ roomId: ROOM, spawnTag: 't:builder' });
  const plain = runKeyFor({ roomId: ROOM });
  assert.notEqual(a, b);
  assert.equal(plain, `spawn:${ROOM}`); // the ghost-desk key the web matches on
});

await test('a resolved session id becomes the robot mapping', async () => {
  const { fake, tc } = rig('b.json');
  const id = hire(tc, 'auto_capped');
  fake.emit(`spawn:${ROOM}#${id}:lead`, { phase: 'started', sessionId: 'sess-lead-1' });
  assert.deepEqual(tc.memberOf('sess-lead-1'), { id, role: 'lead' });
  assert.equal(tc.list()[0].members.find((m) => m.role === 'lead')?.sessionId, 'sess-lead-1');
});

console.log('\nthe build → review → fix loop (auto_capped)');

await test('assign builder delivers a framed message and the builder may write', async () => {
  const { fake, tc, handoffs } = rig('c.json');
  const id = hire(tc, 'auto_capped');
  const out = await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'Implement it in cli.ts' });
  assert.match(out, /Delivered to Builder/);
  const s = fake.lastSend();
  assert.equal(s.spawnTag, `${id}:builder`);
  assert.match(s.text, /^\[airoom team — from the lead\]/);
  assert.deepEqual(s.extraDisallowedTools, [], 'the builder is the single writer');
  assert.match(s.systemPromptAppend ?? '', /BUILDER/);
  assert.equal(handoffs.filter((h) => h.kind === 'assign' && h.to === 'builder').length, 1);
});

await test('builder report and reviewer verdict both route to the lead', async () => {
  const { fake, tc } = rig('d.json');
  const id = hire(tc, 'auto_capped');
  const lead = tc.handlersFor(id, 'lead');
  await lead.assign({ role: 'builder', instructions: 'x' });
  await tc.handlersFor(id, 'builder').report_result({ summary: 'Done, touched cli.ts', status: 'done' });
  assert.match(fake.lastSend().text, /from Builder/);
  assert.equal(fake.lastSend().spawnTag, `${id}:lead`);
  await lead.assign({ role: 'reviewer', instructions: 'Review the diff' });
  assert.match(fake.lastSend().systemPromptAppend ?? '', /REVIEWER/);
  assert.ok(fake.lastSend().extraDisallowedTools?.includes('Write'), 'the reviewer cannot write');
  await tc.handlersFor(id, 'reviewer').give_verdict({ verdict: 'request_changes', notes: 'cli.ts:12 breaks --help' });
  assert.match(fake.lastSend().text, /Verdict: request_changes/);
});

await test('fix rounds are counted, and the cap parks the assignment', async () => {
  const { fake, tc } = rig('e.json');
  const id = hire(tc, 'auto_capped', 2);
  const lead = tc.handlersFor(id, 'lead');
  await lead.assign({ role: 'builder', instructions: 'build' }); // initial
  await lead.assign({ role: 'builder', instructions: 'fix 1' });
  await lead.assign({ role: 'builder', instructions: 'fix 2' });
  assert.equal(tc.list()[0].roundsUsed, 2);
  const before = fake.sends.length;
  const out = await lead.assign({ role: 'builder', instructions: 'fix 3' });
  assert.match(out, /PARKED/);
  assert.equal(fake.sends.length, before, 'a parked assignment must not reach the builder');
  const team = tc.list()[0];
  assert.equal(team.state, 'awaiting_human');
  assert.match(team.parkedReason ?? '', /cap/i);
});

await test('Continue releases the parked assignment, once', async () => {
  const { fake, tc } = rig('f.json');
  const id = hire(tc, 'auto_capped', 0); // cap 0: the very first FIX parks
  const lead = tc.handlersFor(id, 'lead');
  await lead.assign({ role: 'builder', instructions: 'build' });
  await lead.assign({ role: 'builder', instructions: 'fix' });
  assert.equal(tc.list()[0].state, 'awaiting_human');
  assert.equal(tc.continue_(id), true);
  assert.match(fake.lastSend().text, /fix/);
  assert.equal(tc.list()[0].state, 'working');
  assert.equal(tc.continue_(id), false, 'nothing left to continue');
});

await test('reviewer assignments are never fix rounds', async () => {
  const { tc } = rig('g.json');
  const id = hire(tc, 'auto_capped', 0);
  const lead = tc.handlersFor(id, 'lead');
  await lead.assign({ role: 'builder', instructions: 'build' });
  await lead.assign({ role: 'reviewer', instructions: 'review' });
  await lead.assign({ role: 'reviewer', instructions: 'review again' });
  assert.equal(tc.list()[0].roundsUsed, 0);
  assert.equal(tc.list()[0].state, 'working');
});

console.log('\nautonomy modes');

await test('gated: every assignment parks until the human continues', async () => {
  const { fake, tc } = rig('h.json');
  const id = hire(tc, 'gated');
  const lead = tc.handlersFor(id, 'lead');
  const out = await lead.assign({ role: 'builder', instructions: 'build it' });
  assert.match(out, /PARKED/);
  assert.equal(tc.list()[0].state, 'awaiting_human');
  const before = fake.sends.length;
  tc.continue_(id);
  assert.equal(fake.sends.length, before + 1);
  assert.match(fake.lastSend().text, /build it/);
});

await test('auto: no cap ever parks it', async () => {
  const { tc } = rig('i.json');
  const id = hire(tc, 'auto', 1);
  const lead = tc.handlersFor(id, 'lead');
  for (const step of ['build', 'fix 1', 'fix 2', 'fix 3', 'fix 4'])
    assert.match(await lead.assign({ role: 'builder', instructions: step }), /Delivered/);
  assert.equal(tc.list()[0].state, 'working');
});

console.log('\nasking, finishing, stopping');

await test('ask_human parks the team with the question on display', async () => {
  const { tc, handoffs } = rig('j.json');
  const id = hire(tc, 'auto');
  await tc.handlersFor(id, 'lead').ask_human({ question: 'Ship with or without telemetry?' });
  const team = tc.list()[0];
  assert.equal(team.state, 'awaiting_human');
  assert.match(team.parkedReason ?? '', /telemetry/);
  assert.ok(handoffs.some((h) => h.kind === 'question' && h.to === 'human'));
});

await test('finish records the summary and closes the team', async () => {
  const { tc } = rig('k.json');
  const id = hire(tc, 'auto');
  await approve(tc, id);
  await tc.handlersFor(id, 'lead').finish({ summary: 'Flag shipped; reviewer approved.' });
  const team = tc.list()[0];
  assert.equal(team.state, 'done');
  assert.match(team.doneSummary ?? '', /approved/);
  // Finishing closes the team but does not lock it: see the reopen test below.
  const out = await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'more' });
  assert.match(out, /Delivered to Builder/);
});

await test('stop interrupts every member and refuses further routing', async () => {
  const { fake, tc } = rig('l.json');
  const id = hire(tc, 'auto');
  fake.emit(`spawn:${ROOM}#${id}:lead`, { phase: 'started', sessionId: 'sess-lead-9' });
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'x' });
  tc.stop(id);
  assert.ok(fake.interrupted.includes('sess-lead-9'), 'known sessions interrupt by session id');
  assert.ok(
    fake.interrupted.includes(`spawn:${ROOM}#${id}:builder`),
    'unresolved members interrupt by their spawn slot',
  );
  assert.equal(tc.list()[0].state, 'stopped');
  assert.match(await tc.handlersFor(id, 'builder').report_result({ summary: 'x', status: 'done' }), /no longer running/);
});

await test('one active team per room; a stopped one frees the slot', async () => {
  const { tc } = rig('m.json');
  const id = hire(tc, 'auto');
  assert.equal(tc.hire({ roomId: ROOM, task: 'another', autonomy: 'auto' }).ok, false);
  tc.stop(id);
  assert.equal(tc.hire({ roomId: ROOM, task: 'another', autonomy: 'auto' }).ok, true);
});

console.log('\nper-member standing instructions');

await test('each member carries only its own instructions, in its system prompt', async () => {
  const fake = new FakeController();
  const tc = new TeamController({
    controller: fake,
    onUpdate: () => {},
    onHandoff: () => {},
    onTeamsChanged: () => {},
    file: path.join(dir, 'notes1.json'),
  });
  const r = tc.hire({
    roomId: ROOM,
    task: 'Add a flag',
    autonomy: 'auto_capped',
    roleNotes: {
      lead: 'Break it into small pieces.',
      builder: 'No new dependencies.',
      reviewer: 'Be strict about error handling.',
    },
  });
  const id = r.teamId!;
  const by = (role: string) => fake.sends.find((x) => x.spawnTag === `${id}:${role}`)!.systemPromptAppend ?? '';

  assert.match(by('lead'), /Break it into small pieces/);
  assert.match(by('builder'), /No new dependencies/);
  assert.match(by('reviewer'), /Be strict about error handling/);
  // …and nobody sees anyone else's
  assert.equal(/No new dependencies/.test(by('lead')), false);
  assert.equal(/Break it into small pieces/.test(by('reviewer')), false);
});

await test('instructions come after the role guidance, and say they win', async () => {
  const fake = new FakeController();
  const tc = new TeamController({
    controller: fake, onUpdate: () => {}, onHandoff: () => {}, onTeamsChanged: () => {},
    file: path.join(dir, 'notes2.json'),
  });
  const id = tc.hire({ roomId: ROOM, task: 'x', autonomy: 'auto', roleNotes: { builder: 'Always run the linter.' } }).teamId!;
  const prompt = fake.sends.find((x) => x.spawnTag === `${id}:builder`)!.systemPromptAppend ?? '';
  assert.ok(prompt.indexOf('Always run the linter') > prompt.indexOf('single writer'), 'the human\'s note must come last');
  assert.match(prompt, /take precedence/);
});

await test('instructions survive a new task', async () => {
  const fake = new FakeController();
  const tc = new TeamController({
    controller: fake, onUpdate: () => {}, onHandoff: () => {}, onTeamsChanged: () => {},
    file: path.join(dir, 'notes3.json'),
  });
  const id = tc.hire({ roomId: ROOM, task: 'first', autonomy: 'auto', roleNotes: { reviewer: 'Check the tests actually run.' } }).teamId!;
  await approve(tc, id);
  await tc.handlersFor(id, 'lead').finish({ summary: 'done' });
  const before = fake.sends.length;
  tc.newTask(id, 'second job entirely');
  const prompt = fake.sends.slice(before).find((x) => x.spawnTag === `${id}:reviewer`)!.systemPromptAppend ?? '';
  assert.match(prompt, /Check the tests actually run/, 'standing instructions are not per-task');
});

await test('empty instructions are not stored at all', async () => {
  const fake = new FakeController();
  const tc = new TeamController({
    controller: fake, onUpdate: () => {}, onHandoff: () => {}, onTeamsChanged: () => {},
    file: path.join(dir, 'notes4.json'),
  });
  const id = tc.hire({ roomId: ROOM, task: 'x', autonomy: 'auto', roleNotes: { lead: '   ', builder: '' } }).teamId!;
  assert.equal(tc.list().find((t) => t.id === id)!.roleNotes, undefined);
  const prompt = fake.sends.find((x) => x.spawnTag === `${id}:lead`)!.systemPromptAppend ?? '';
  assert.equal(/take precedence/.test(prompt), false, 'no empty instruction block');
});

console.log('\nthe same team, the next job');

await test('a finished team takes a new task, resuming all three sessions', async () => {
  const { fake, tc } = rig('n1.json');
  const id = hire(tc, 'auto_capped');
  for (const role of ['lead', 'builder', 'reviewer'] as const)
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `sess-${role}` });
  await approve(tc, id);
  await tc.handlersFor(id, 'lead').finish({ summary: 'shipped' });
  assert.equal(tc.list()[0].state, 'done');

  const before = fake.sends.length;
  assert.deepEqual(tc.newTask(id, 'Now add a --quiet flag'), { ok: true });
  const sent = fake.sends.slice(before);
  assert.equal(sent.length, 3, 'all three are told about the new job');
  for (const role of ['lead', 'builder', 'reviewer'] as const) {
    const s = sent.find((x) => x.sessionId === `sess-${role}`);
    assert.ok(s, `${role} was not resumed`);
    assert.match(s.text, /--quiet flag/);
    assert.ok(s.mcpServers && 'airoom-team' in s.mcpServers, `${role} kept its tools`);
  }
  assert.match(sent.find((x) => x.sessionId === 'sess-lead')!.text, /already know this project/);
});

await test('the new task resets the round cap and the stale expectations', async () => {
  const { fake, tc } = rig('n2.json');
  const id = hire(tc, 'auto_capped', 2);
  const lead = tc.handlersFor(id, 'lead');
  await lead.assign({ role: 'builder', instructions: 'build' });
  await lead.assign({ role: 'builder', instructions: 'fix 1' });
  assert.equal(tc.list()[0].roundsUsed, 1);
  await approve(tc, id);
  await lead.finish({ summary: 'done' });

  tc.newTask(id, 'Next job please');
  const t = tc.list()[0];
  assert.equal(t.roundsUsed, 0, 'the cap is per job, not per team lifetime');
  assert.equal(t.state, 'working');
  assert.equal(t.tasksDone, 1);
  assert.equal(t.task, 'Next job please');
  assert.equal(t.doneSummary, undefined, 'last job\'s summary must not linger');
  // the first builder assignment of the NEW job is not a fix round
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'start' });
  assert.equal(tc.list()[0].roundsUsed, 0);
});

await test('the other two are told the last assignment is closed', async () => {
  const { fake, tc } = rig('n3.json');
  const id = hire(tc, 'auto_capped');
  await approve(tc, id);
  await tc.handlersFor(id, 'lead').finish({ summary: 'done' });
  const before = fake.sends.length;
  tc.newTask(id, 'Something else entirely');
  for (const role of ['builder', 'reviewer'] as const) {
    const s = fake.sends.slice(before).find((x) => x.spawnTag === `${id}:${role}`)!;
    assert.match(s.text, /NEW task/);
    assert.match(s.text, /finished and closed/);
  }
});

await test('a busy team QUEUES a second task rather than refusing it', async () => {
  // This used to be a refusal ("they are still working"). Hand a lead three
  // jobs in a row is the whole point of the board: a one-lane team works them
  // in order, and nobody has to sit and wait to type the next one.
  const { tc } = rig('n4.json');
  const id = hire(tc, 'auto_capped');
  assert.deepEqual(tc.newTask(id, 'do this too'), { ok: true });
  const board = tc.list()[0].tasks;
  assert.equal(board.length, 2);
  assert.equal(board[0].state, 'working');
  assert.equal(board[1].state, 'queued', 'the single lane is busy, so it waits');
});

await test('a stopped team can be restarted with new work', async () => {
  const { tc } = rig('n5.json');
  const id = hire(tc, 'auto_capped');
  tc.stop(id);
  assert.equal(tc.newTask(id, 'try again with this').ok, true);
  assert.equal(tc.list()[0].state, 'working');
});

await test('an empty new task is refused', async () => {
  const { tc } = rig('n6.json');
  const id = hire(tc, 'auto_capped');
  tc.stop(id);
  assert.equal(tc.newTask(id, '  ').ok, false);
  assert.equal(tc.list()[0].state, 'stopped');
});

await test('dismiss refuses while active, works when stopped', async () => {
  const { tc } = rig('n.json');
  const id = hire(tc, 'auto');
  assert.equal(tc.dismiss(id), false);
  tc.stop(id);
  assert.equal(tc.dismiss(id), true);
  assert.equal(tc.list().length, 0);
});

console.log('\nfailure modes');

await test('a worker that ends its turn silently is nudged once, then reported', async () => {
  const { fake, tc } = rig('o.json');
  const id = hire(tc, 'auto');
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'x' });
  const key = `spawn:${ROOM}#${id}:builder`;
  fake.emit(key, { phase: 'result', text: 'done' });
  assert.match(fake.lastSend().text, /report_result/, 'first silence earns a nudge');
  fake.emit(key, { phase: 'result', text: 'done' });
  const team = tc.list()[0];
  assert.equal(team.state, 'awaiting_human');
  assert.match(team.parkedReason ?? '', /quiet/);
});

await test('a dead member does not leave the lead waiting forever', async () => {
  // The bug this covers: the reviewer's run died, the team parked, the human
  // pressed Continue, and the lead was told "pick up where you left off" — so
  // it checked team_status, saw a report still outstanding, and waited for a
  // session that was never coming back.
  const { fake, tc } = rig('r1.json');
  const id = hire(tc, 'auto_capped');
  await tc.handlersFor(id, 'lead').assign({ role: 'reviewer', instructions: 'review it' });
  fake.emit(`spawn:${ROOM}#${id}:reviewer`, { phase: 'error', text: 'the run ended: error_during_execution', isError: true });

  const team = tc.list()[0];
  assert.equal(team.state, 'awaiting_human');
  assert.match(team.parkedReason ?? '', /error_during_execution/, 'the real reason must reach the human');

  // team_status must stop claiming someone owes a report
  const status = JSON.parse(await tc.handlersFor(id, 'lead').team_status({}));
  assert.match(String(status.waitingOn), /nobody/, `still waiting on ${status.waitingOn}`);

  // …and Continue must tell the lead what actually happened
  tc.continue_(id);
  const woken = fake.lastSend();
  assert.equal(woken.spawnTag, `${id}:lead`);
  assert.match(woken.text, /reviewer/);
  assert.match(woken.text, /NOT going to send the report/);
  assert.match(woken.text, /Assigning to "reviewer" again/, 'the lead needs to know re-assigning is the fix');
});

await test('re-assigning a failed member resumes its existing session', async () => {
  const { fake, tc } = rig('r2.json');
  const id = hire(tc, 'auto_capped');
  fake.emit(`spawn:${ROOM}#${id}:reviewer`, { phase: 'started', sessionId: 'sess-rev-1' });
  await tc.handlersFor(id, 'lead').assign({ role: 'reviewer', instructions: 'review' });
  fake.emit('sess-rev-1', { phase: 'error', text: 'boom', isError: true });
  tc.continue_(id);
  await tc.handlersFor(id, 'lead').assign({ role: 'reviewer', instructions: 'review again, smaller' });
  const retry = fake.lastSend();
  assert.equal(retry.sessionId, 'sess-rev-1', 'the conversation is resumed, not started over');
});

await test('the lead can hand over what it learned, so nobody re-explores', async () => {
  const { fake, tc } = rig('r3.json');
  const id = hire(tc, 'auto_capped');
  await tc.handlersFor(id, 'lead').assign({
    role: 'builder',
    instructions: 'Add the flag',
    context: 'Auth lives in app/services/auth.py. Tests: pytest -q.',
  });
  const sent = fake.lastSend().text;
  assert.match(sent, /Add the flag/);
  assert.match(sent, /app\/services\/auth\.py/, 'the lead\'s findings must reach the builder');
  assert.match(sent, /do not re-derive it/i);
});

await test('an assignment with no context is passed through unchanged', async () => {
  const { fake, tc } = rig('r4.json');
  const id = hire(tc, 'auto_capped');
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'Just do it' });
  const sent = fake.lastSend().text;
  assert.equal(sent, '[airoom team — from the lead]\nJust do it');
});

await test('a member erroring parks the team with the reason', async () => {
  const { fake, tc } = rig('p.json');
  const id = hire(tc, 'auto');
  fake.emit(`spawn:${ROOM}#${id}:lead`, { phase: 'error', text: 'API exploded', isError: true });
  const team = tc.list()[0];
  assert.equal(team.state, 'awaiting_human');
  assert.match(team.parkedReason ?? '', /API exploded/);
});

await test('member costs accumulate on the team meter', async () => {
  const { fake, tc } = rig('q.json');
  const id = hire(tc, 'auto');
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'x' });
  fake.emit(`spawn:${ROOM}#${id}:lead`, { phase: 'result', cost: 0.12 });
  await tc.handlersFor(id, 'builder').report_result({ summary: 'ok', status: 'done' });
  fake.emit(`spawn:${ROOM}#${id}:builder`, { phase: 'result', cost: 0.3 });
  assert.ok(Math.abs(tc.list()[0].costUsd - 0.42) < 1e-9);
});

console.log('\npersistence');

await test('a working team survives a restart as awaiting_human, resumable', async () => {
  const file = 'r.json';
  const { fake, tc } = rig(file);
  const id = hire(tc, 'auto_capped');
  fake.emit(`spawn:${ROOM}#${id}:lead`, { phase: 'started', sessionId: 'sess-lead-2' });
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'x' });

  const revived = rig(file); // same file, fresh controller = the restart
  const team = revived.tc.list().find((t) => t.id === id)!;
  assert.equal(team.state, 'awaiting_human');
  assert.match(team.parkedReason ?? '', /airoom was quit/);
  assert.equal(revived.tc.memberOf('sess-lead-2')?.role, 'lead');
  assert.ok(revived.tc.log(id).length >= 2, 'the handoff log survives');

  assert.equal(revived.tc.continue_(id), true);
  const s = revived.fake.lastSend();
  assert.equal(s.sessionId, 'sess-lead-2', 'resume goes to the SAME lead session');
  assert.match(s.text, /Continue/);
  assert.ok(s.mcpServers && 'airoom-team' in s.mcpServers, 'resumed runs carry the tools again');
});


console.log('\nsurviving a restart');

await test('a restart re-briefs the member who owes the report, not just the lead', async () => {
  const { fake, tc } = rig('restart-owes.json');
  const r = tc.hire({ roomId: ROOM, task: 'Ship the widget', autonomy: 'auto' as never });
  const id = r.teamId!;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `sess-${role}` });
  const lead = tc.handlersFor(id, 'lead');
  await lead.assign({ role: 'builder', instructions: 'build the widget' });
  const builder = tc.handlersFor(id, 'builder');
  await builder.report_result({ summary: 'built it', status: 'done' });
  await lead.assign({ role: 'reviewer', instructions: 'review the widget diff' });

  // ---- the process dies; a fresh controller loads the same file ----
  const fake2 = new FakeController();
  const tc2 = new TeamController({
    controller: fake2,
    onUpdate: () => {},
    onHandoff: () => {},
    onTeamsChanged: () => {},
    file: path.join(dir, 'restart-owes.json'),
  });
  const team = tc2.list().find((t) => t.id === id)!;
  assert.equal(team.state, 'awaiting_human');
  assert.match(team.parkedReason ?? '', /airoom was quit/);

  assert.ok(tc2.continue_(id), 'continue should succeed');
  const toReviewer = fake2.sends.find((x) => x.sessionId === 'sess-reviewer');
  assert.ok(toReviewer, 'the reviewer must be woken after the restart');
  assert.match(toReviewer!.text, /ended before you reported/);
  assert.match(toReviewer!.text, /review the widget diff/); // the assignment travels along
  assert.match(toReviewer!.text, /give_verdict/);
  const toLead = fake2.sends.find((x) => x.sessionId === 'sess-lead');
  assert.ok(toLead, 'the lead is told what is happening');
  assert.match(toLead!.text, /Reviewer has been reminded/);
  assert.ok(toReviewer!.mcpServers && 'airoom-team' in (toReviewer!.mcpServers as object), 'reviewer send carries team tools');
  assert.ok((toReviewer!.extraDisallowedTools ?? []).includes('Edit'), 'reviewer still cannot write');
});

await test('direct chat with a member gets its team equipment back', async () => {
  const { fake, tc } = rig('restart-equip.json');
  const r = tc.hire({ roomId: ROOM, task: 'Ship the gadget', autonomy: 'auto' as never });
  const id = r.teamId!;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `g-${role}` });

  const tc2 = new TeamController({
    controller: new FakeController(),
    onUpdate: () => {},
    onHandoff: () => {},
    onTeamsChanged: () => {},
    file: path.join(dir, 'restart-equip.json'),
  });
  const leadEq = tc2.directSendEquipment('g-lead');
  assert.ok(leadEq, 'lead session is recognised after the restart');
  assert.ok('airoom-team' in (leadEq!.mcpServers as object));
  assert.match(leadEq!.systemPromptAppend, /LEAD/);
  assert.ok(leadEq!.extraDisallowedTools.includes('Edit'), 'the lead cannot write');
  const builderEq = tc2.directSendEquipment('g-builder');
  assert.equal(builderEq!.extraDisallowedTools.length, 0, 'the builder keeps its editor');
  assert.equal(tc2.directSendEquipment('not-a-member'), null, 'strangers get nothing');
});

await test('a direct-driven run still feeds the team books', async () => {
  const { fake, tc } = rig('restart-books.json');
  const r = tc.hire({ roomId: ROOM, task: 'Polish the doohickey', autonomy: 'auto' as never });
  const id = r.teamId!;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `b-${role}` });
  const before = tc.list().find((t) => t.id === id)!.costUsd;
  const equip = tc.directSendEquipment('b-lead')!;
  equip.observe({ runKey: 'b-lead', roomId: ROOM, sessionId: 'b-lead', phase: 'result', cost: 1.25 });
  const after = tc.list().find((t) => t.id === id)!.costUsd;
  assert.ok(after - before >= 1.25, `cost should accrue through direct drives (${before} -> ${after})`);
});


console.log('\nstops are instructions, not accidents');

await test('stopping a worker mid-assignment parks the team instead of restarting the worker', async () => {
  const { fake, tc, handoffs } = rig('stop-worker.json');
  const id = tc.hire({ roomId: ROOM, task: 'Fix the flux capacitor', autonomy: 'auto' as never }).teamId!;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `st-${role}` });
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'do the thing' });
  const sendsBefore = fake.sends.length;

  // The human presses stop on the builder's run.
  fake.emit('st-builder', { phase: 'result', interrupted: true });

  const team = tc.list().find((t) => t.id === id)!;
  assert.equal(team.state, 'awaiting_human');
  assert.match(team.parkedReason ?? '', /stopped Builder/);
  assert.equal(fake.sends.length, sendsBefore, 'no nudge send — a stop must not restart the worker');
  assert.ok(handoffs.some((h) => /stopped by the human/.test(h.summary)), 'the log says what happened');

  // Continue re-briefs the stopped builder, assignment attached.
  assert.ok(tc.continue_(id));
  const rebrief = fake.sends.filter((x) => x.sessionId === 'st-builder').at(-1)!;
  assert.match(rebrief.text, /ended before you reported/);
  assert.match(rebrief.text, /do the thing/);
});

await test('a turn that merely fizzles still gets its one nudge', async () => {
  const { fake, tc } = rig('fizzle.json');
  const id = tc.hire({ roomId: ROOM, task: 'Polish the chrome', autonomy: 'auto' as never }).teamId!;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `fz-${role}` });
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'shine it up' });

  fake.emit('fz-builder', { phase: 'result' }); // ended, no report, NOT a stop
  const nudge = fake.sends.filter((x) => x.sessionId === 'fz-builder').at(-1)!;
  assert.match(nudge.text, /report_result/);
  assert.equal(tc.list().find((t) => t.id === id)!.state, 'working');
});

await test('stopping the lead while it holds the ball parks the team, not a silent hang', async () => {
  const { fake, tc } = rig('stop-lead.json');
  const id = tc.hire({ roomId: ROOM, task: 'Chart the roadmap', autonomy: 'auto' as never }).teamId!;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `sl-${role}` });

  fake.emit(`spawn:${ROOM}#${id}:lead`, { phase: 'result', interrupted: true });
  const team = tc.list().find((t) => t.id === id)!;
  assert.equal(team.state, 'awaiting_human');
  assert.match(team.parkedReason ?? '', /stopped the lead/);

  assert.ok(tc.continue_(id));
  const wake = fake.sends.filter((x) => x.sessionId === 'sl-lead').at(-1)!;
  assert.match(wake.text, /pressed Continue/);
});

await test('a stopped lead does NOT park while a worker still owes a report', async () => {
  const { fake, tc } = rig('stop-lead-waiting.json');
  const id = tc.hire({ roomId: ROOM, task: 'Build the bridge', autonomy: 'auto' as never }).teamId!;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `slw-${role}` });
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'lay the deck' });

  fake.emit(`spawn:${ROOM}#${id}:lead`, { phase: 'result', interrupted: true }); // lead idles while builder works — normal
  assert.equal(tc.list().find((t) => t.id === id)!.state, 'working');
  // …and the builder reporting brings the lead back on its own.
  await tc.handlersFor(id, 'builder').report_result({ summary: 'deck laid', status: 'done' });
  const back = fake.sends.filter((x) => x.sessionId === 'slw-lead').at(-1)!;
  assert.match(back.text, /from Builder/);
});

console.log('\nsettings that stick');

await test("changing a member's mode in its panel holds for the next team send", async () => {
  const { fake, tc } = rig('mode-override.json');
  const id = tc.hire({ roomId: ROOM, task: 'Refit the engine', autonomy: 'auto' as never, mode: 'default' as never }).teamId!;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `mo-${role}` });

  tc.noteMemberMode('mo-builder', 'acceptEdits' as never);
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'swap the manifold' });
  const toBuilder = fake.sends.filter((x) => x.sessionId === 'mo-builder').at(-1)!;
  assert.equal(toBuilder.mode, 'acceptEdits', "the builder keeps the human's mode");
  // …while the reviewer stays on the team default.
  await tc.handlersFor(id, 'builder').report_result({ summary: 'swapped', status: 'done' });
  await tc.handlersFor(id, 'lead').assign({ role: 'reviewer', instructions: 'check the welds' });
  const toReviewer = fake.sends.filter((x) => x.sessionId === 'mo-reviewer').at(-1)!;
  assert.equal(toReviewer.mode, 'default');
});

await test("a model picked in a member's panel holds for team sends, and never wipes on default", async () => {
  const { fake, tc } = rig('model-note.json');
  const id = tc.hire({ roomId: ROOM, task: 'Wax the lobby', autonomy: 'auto' as never, model: 'team-model' }).teamId!;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `mn-${role}` });

  tc.noteMemberModel('mn-lead', 'fable-5'); // the human picked it in the lead's panel
  tc.noteMemberModel('mn-lead', ''); // an untouched panel default must not wipe it
  await tc.handlersFor(id, 'builder').report_result({ summary: 'shiny', status: 'done' });
  const toLead = fake.sends.filter((x) => x.sessionId === 'mn-lead').at(-1)!;
  assert.equal(toLead.model, 'fable-5', "the lead keeps the human's model");
  // …and the builder still rides the team model.
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'buff it' });
  const toBuilder = fake.sends.filter((x) => x.sessionId === 'mn-builder').at(-1)!;
  assert.equal(toBuilder.model, 'team-model');
});

await test('the mode override survives a restart', async () => {
  const { fake, tc } = rig('mode-persist.json');
  const id = tc.hire({ roomId: ROOM, task: 'Paint the shed', autonomy: 'auto' as never }).teamId!;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `mp-${role}` });
  tc.noteMemberMode('mp-builder', 'acceptEdits' as never);

  const fake2 = new FakeController();
  const tc2 = new TeamController({
    controller: fake2,
    onUpdate: () => {},
    onHandoff: () => {},
    onTeamsChanged: () => {},
    file: path.join(dir, 'mode-persist.json'),
  });
  assert.ok(tc2.continue_(id)); // restart park → continue nudges the lead
  const anyToBuilder = () => fake2.sends.filter((x) => x.sessionId === 'mp-builder').at(-1);
  await tc2.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'second coat' });
  assert.equal(anyToBuilder()!.mode, 'acceptEdits', 'the override was persisted');
});


console.log('\na lead that stalls is caught');

await test('a tool-less lead turn gets one nudge, a second parks the team', async () => {
  const { fake, tc } = rig('lead-stall.json');
  const id = tc.hire({ roomId: ROOM, task: 'Sort the warehouse', autonomy: 'auto' as never }).teamId!;
  const leadKey = `spawn:${ROOM}#${id}:lead`;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `ls-${role}` });

  fake.emit(leadKey, { phase: 'result' }); // ended the kickoff turn with no tool call
  const nudge = fake.sends.at(-1)!;
  assert.equal(nudge.sessionId, 'ls-lead');
  assert.match(nudge.text, /without moving the team/);
  assert.equal(tc.list().find((t) => t.id === id)!.state, 'working');

  fake.emit('ls-lead', { phase: 'result' }); // stalled again
  const team = tc.list().find((t) => t.id === id)!;
  assert.equal(team.state, 'awaiting_human');
  assert.match(team.parkedReason ?? '', /stalled twice/);
});

await test('a lead ending a DIRECT chat turn is never nudged — the panel says it answered you', async () => {
  const { fake, tc } = rig('lead-direct.json');
  const id = tc.hire({ roomId: ROOM, task: 'Sweep the floors', autonomy: 'auto' as never }).teamId!;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `ld-${role}` });

  tc.noteDirectSend('ld-lead'); // the human said something in the lead's own chat
  const sends = fake.sends.length;
  fake.emit(`spawn:${ROOM}#${id}:lead`, { phase: 'result' }); // the reply ended, tool-less — fine
  assert.equal(fake.sends.length, sends, 'no nudge for a conversation');
  // Nothing else is in flight, so "working" would be a lie with nobody working.
  const team = tc.list().find((t) => t.id === id)!;
  assert.equal(team.state, 'awaiting_human');
  assert.match(team.parkedReason ?? '', /answered you/);
});


console.log('\nper-member hires');

await test('per-role mode and model choices ride every send to that member', async () => {
  const { fake, tc } = rig('role-overrides.json');
  const id = tc.hire({
    roomId: ROOM,
    task: 'Retile the roof',
    autonomy: 'auto' as never,
    mode: 'default' as never,
    model: 'team-model',
    roleModes: { builder: 'acceptEdits' as never },
    roleModels: { reviewer: 'cheap-model' },
  }).teamId!;
  const byTag = (role: string) => fake.sends.find((x) => x.spawnTag === `${id}:${role}`)!;
  assert.equal(byTag('lead').mode, 'default');
  assert.equal(byTag('lead').model, 'team-model');
  assert.equal(byTag('builder').mode, 'acceptEdits', 'builder hired straight into its own mode');
  assert.equal(byTag('builder').model, 'team-model');
  assert.equal(byTag('reviewer').mode, 'default');
  assert.equal(byTag('reviewer').model, 'cheap-model', 'reviewer runs its own model');
});

await test('per-role choices survive a restart', async () => {
  const { fake, tc } = rig('role-overrides-persist.json');
  const id = tc.hire({
    roomId: ROOM,
    task: 'Prune the hedge',
    autonomy: 'auto' as never,
    roleModes: { builder: 'acceptEdits' as never },
    roleModels: { builder: 'shears-model' },
  }).teamId!;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `ro-${role}` });

  const fake2 = new FakeController();
  const tc2 = new TeamController({
    controller: fake2,
    onUpdate: () => {},
    onHandoff: () => {},
    onTeamsChanged: () => {},
    file: path.join(dir, 'role-overrides-persist.json'),
  });
  assert.ok(tc2.continue_(id));
  await tc2.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'trim it' });
  const toBuilder = fake2.sends.filter((x) => x.sessionId === 'ro-builder').at(-1)!;
  assert.equal(toBuilder.mode, 'acceptEdits');
  assert.equal(toBuilder.model, 'shears-model');
});

console.log('\nthe meter is not a turn ending');

await test('the context-meter result never counts as a stall', async () => {
  const { fake, tc } = rig('meter-stall.json');
  const id = tc.hire({ roomId: ROOM, task: 'Count the meters', autonomy: 'auto' as never }).teamId!;
  const leadKey = `spawn:${ROOM}#${id}:lead`;
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `mt-${role}` });

  // One silent turn, then the meter that always follows it.
  fake.emit(leadKey, { phase: 'result' });
  fake.emit(leadKey, { phase: 'result', meter: true, context: { usedTokens: 1000, maxTokens: 200000, percent: 1 } });
  const team = tc.list().find((t) => t.id === id)!;
  assert.equal(team.state, 'working', 'one stall must not park the team');
  assert.equal(team.parkedReason, undefined);
  assert.equal(fake.sends.filter((x) => /without moving the team/.test(x.text)).length, 1, 'exactly one nudge');
});

await test('a worker gets its one reminder, not two, when the meter follows', async () => {
  const { fake, tc } = rig('meter-worker.json');
  const id = hire(tc, 'auto');
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `mw-${role}` });
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'Do the thing' });
  const builderKey = `spawn:${ROOM}#${id}:builder`;

  fake.emit(builderKey, { phase: 'result' }); // silent turn
  fake.emit(builderKey, { phase: 'result', meter: true, context: { usedTokens: 5, maxTokens: 100, percent: 5 } });
  const team = tc.list().find((t) => t.id === id)!;
  assert.equal(team.state, 'working', 'the meter must not turn one silence into "went quiet"');
  assert.equal(fake.sends.filter((x) => /report_result/.test(x.text)).length, 1);
});

console.log('\na hold the team itself has moved past');

await test('a stale hold clears when work moves again, and the log says why', async () => {
  const { fake, tc, handoffs } = rig('stale-hold.json');
  const id = hire(tc, 'auto');
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `sh-${role}` });

  // The lead is stopped mid-turn: the team parks, correctly.
  fake.emit(`spawn:${ROOM}#${id}:lead`, { phase: 'result', interrupted: true });
  assert.equal(tc.list().find((t) => t.id === id)!.state, 'awaiting_human');

  // It then acts anyway (the human answered in its own chat instead).
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'Carry on' });
  const team = tc.list().find((t) => t.id === id)!;
  assert.equal(team.state, 'working', 'the banner must not outlive the hold');
  assert.equal(team.parkedReason, undefined);
  assert.ok(handoffs.some((h) => /moved on its own/.test(h.summary)), 'the log explains the clear');
});

await test('a real gate is never auto-cleared — only the human releases it', async () => {
  const { fake, tc } = rig('gate-holds.json');
  const id = hire(tc, 'gated');
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `gh-${role}` });

  const first = await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'One' });
  assert.match(first, /PARKED/);
  const second = await tc.handlersFor(id, 'lead').assign({ role: 'reviewer', instructions: 'Two' });
  assert.match(second, /PARKED/, 'a second assign must not slip past the gate');
  assert.equal(tc.list().find((t) => t.id === id)!.state, 'awaiting_human');
});

console.log('\nContinue while somebody is mid-turn');

await test('Continue lifts the hold without interrupting a working lead', async () => {
  const { fake, tc, handoffs } = rig('continue-busy-lead.json');
  const id = hire(tc, 'auto');
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `cb-${role}` });
  fake.emit(`spawn:${ROOM}#${id}:lead`, { phase: 'result', interrupted: true }); // parked

  fake.busy.add('cb-lead'); // it is already working again
  const sends = fake.sends.length;
  assert.equal(tc.continue_(id), true);
  const team = tc.list().find((t) => t.id === id)!;
  assert.equal(team.state, 'working');
  assert.equal(fake.sends.length, sends, 'no message pushed into a live turn');
  assert.ok(handoffs.some((h) => /still working/.test(h.summary)));
});

await test('Continue still wakes a member that is genuinely idle', async () => {
  const { fake, tc } = rig('continue-idle.json');
  const id = hire(tc, 'auto');
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `ci-${role}` });
  fake.emit(`spawn:${ROOM}#${id}:lead`, { phase: 'result', interrupted: true });

  const sends = fake.sends.length;
  assert.equal(tc.continue_(id), true);
  assert.ok(fake.sends.length > sends, 'an idle lead must still be nudged');
  assert.match(fake.sends.at(-1)!.text, /pressed Continue/);
});

console.log('\nmore work after the lead called finish');

await test('assigning reopens a finished team, keeping the fix-round count', async () => {
  const { fake, tc, handoffs } = rig('reopen.json');
  const id = hire(tc, 'auto_capped', 5);
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `ro-${role}` });
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'Build it' });
  await approve(tc, id);
  await tc.handlersFor(id, 'lead').finish({ summary: 'All done' });
  assert.equal(tc.list().find((t) => t.id === id)!.state, 'done');

  const answer = await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'A late review found defects' });
  assert.match(answer, /Delivered to Builder/);
  const team = tc.list().find((t) => t.id === id)!;
  assert.equal(team.state, 'working');
  assert.equal(team.doneSummary, undefined);
  assert.equal(team.roundsUsed, 1, 'the reopened assignment is a fix round, and the count carries over');
  assert.ok(handoffs.some((h) => /reopened/.test(h.summary)));
});

await test('a team the human stopped stays stopped, and says where to restart it', async () => {
  const { fake, tc } = rig('stopped-stays.json');
  const id = hire(tc, 'auto');
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `ss-${role}` });
  tc.stop(id);
  const answer = await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'Carry on anyway' });
  assert.match(answer, /team panel/);
  assert.equal(tc.list().find((t) => t.id === id)!.state, 'stopped');
});

await test('finishing clears the hold that was on screen', async () => {
  const { fake, tc } = rig('finish-clears.json');
  const id = hire(tc, 'auto');
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `fc-${role}` });
  fake.emit(`spawn:${ROOM}#${id}:lead`, { phase: 'result', interrupted: true });
  assert.ok(tc.list().find((t) => t.id === id)!.parkedReason);

  await approve(tc, id);
  await tc.handlersFor(id, 'lead').finish({ summary: 'Done anyway' });
  const team = tc.list().find((t) => t.id === id)!;
  assert.equal(team.state, 'done');
  assert.equal(team.parkedReason, undefined, 'a finished team must not still be asking for you');
});

await test('a report the lead was owed survives a premature finish', async () => {
  const { fake, tc } = rig('late-report.json');
  const id = hire(tc, 'auto');
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `lr-${role}` });
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'Build it' });
  await approve(tc, id);
  await tc.handlersFor(id, 'lead').finish({ summary: 'Called it early' });

  const answer = await tc.handlersFor(id, 'builder').report_result({ summary: 'Actually here is the work', status: 'done' });
  assert.match(answer, /Delivered to the lead/);
  assert.equal(tc.list().find((t) => t.id === id)!.state, 'working');
});

await test('an unowed report after finish is refused, not resurrected', async () => {
  const { fake, tc } = rig('unowed-report.json');
  const id = hire(tc, 'auto');
  for (const role of ['lead', 'builder', 'reviewer'])
    fake.emit(`spawn:${ROOM}#${id}:${role}`, { phase: 'started', sessionId: `ur-${role}` });
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'Build it' });
  await tc.handlersFor(id, 'builder').report_result({ summary: 'Done', status: 'done' });
  await approve(tc, id);
  await tc.handlersFor(id, 'lead').finish({ summary: 'Finished' });

  const answer = await tc.handlersFor(id, 'reviewer').give_verdict({ verdict: 'approve', notes: 'late' });
  assert.match(answer, /no longer running/);
  assert.equal(tc.list().find((t) => t.id === id)!.state, 'done');
});

await test('a task typed as a sentence still gets a name you can read', async () => {
  // A brief is prose, and its first line is often a whole sentence. Cutting it
  // mid-word gave the board — and a team room's sign — "…what to fix in cod".
  const { tc } = rig('title1.json');
  const id = tc.hire({
    roomId: ROOM,
    task: 'create an amazing plan of what to fix in code, what features to add, and in which order',
    autonomy: 'auto',
  }).teamId!;
  const title = tc.list()[0].tasks[0].title;
  assert.ok(title.length <= 49, `too long for a board row: ${title}`);
  assert.ok(title.endsWith('…'), 'a cut title says it was cut');
  assert.ok(!/\S…$/.test(title.replace(/[a-z]…$/i, 'x…')) || !title.slice(0, -1).endsWith(' '), 'no trailing space before the ellipsis');
  assert.ok(!title.includes('cod…'), `cut mid-word: ${title}`);
  assert.match(title, /^create an amazing plan of what to fix in code/);
});

await test('a short brief is left exactly as it was written', async () => {
  const { tc } = rig('title2.json');
  const id = tc.hire({ roomId: ROOM, task: 'Add a --version flag', autonomy: 'auto' }).teamId!;
  assert.equal(tc.list()[0].tasks[0].title, 'Add a --version flag');
  assert.ok(id);
});

await test('a team can be named, and the name reaches its room and survives a restart', async () => {
  const file = 'name1.json';
  const { tc } = rigLanes(file);
  const id = tc.hire({ roomId: ROOM, task: 'create an amazing plan of what to fix', autonomy: 'auto', lanes: 2 }).teamId!;
  assert.equal(tc.list()[0].name, undefined, 'a new team is called by its job');
  assert.equal(tc.rename(id, '  Reasoning   crew  '), true);
  assert.equal(tc.list()[0].name, 'Reasoning crew', 'trimmed, and inner runs of spaces collapsed');
  assert.equal([...tc.laneRooms().values()][0].teamName, 'Reasoning crew', 'the lane room is signed with it');
  assert.equal(tc.rename(id, 'x'.repeat(80)).valueOf(), true);
  assert.equal(tc.list()[0].name?.length, 40, 'capped');
  tc.rename(id, 'Reasoning crew');
  const again = rigLanes(file).tc;
  assert.equal(again.list()[0].name, 'Reasoning crew', 'persisted with the team');
});

await test('clearing the name puts the team back to being called by its job', async () => {
  const { tc } = rigLanes('name2.json');
  const id = tc.hire({ roomId: ROOM, task: 'Ship it', autonomy: 'auto', lanes: 2 }).teamId!;
  tc.rename(id, 'Crew');
  assert.equal(tc.rename(id, '   '), true);
  assert.equal(tc.list()[0].name, undefined);
  assert.equal([...tc.laneRooms().values()][0].teamName, undefined);
  assert.equal(tc.rename('nope', 'x'), false, 'no such team');
});

console.log('\nrosters');

/** A rig whose lanes are named but never really cut — git stays out of unit tests. */
function rigLanes(fileName: string) {
  const fake = new FakeController();
  const handoffs: Handoff[] = [];
  const tc = new TeamController({
    controller: fake,
    onUpdate: () => {},
    onHandoff: (h) => handoffs.push(h),
    onTeamsChanged: () => {},
    file: path.join(dir, fileName),
    noGit: true,
  });
  return { fake, tc, handoffs };
}

await test('a custom roster hires exactly who was asked for, with stable ids', async () => {
  const { fake, tc } = rigLanes('ros1.json');
  const r = tc.hire({
    roomId: ROOM,
    task: 'Port the importer',
    autonomy: 'auto_capped',
    roster: [
      { kind: 'lead', label: 'Lead' },
      { kind: 'worker', label: 'Backend', writes: true },
      { kind: 'worker', label: 'Scout', writes: false },
      { kind: 'reviewer', label: 'Security' },
    ],
  });
  assert.equal(r.ok, true, r.error);
  const team = tc.list()[0];
  assert.deepEqual(
    team.members.map((m) => [m.role, m.kind, m.writes]),
    [
      ['lead', 'lead', false],
      ['backend', 'worker', true],
      ['scout', 'worker', false],
      ['security', 'reviewer', false],
    ],
  );
  assert.equal(fake.sends.length, 4, 'the whole bench is staffed at once');
  // Only the writer keeps the file tools.
  const tools = (id: string) => fake.sends.find((x) => x.spawnTag === `${r.teamId}:${id}`)!.extraDisallowedTools ?? [];
  assert.deepEqual(tools('backend'), []);
  assert.ok(tools('scout').includes('Write'), 'a reader must not hold the write tools');
  assert.ok(tools('security').includes('Edit'), 'a reviewer must not hold the write tools');
});

await test('duplicate labels get unique ids, and the lead is always first', async () => {
  const { tc } = rigLanes('ros2.json');
  const r = tc.hire({
    roomId: ROOM,
    task: 'Two of everything',
    autonomy: 'auto',
    roster: [
      { kind: 'worker', label: 'Builder', writes: true },
      { kind: 'worker', label: 'Builder', writes: true },
      { kind: 'lead', label: 'Lead' },
    ],
  });
  const roles = tc.list()[0].members.map((m) => m.role);
  assert.equal(roles[0], 'lead', 'the lead is hired first whatever order it arrived in');
  assert.equal(new Set(roles).size, roles.length, 'ids must be unique');
  assert.deepEqual(roles, ['lead', 'builder', 'builder-2']);
  assert.equal(r.ok, true);
});

await test('a team with no reviewer runs the whole loop', async () => {
  const { tc } = rigLanes('ros3.json');
  const r = tc.hire({
    roomId: ROOM,
    task: 'Just build it',
    autonomy: 'auto',
    roster: [
      { kind: 'lead', label: 'Lead' },
      { kind: 'worker', label: 'Builder', writes: true },
    ],
  });
  const id = r.teamId!;
  assert.match(await tc.handlersFor(id, 'lead').assign({ member: 'builder', instructions: 'do it' }), /Delivered/);
  assert.match(await tc.handlersFor(id, 'builder').report_result({ summary: 'done', status: 'done' }), /Delivered to the lead/);
  await tc.handlersFor(id, 'lead').finish({ summary: 'shipped' });
  assert.equal(tc.list()[0].state, 'done');
});

await test('only one writer at a time in a lane; readers are unlimited', async () => {
  const { tc } = rigLanes('ros4.json');
  const id = tc.hire({
    roomId: ROOM,
    task: 'Two writers, one tree',
    autonomy: 'auto',
    roster: [
      { kind: 'lead', label: 'Lead' },
      { kind: 'worker', label: 'Backend', writes: true },
      { kind: 'worker', label: 'Frontend', writes: true },
      { kind: 'worker', label: 'Scout', writes: false },
      { kind: 'worker', label: 'Scout 2', writes: false },
    ],
  }).teamId!;
  const lead = tc.handlersFor(id, 'lead');
  assert.match(await lead.assign({ member: 'backend', instructions: 'server side' }), /Delivered/);
  assert.match(
    await lead.assign({ member: 'frontend', instructions: 'client side' }),
    /REFUSED/,
    'two agents editing one working tree is a conflict, not parallelism',
  );
  // Readers cannot collide with anyone, so they go straight through.
  assert.match(await lead.assign({ member: 'scout', instructions: 'find the callers' }), /Delivered/);
  assert.match(await lead.assign({ member: 'scout-2', instructions: 'find the tests' }), /Delivered/);
  // Once the writer reports, the other writer is free to start.
  await tc.handlersFor(id, 'backend').report_result({ summary: 'server done', status: 'done' });
  assert.match(await lead.assign({ member: 'frontend', instructions: 'client side' }), /Delivered/);
});

await test('an assignment to somebody who is not on the team says who is', async () => {
  const { tc } = rigLanes('ros5.json');
  const id = hire(tc, 'auto');
  assert.match(await tc.handlersFor(id, 'lead').assign({ member: 'designer', instructions: 'x' }), /no member called "designer"/);
});

console.log('\nlanes and the board');

function hireLanes(tc: TeamController, lanes: number) {
  const r = tc.hire({ roomId: ROOM, task: 'First job', autonomy: 'auto', lanes });
  assert.equal(r.ok, true, r.error);
  return r.teamId!;
}

await test('a second task opens a second lane, with its own crew and folder', async () => {
  const { fake, tc } = rigLanes('lane1.json');
  const id = hireLanes(tc, 2);
  const team0 = tc.list()[0];
  assert.equal(team0.lanes, 2);
  assert.equal(team0.worktrees, true);
  assert.equal(team0.members.length, 3, 'lane 2 is not staffed until there is work for it');

  tc.newTask(id, 'Second job');
  const team = tc.list()[0];
  assert.deepEqual(
    team.tasks.map((t) => [t.state, t.lane]),
    [
      ['working', 1],
      ['working', 2],
    ],
    'both tasks run at once',
  );
  assert.deepEqual(
    team.members.map((m) => m.role),
    ['lead', 'builder', 'reviewer', 'builder@2', 'reviewer@2'],
  );
  // Each crew works in its own folder — a session cannot be moved between them.
  const cwdOf = (role: string) => fake.sends.find((x) => x.spawnTag === `${id}:${role}`)!.roomId;
  assert.equal(cwdOf('builder'), path.join(ROOM, '.lane-1'));
  assert.equal(cwdOf('builder@2'), path.join(ROOM, '.lane-2'));
  assert.equal(cwdOf('lead'), ROOM, 'the lead stays in the project folder, where merges happen');
});

await test('a third task queues, and starts by itself when a lane frees', async () => {
  const { tc } = rigLanes('lane2.json');
  const id = hireLanes(tc, 2);
  tc.newTask(id, 'Second job');
  tc.newTask(id, 'Third job');
  assert.equal(tc.list()[0].tasks[2].state, 'queued');

  await approve(tc, id, 'reviewer'); // lane 1's reviewer
  await tc.handlersFor(id, 'lead').finish_task({ task: 'First job', summary: 'first is done' });
  const tasks = tc.list()[0].tasks;
  assert.equal(tasks[0].state, 'merged', 'closing a lane merges its branch');
  assert.equal(tasks[2].state, 'working', 'the queue moves on its own');
  assert.equal(tasks[2].lane, 1, 'it takes the lane that just came free');
});

await test('finish refuses while several lanes are live, and names them', async () => {
  const { tc } = rigLanes('lane3.json');
  const id = hireLanes(tc, 2);
  tc.newTask(id, 'Second job');
  const answer = await tc.handlersFor(id, 'lead').finish({ summary: 'all done' });
  assert.match(answer, /Not yet/);
  assert.match(answer, /First job/);
  assert.match(answer, /Second job/);
  assert.equal(tc.list()[0].state, 'working', 'the team is not closed behind the lead');
});

await test('a lane crew is addressed by its own ids, and works its own task', async () => {
  const { tc } = rigLanes('lane4.json');
  const id = hireLanes(tc, 2);
  tc.newTask(id, 'Second job');
  const lead = tc.handlersFor(id, 'lead');
  assert.match(await lead.assign({ member: 'builder@2', instructions: 'lane two work' }), /Delivered/);
  const status = JSON.parse(await lead.team_status({}));
  const second = status.board.find((t: { title: string }) => t.title === 'Second job');
  assert.equal(second.waitingOn, 'builder@2');
  assert.equal(second.lane, 2);
  const first = status.board.find((t: { title: string }) => t.title === 'First job');
  assert.match(String(first.waitingOn), /your move/, 'the other lane is untouched');
});

await test('cancelling a task frees its lane and lets the queue in', async () => {
  const { fake, tc } = rigLanes('lane5.json');
  const id = hireLanes(tc, 1);
  tc.newTask(id, 'Second job');
  const first = tc.list()[0].tasks[0];
  await tc.handlersFor(id, 'lead').assign({ member: 'builder', instructions: 'go' });
  const before = fake.interrupted.length;
  assert.deepEqual(tc.cancelTask(id, first.id), { ok: true });
  const tasks = tc.list()[0].tasks;
  assert.equal(tasks[0].state, 'cancelled');
  assert.equal(tasks[1].state, 'working', 'the queued task takes the freed lane');
  assert.ok(fake.interrupted.length > before, 'the crew working it is stopped');
});

await test('the lead can split a brief into lanes with add_task', async () => {
  const { tc } = rigLanes('lane6.json');
  const id = hireLanes(tc, 3);
  const answer = await tc.handlersFor(id, 'lead').add_task({ title: 'Docs', brief: 'write the docs' });
  assert.match(answer, /started in lane 2/);
  const task = tc.list()[0].tasks.find((t) => t.title === 'Docs');
  assert.equal(task?.state, 'working');
  assert.equal(task?.lane, 2);
});

await test('a room of its own is a worktree, even for a single-lane team', async () => {
  // "Give them their own room" and "run three tasks at once" are the same
  // mechanism: a room in the office is a folder, so a team cannot have one
  // without a checkout of its own.
  const { fake, tc } = rigLanes('own1.json');
  const r = tc.hire({ roomId: ROOM, task: 'Alone please', autonomy: 'auto', lanes: 1, ownRoom: true });
  assert.equal(r.ok, true, r.error);
  const team = tc.list()[0];
  assert.equal(team.worktrees, true);
  assert.equal(team.ownRoom, true);
  assert.equal(team.lanes, 1, 'one room, still one task at a time');
  const cwd = (role: string) => fake.sends.find((x) => x.spawnTag === `${r.teamId}:${role}`)!.roomId;
  assert.equal(cwd('builder'), path.join(ROOM, '.lane-1'), 'the crew works in the team’s own folder');
  assert.equal(cwd('lead'), ROOM, 'the lead stays where the merges happen');
});

await test('a roster bigger than the classic trio takes a room by default', async () => {
  const { tc } = rigLanes('own2.json');
  tc.hire({
    roomId: ROOM,
    task: 'A crowd',
    autonomy: 'auto',
    roster: [
      { kind: 'lead', label: 'Lead' },
      { kind: 'worker', label: 'Builder', writes: true },
      { kind: 'worker', label: 'Tests', writes: true },
      { kind: 'reviewer', label: 'Reviewer' },
    ],
  });
  assert.equal(tc.list()[0].ownRoom, true, 'four people do not belong on the project floor by default');
});

await test('the classic trio stays exactly where it always was', async () => {
  const { fake, tc } = rigLanes('own3.json');
  const r = tc.hire({ roomId: ROOM, task: 'As before', autonomy: 'auto' });
  const team = tc.list()[0];
  assert.equal(team.worktrees, false);
  assert.equal(team.ownRoom, false);
  for (const role of ['lead', 'builder', 'reviewer'])
    assert.equal(fake.sends.find((x) => x.spawnTag === `${r.teamId}:${role}`)!.roomId, ROOM);
});

await test('lanes are refused where git cannot provide them', async () => {
  // Not a git repository: the team still works, one task at a time, and says so.
  const { tc } = rig('lane7.json');
  const r = tc.hire({ roomId: path.join(dir, 'not-a-repo'), task: 'anything', autonomy: 'auto', lanes: 3 });
  assert.equal(r.ok, true);
  assert.match(r.notice ?? '', /git repository/);
  assert.equal(tc.list()[0].ownRoom, false);
  assert.equal(tc.list()[0].lanes, 1);
  assert.equal(tc.list()[0].worktrees, false);
});

await test('an old saved team loads with kinds, labels and a board', async () => {
  // Teams persisted before any of this existed must come back as themselves.
  const file = path.join(dir, 'legacy.json');
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      teams: [
        {
          team: {
            id: 'team-old',
            roomId: ROOM,
            task: 'Add a --version flag',
            autonomy: 'auto_capped',
            roundCap: 2,
            roundsUsed: 1,
            state: 'working',
            members: [
              { role: 'lead', sessionId: 's1' },
              { role: 'builder', sessionId: 's2' },
              { role: 'reviewer', sessionId: 's3' },
            ],
            costUsd: 0.5,
            tasksDone: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          handoffs: [],
          parked: null,
          awaitingReportFrom: 'builder',
          assignsToBuilder: 2,
          mode: 'acceptEdits',
        },
      ],
    }),
  );
  const fake = new FakeController();
  const tc = new TeamController({ controller: fake, onUpdate: () => {}, onHandoff: () => {}, onTeamsChanged: () => {}, file });
  const team = tc.list()[0];
  assert.deepEqual(
    team.members.map((m) => [m.role, m.kind, m.writes]),
    [
      ['lead', 'lead', false],
      ['builder', 'worker', true],
      ['reviewer', 'reviewer', false],
    ],
  );
  assert.equal(team.tasks.length, 1);
  assert.equal(team.tasks[0].brief, 'Add a --version flag');
  assert.equal(team.tasks[0].awaitingFrom, 'builder', 'the outstanding report survives the upgrade');
  assert.equal(team.lanes, 1);
  assert.equal(team.state, 'awaiting_human', 'a team that was mid-flight when the server died says so');
  // …and it still works: Continue must reach the builder that owes the report.
  tc.continue_('team-old');
  assert.ok(fake.sends.some((x) => x.sessionId === 's2'), 'the builder was re-briefed');
});

rmSync(dir, { recursive: true, force: true });
console.log('\nwhat a member runs with');

await test("each member carries the team's model and mode, so its own panel can show them", async () => {
  const { tc } = rig('set1.json');
  const id = tc.hire({
    roomId: ROOM,
    task: 'Add a --version flag',
    autonomy: 'auto_capped',
    mode: 'bypassPermissions',
    model: 'opus',
  }).teamId!;
  for (const m of tc.list()[0].members) {
    assert.equal(m.mode, 'bypassPermissions', `${m.role} should run unattended`);
    assert.equal(m.model, 'opus', `${m.role} should run on opus`);
  }
});

await test('a per-member override wins, and a later change is published too', async () => {
  const { fake, tc } = rig('set2.json');
  const id = tc.hire({
    roomId: ROOM,
    task: 'Add a --version flag',
    autonomy: 'auto_capped',
    mode: 'default',
    model: 'sonnet',
    roleModes: { reviewer: 'plan' },
    roleModels: { reviewer: 'haiku' },
  }).teamId!;
  const at = (role: string) => tc.list()[0].members.find((m) => m.role === role)!;
  assert.deepEqual([at('reviewer').mode, at('reviewer').model], ['plan', 'haiku']);
  assert.deepEqual([at('builder').mode, at('builder').model], ['default', 'sonnet']);

  // The human changes the builder's mode in its own panel.
  fake.emit(`spawn:${ROOM}#${id}:builder`, { phase: 'started', sessionId: 'b-sess' });
  tc.noteMemberMode('b-sess', 'acceptEdits');
  assert.equal(at('builder').mode, 'acceptEdits');
  tc.noteMemberModel('b-sess', 'opus');
  assert.equal(at('builder').model, 'opus');
  assert.equal(at('reviewer').mode, 'plan', 'one member changing must not move another');
});

await test('a team with no model chosen reports none, rather than an empty string', async () => {
  const { tc } = rig('set3.json');
  hire(tc, 'auto_capped');
  assert.equal(tc.list()[0].members[0].model, undefined);
  assert.equal(tc.list()[0].members[0].mode, 'default');
});

console.log('\nairoom going away underneath a team');

await test('quitting parks a working team with the reason, not with the wreckage', async () => {
  const { fake, tc, handoffs } = rig('quit1.json');
  const id = hire(tc, 'auto_capped');
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'build' });
  fake.emit(`spawn:${ROOM}#${id}:builder`, { phase: 'started', sessionId: 'q-builder' });
  assert.equal(tc.list()[0].state, 'working');

  tc.shutDown();
  const team = tc.list()[0];
  assert.equal(team.state, 'awaiting_human');
  assert.match(team.parkedReason ?? '', /airoom was quit/);
  // The run is gone; the conversation and the debt are not. Continue sends the
  // builder back to it (team-reliability-test drives that end to end).
  assert.equal(team.tasks[0].awaitingFrom, 'builder', 'the debt must survive a quit');
  assert.ok(handoffs.some((h) => h.to === 'human' && /quit/.test(h.summary)));

  // The runs die immediately after, and their errors must not replace it.
  fake.emit(`spawn:${ROOM}#${id}:builder`, { phase: 'error', text: 'the run ended: error_during_execution', isError: true });
  assert.match(tc.list()[0].parkedReason ?? '', /airoom was quit/);
});

await test('a team killed before it could be told says the same thing when it comes back', async () => {
  const { fake, tc } = rig('quit2.json');
  const id = hire(tc, 'auto_capped');
  await tc.handlersFor(id, 'lead').assign({ role: 'builder', instructions: 'build' });
  assert.equal(tc.list()[0].state, 'working');
  // No shutDown: the process was killed outright, leaving "working" on disk.
  const { tc: again } = rig('quit2.json');
  const team = again.list().find((t) => t.id === id)!;
  assert.equal(team.state, 'awaiting_human');
  assert.match(team.parkedReason ?? '', /airoom was quit/);
});

await test('an idle team is left alone by a quit', async () => {
  const { tc } = rig('quit3.json');
  const id = hire(tc, 'auto_capped');
  await approve(tc, id);
  await tc.handlersFor(id, 'lead').finish({ summary: 'done' });
  assert.equal(tc.list()[0].state, 'done');
  tc.shutDown();
  assert.equal(tc.list()[0].state, 'done');
  assert.equal(tc.list()[0].parkedReason, undefined);
});

console.log('\nthe token saver');

await test('the saver is off unless asked for, and rides in every preamble when on', async () => {
  const plain = rig('thrift-off.json');
  const idA = plain.tc.hire({ roomId: ROOM, task: 'Add a --version flag', autonomy: 'auto_capped' }).teamId!;
  assert.equal(plain.tc.list()[0].thrift, undefined);
  assert.ok(!plain.fake.sends.some((s) => /TOKEN SAVER/.test(s.systemPromptAppend ?? '')));

  const saver = rig('thrift-on.json');
  const idB = saver.tc.hire({ roomId: ROOM, task: 'Add a --version flag', autonomy: 'auto_capped', thrift: true }).teamId!;
  assert.equal(saver.tc.list()[0].thrift, true);
  for (const role of ['lead', 'builder', 'reviewer']) {
    const s = saver.fake.sends.find((x) => x.spawnTag === `${idB}:${role}`)!;
    assert.match(s.systemPromptAppend ?? '', /TOKEN SAVER is on/, `${role} was not told`);
    assert.match(s.systemPromptAppend ?? '', /run the tests exactly as you would otherwise/i, `${role} must not read it as licence to skip checks`);
  }
  assert.ok(idA && idB);
});

await test('the saver survives a restart', async () => {
  const { tc } = rig('thrift-persist.json', { revisionOf: () => 'rev-A' });
  tc.hire({ roomId: ROOM, task: 'Add a --version flag', autonomy: 'auto_capped', thrift: true });
  const { tc: again } = rig('thrift-persist.json', { revisionOf: () => 'rev-A' });
  assert.equal(again.list()[0].thrift, true);
});

console.log('\nthe review gate');

const JOB = 'Add a --version flag';

await test('finish_task is refused until the reviewer has approved', async () => {
  const { tc } = rig('rg1.json', { revisionOf: () => 'rev-A' });
  const id = hire(tc, 'auto_capped');
  const lead = tc.handlersFor(id, 'lead');
  await lead.assign({ role: 'builder', instructions: 'build' });
  await tc.handlersFor(id, 'builder').report_result({ summary: 'done', status: 'done' });
  const refused = await lead.finish_task({ task: JOB, summary: 'shipping' });
  assert.match(refused, /Not closed/);
  assert.match(refused, /no verdict yet/);
  assert.equal(tc.list()[0].tasks[0].state, 'working');
  await lead.assign({ role: 'reviewer', instructions: 'review' });
  await approve(tc, id);
  const t = tc.list()[0].tasks[0];
  assert.deepEqual([t.review?.verdict, t.review?.by, t.review?.rev], ['approve', 'reviewer', 'rev-A']);
  const closed = await lead.finish_task({ task: JOB, summary: 'shipping' });
  assert.match(closed, /is closed/);
  // a single-lane team merges nothing, but the referee still files the task as merged
  assert.equal(tc.list()[0].tasks[0].state, 'merged');
});

await test('an approval covers only the changes it saw', async () => {
  let rev = 'rev-A';
  const { tc } = rig('rg2.json', { revisionOf: () => rev });
  const id = hire(tc, 'auto_capped');
  const lead = tc.handlersFor(id, 'lead');
  await lead.assign({ role: 'reviewer', instructions: 'review' });
  await approve(tc, id);
  rev = 'rev-B'; // something moved after the approval
  const refused = await lead.finish_task({ task: JOB, summary: 'x' });
  assert.match(refused, /moved since/);
  assert.equal(tc.list()[0].tasks[0].review?.stale, true);
  assert.equal(tc.list()[0].tasks[0].state, 'working');
  await approve(tc, id); // a fresh look at what is there now
  assert.equal(tc.list()[0].tasks[0].review?.stale, undefined);
  assert.match(await lead.finish_task({ task: JOB, summary: 'x' }), /is closed/);
});

await test('changes requested keep the task open', async () => {
  const { tc } = rig('rg3.json', { revisionOf: () => 'rev-A' });
  const id = hire(tc, 'auto_capped');
  const lead = tc.handlersFor(id, 'lead');
  await lead.assign({ role: 'reviewer', instructions: 'review' });
  await tc.handlersFor(id, 'reviewer').give_verdict({ verdict: 'request_changes', notes: 'cli.ts:12 breaks --help' });
  const refused = await lead.finish_task({ task: JOB, summary: 'x' });
  assert.match(refused, /requested changes/);
  assert.equal(tc.list()[0].tasks[0].state, 'working');
});

await test("a writer's report after the approval marks it stale on the board", async () => {
  let rev = 'rev-A';
  const { tc } = rig('rg4.json', { revisionOf: () => rev });
  const id = hire(tc, 'auto_capped');
  const lead = tc.handlersFor(id, 'lead');
  await lead.assign({ role: 'reviewer', instructions: 'review' });
  await approve(tc, id);
  await lead.assign({ role: 'builder', instructions: 'one more thing' });
  rev = 'rev-B';
  await tc.handlersFor(id, 'builder').report_result({ summary: 'tweaked', status: 'done' });
  assert.equal(tc.list()[0].tasks[0].review?.stale, true);
});

await test('the human can close without a review, and the board says so', async () => {
  const { fake, tc } = rig('rg5.json', { revisionOf: () => 'rev-A' });
  const id = hire(tc, 'auto_capped');
  const taskId = tc.list()[0].tasks[0].id;
  const r = tc.closeTaskByHuman(id, taskId);
  assert.equal(r.ok, true, r.error);
  const t = tc.list()[0].tasks[0];
  assert.equal(t.state, 'merged');
  assert.ok(t.waived?.at);
  assert.match(fake.lastSend().text, /closed "Add a --version flag" without waiting for a review/);
  assert.equal(fake.lastSend().spawnTag, `${id}:lead`);
  assert.deepEqual(tc.closeTaskByHuman(id, taskId), { ok: false, error: 'That task is not open.' });
});

await test('a crew without a reviewer is not gated', async () => {
  const { tc } = rig('rg6.json', { revisionOf: () => 'rev-A' });
  const r = tc.hire({
    roomId: ROOM,
    task: JOB,
    autonomy: 'auto_capped',
    roster: [
      { kind: 'lead', label: 'Lead' },
      { kind: 'worker', label: 'Builder', writes: true },
    ],
  });
  assert.equal(r.ok, true, r.error);
  const closed = await tc.handlersFor(r.teamId!, 'lead').finish_task({ task: JOB, summary: 'x' });
  assert.match(closed, /is closed/);
  assert.equal(tc.list()[0].tasks[0].review, undefined);
});

await test('finish is refused the same way, and the team stays open', async () => {
  const { tc } = rig('rg7.json', { revisionOf: () => 'rev-A' });
  const id = hire(tc, 'auto_capped');
  const out = await tc.handlersFor(id, 'lead').finish({ summary: 'all done' });
  assert.match(out, /Not finished: Not closed/);
  assert.notEqual(tc.list()[0].state, 'done');
  assert.equal(tc.list()[0].tasks[0].state, 'working');
});

await test('a fingerprint git cannot take refuses the close, rather than passing it', async () => {
  // The bug this pins: a failing git command returned '' for both sides of the
  // comparison, and '' === '' read as "nothing moved".
  let rev = 'rev-A';
  const { tc } = rig('rg9.json', { revisionOf: () => rev });
  const id = hire(tc, 'auto_capped');
  const lead = tc.handlersFor(id, 'lead');
  await lead.assign({ role: 'reviewer', instructions: 'review' });
  await approve(tc, id);
  rev = ''; // git stopped answering
  const refused = await lead.finish_task({ task: JOB, summary: 'x' });
  assert.match(refused, /could not check/);
  assert.equal(tc.list()[0].tasks[0].state, 'working');
});

await test('merge_task is gated exactly as finish_task is', async () => {
  const { tc } = rig('rg10.json', { revisionOf: () => 'rev-A' });
  const id = hire(tc, 'auto_capped');
  const lead = tc.handlersFor(id, 'lead');
  const refused = await lead.merge_task({ task: JOB });
  assert.match(refused, /Not merged/);
  assert.match(refused, /no verdict yet/);
  assert.notEqual(tc.list()[0].tasks[0].state, 'merged');
  await lead.assign({ role: 'reviewer', instructions: 'review' });
  await approve(tc, id);
  assert.doesNotMatch(await lead.merge_task({ task: JOB }), /Not merged/);
});

await test('the gate survives a restart', async () => {
  const { tc } = rig('rg8.json', { revisionOf: () => 'rev-A' });
  const id = hire(tc, 'auto_capped');
  await tc.handlersFor(id, 'lead').assign({ role: 'reviewer', instructions: 'review' });
  await approve(tc, id);
  const { tc: again } = rig('rg8.json', { revisionOf: () => 'rev-A' });
  const t = again.list()[0].tasks[0];
  assert.deepEqual([t.review?.verdict, t.review?.rev], ['approve', 'rev-A']);
});

console.log(
  failures.length
    ? `\n${passed} passed, ${failures.length} FAILED\n${failures.map(([n, e]) => `  ${n}\n    ${e.stack}`).join('\n')}`
    : `\n${passed} passed, 0 failed\n`,
);
process.exit(failures.length ? 1 : 0);
