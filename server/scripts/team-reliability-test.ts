/**
 * Teams under stress — the referee driven through whole tasks by a runtime
 * that behaves like the real one, while airoom is quit, killed and corrupted.
 *
 *   npm test   (tsx scripts/team-reliability-test.ts)
 *
 * team-test.ts proves each rule of the referee on its own. This file proves
 * the TEAM: a scripted crew (lead, builder, reviewer) works a task end to end
 * while the process goes away at every stage, and after every step three
 * promises must hold —
 *
 *   1. a team that says "working" has somebody actually working,
 *   2. a team that says "needs you" says why,
 *   3. Continue moves it forward, starting with whoever owes the work.
 *
 * SimAgents behaves like SdkClaudeController where it matters: one run per
 * conversation; a quit stops every turn and loses whatever was waiting; a
 * kill reports nothing at all; conversations live on "disk" and resume after
 * a restart; resuming one that is gone fails the way the real CLI does. A
 * message sent to a busy run does one of two things in the real runtime —
 * both measured against it — so the sim can do either:
 *
 *   'turns'  it waits, and is answered in a turn of its own right after
 *            (what happens when it lands during a plain-text answer);
 *   'steer'  it is folded into the turn in flight, which ends with ONE
 *            result (what happens when a tool call is still ahead).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TeamController } from '../src/team/TeamController';
import { runKeyFor, type ActiveRun, type AgentController, type SendOptions } from '../src/agent/AgentController';
import type { Handoff, RunUpdate, Team } from '../../shared/types';

const ROOM = '/tmp/reliability-project';
const TASK = 'Add a --version flag';
const BUILD = 'Add the --version flag to cli.ts';
const REVIEW = 'Review the --version change';
const REPORT = 'Added --version to cli.ts; tests pass';
const VERDICT = 'ran the tests myself; green';

/** Conversations outlive the process: this is ~/.claude/projects. */
class Disk {
  sessions = new Map<string, string[]>(); // session id -> every message that reached it
  n = 0;
}

interface SimRun {
  key: string;
  sessionId: string;
  onUpdate: (u: RunUpdate) => void;
  current: string | null; // the message whose turn is in flight
  queue: string[]; // messages waiting behind it, each its own next turn
}

type QueueMode = 'turns' | 'steer';

class SimAgents implements AgentController {
  private runs = new Map<string, SimRun>(); // by session id AND by spawn key
  sent: SendOptions[] = [];
  constructor(
    private disk: Disk,
    private mode: QueueMode = 'turns',
  ) {}

  activeRuns(): ActiveRun[] {
    return [];
  }
  isBusy(sessionId: string): boolean {
    return !!this.runs.get(sessionId)?.current;
  }
  waiting(sessionId: string): number {
    return this.runs.get(sessionId)?.queue.length ?? 0;
  }

  async send(opts: SendOptions, onUpdate: (u: RunUpdate) => void): Promise<void> {
    this.sent.push(opts);
    if (opts.sessionId && !this.disk.sessions.has(opts.sessionId)) {
      // What the CLI answers when asked to resume a conversation that is gone.
      onUpdate({
        runKey: opts.sessionId,
        roomId: opts.roomId,
        sessionId: opts.sessionId,
        phase: 'error',
        isError: true,
        text: `No conversation found with session ID: ${opts.sessionId}`,
      });
      return;
    }
    const key = runKeyFor(opts);
    let run = this.runs.get(opts.sessionId ?? key);
    if (run?.current) {
      if (this.mode === 'steer') {
        // Folded into the turn in flight: the member reads it, and the turn
        // still ends with a single result.
        this.disk.sessions.get(run.sessionId)!.push(opts.text);
      } else {
        // It waits, and is answered in a turn of its own right after.
        run.queue.push(opts.text);
      }
      run.onUpdate({ runKey: run.key, roomId: opts.roomId, sessionId: run.sessionId, phase: 'started' });
      return;
    }
    if (!run) {
      const sessionId = opts.sessionId ?? `sess-${++this.disk.n}`;
      if (!this.disk.sessions.has(sessionId)) this.disk.sessions.set(sessionId, []);
      run = { key, sessionId, onUpdate, current: null, queue: [] };
      this.runs.set(sessionId, run);
      this.runs.set(key, run);
    }
    run.onUpdate = onUpdate;
    this.start(run, opts.text);
  }

  private start(run: SimRun, text: string) {
    run.current = text;
    this.disk.sessions.get(run.sessionId)!.push(text);
    run.onUpdate({ runKey: run.key, roomId: ROOM, sessionId: run.sessionId, phase: 'started' });
  }

  /** The turn in flight ends; whatever waited behind it starts as its own turn. */
  end(sessionId: string, how: { error?: string; interrupted?: boolean } = {}) {
    const run = this.runs.get(sessionId);
    assert.ok(run?.current, `${sessionId} has no turn in flight to end`);
    run.current = null;
    const base = { runKey: run.key, roomId: ROOM, sessionId: run.sessionId };
    if (how.error) {
      run.queue = [];
      run.onUpdate({ ...base, phase: 'error', text: how.error, isError: true });
      return;
    }
    run.onUpdate({ ...base, phase: 'result', cost: 0.01, ...(how.interrupted ? { interrupted: true } : {}) });
    // The controller's second, meter-only result after every turn.
    run.onUpdate({ ...base, phase: 'result', meter: true, context: { usedTokens: 1, maxTokens: 100, percent: 1 } });
    if (how.interrupted) {
      run.queue = [];
      return;
    }
    const next = run.queue.shift();
    if (next !== undefined) this.start(run, next);
  }

  interrupt(key: string): boolean {
    const run = this.runs.get(key);
    if (!run?.current) return false;
    this.end(run.sessionId, { interrupted: true });
    return true;
  }
  respondPermission(): boolean {
    return true;
  }

  /** airoom quits: every turn is stopped and reported as such; queues are lost. */
  async close(): Promise<void> {
    for (const run of new Set(this.runs.values())) {
      run.queue = [];
      if (run.current) {
        run.current = null;
        run.onUpdate({ runKey: run.key, roomId: ROOM, sessionId: run.sessionId, phase: 'result', interrupted: true });
      }
    }
    this.runs.clear();
  }

  /** airoom is killed: nothing is reported at all. */
  vanish() {
    this.runs.clear();
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

const dir = mkdtempSync(path.join(os.tmpdir(), 'airoom-team-reliability-'));

/** One project, one team, and everything that outlives a restart. */
class World {
  disk = new Disk();
  file: string;
  agents!: SimAgents;
  tc!: TeamController;
  handoffs: Handoff[] = [];
  id = '';
  /** the lane's fingerprint — the builder "edits" by moving it */
  rev = 'r1';
  /** judgements the referee deferred for its settle window */
  private pending: Array<() => void> = [];

  constructor(
    name: string,
    private mode: QueueMode = 'turns',
  ) {
    this.file = path.join(dir, `${name}.json`);
    this.boot();
  }

  boot() {
    this.pending = []; // a restart takes pending timers with it
    this.agents = new SimAgents(this.disk, this.mode);
    this.tc = new TeamController({
      controller: this.agents,
      onUpdate: () => {},
      onHandoff: (h) => this.handoffs.push(h),
      onTeamsChanged: () => {},
      file: this.file,
      noGit: true,
      revisionOf: () => this.rev,
      defer: (fn) => this.pending.push(fn),
    });
  }

  /** The settle window passes: by now the runtime has started whatever it
   *  was going to start. */
  flush() {
    for (let i = 0; i < 20 && this.pending.length; i++) {
      const due = this.pending;
      this.pending = [];
      for (const fn of due) fn();
    }
  }

  hire(extra: Partial<Parameters<TeamController['hire']>[0]> = {}): string {
    const r = this.tc.hire({ roomId: ROOM, task: TASK, autonomy: 'auto_capped', ...extra });
    assert.equal(r.ok, true, r.error);
    this.id = r.teamId!;
    return this.id;
  }

  team(): Team {
    const t = this.tc.list().find((x) => x.id === this.id);
    assert.ok(t, 'the team is gone');
    return t;
  }

  sessionOf(role: string): string | null {
    return this.team().members.find((m) => m.role === role)?.sessionId ?? null;
  }

  busy(role: string): boolean {
    const s = this.sessionOf(role);
    return !!s && this.agents.isBusy(s);
  }

  /** everything the team has sent this member since the last boot */
  inbox(role: string): string[] {
    return this.agents.sent.filter((o) => o.spawnTag === `${this.id}:${role}`).map((o) => o.text);
  }

  last(role: string): string {
    const all = this.inbox(role);
    return all[all.length - 1] ?? '';
  }

  /** A member uses a team tool — only ever possible during its own turn. */
  async act(role: string, tool: string, args: Record<string, unknown> = {}): Promise<string> {
    assert.ok(this.busy(role), `${role} tried to call ${tool} outside its own turn`);
    const h = this.tc.handlersFor(this.id, role)[tool];
    assert.ok(h, `${role} has no ${tool} tool`);
    return h(args);
  }

  end(role: string, how: { error?: string; interrupted?: boolean } = {}) {
    const s = this.sessionOf(role);
    assert.ok(s, `${role} has no session`);
    this.agents.end(s, how);
    this.flush();
  }

  /** Turns that end with nothing to do: standby briefings, "understood". */
  settle(...roles: string[]) {
    for (const r of roles) for (let i = 0; i < 10 && this.busy(r); i++) this.end(r);
  }

  /** The human types into a member's own chat — the gateway's direct path. */
  async direct(role: string, text: string) {
    const s = this.sessionOf(role);
    assert.ok(s, `${role} has no session`);
    const equip = this.tc.directSendEquipment(s);
    assert.ok(equip, `${role} is not recognised as a team member`);
    this.tc.noteDirectSend(s);
    await this.agents.send(
      {
        roomId: ROOM,
        sessionId: s,
        text,
        systemPromptAppend: equip.systemPromptAppend,
        mcpServers: equip.mcpServers,
        extraDisallowedTools: equip.extraDisallowedTools,
        autoAllowToolPrefixes: equip.autoAllowToolPrefixes,
      },
      (u) => equip.observe(u),
    );
  }

  async quit() {
    this.tc.shutDown();
    await this.agents.close();
    this.boot();
  }

  kill() {
    this.agents.vanish();
    this.boot();
  }

  /** The promises, checked after every step. */
  check(label: string) {
    const t = this.team();
    const at = `[${label}]`;
    assert.ok(['working', 'awaiting_human', 'done', 'stopped', 'error'].includes(t.state), `${at} odd state ${t.state}`);
    if (t.state === 'working') {
      const moving = t.members.some((m) => m.sessionId && this.agents.isBusy(m.sessionId));
      assert.ok(moving, `${at} the team says "working" but nobody is working — a silent stall`);
    }
    if (t.state === 'awaiting_human') assert.ok(t.parkedReason?.trim(), `${at} "needs you" without saying why`);
    const live = t.tasks.filter((x) => x.state === 'working');
    for (const x of live) assert.ok(x.lane, `${at} a working task has no lane`);
    assert.equal(new Set(live.map((x) => x.lane)).size, live.length, `${at} two working tasks share a lane`);
    const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { teams: Array<{ team: Team }> };
    const onDisk = saved.teams.find((s) => s.team.id === this.id)?.team;
    assert.ok(onDisk, `${at} the team is missing from the save file`);
    assert.equal(onDisk.state, t.state, `${at} the save file disagrees about the team's state`);
  }

  reportsFrom(role: string): number {
    return this.handoffs.filter((h) => h.from === role && (h.kind === 'result' || h.kind === 'verdict')).length;
  }
}

/**
 * A well-behaved crew, played to the end: whoever's turn is in flight does
 * the obvious next thing. Its judgement is deliberately simple — what is on
 * trial is whether the TEAM keeps giving it something to act on.
 */
async function drive(w: World, label: string, maxSteps = 60) {
  for (let i = 0; i < maxSteps && w.team().state === 'working'; i++) {
    const t = w.team();
    const task = t.tasks.find((x) => x.state === 'working');
    const order = ['builder', 'reviewer', 'lead'];
    const role = order.find((r) => w.busy(r));
    assert.ok(role, `[${label} step ${i}] "working" with nobody working`);
    if (role === 'builder') {
      if (task?.awaitingFrom === 'builder') {
        w.rev = `r-built-${i}`;
        await w.act('builder', 'report_result', { summary: REPORT, status: 'done' });
      }
      w.end('builder');
    } else if (role === 'reviewer') {
      if (task?.awaitingFrom === 'reviewer') await w.act('reviewer', 'give_verdict', { verdict: 'approve', notes: VERDICT });
      w.end('reviewer');
    } else {
      if (!task) await w.act('lead', 'finish', { summary: 'Shipped --version' });
      else if (task.awaitingFrom) {
        /* someone owes it a report — the lead waits */
      } else if (!w.reportsFrom('builder')) await w.act('lead', 'assign', { member: 'builder', instructions: BUILD });
      else if (!task.review || task.review.stale) await w.act('lead', 'assign', { member: 'reviewer', instructions: REVIEW });
      else await w.act('lead', 'finish', { summary: 'Shipped --version' });
      w.end('lead');
    }
    w.check(`${label} step ${i}`);
  }
}

/** How many times a member was sent a reminder matching `re`. */
const nags = (w: World, role: string, re: RegExp) => w.inbox(role).filter((m) => re.test(m)).length;

function shipped(w: World, label: string) {
  const t = w.team();
  assert.equal(t.state, 'done', `[${label}] the team never finished (state ${t.state}: ${t.parkedReason ?? ''})`);
  assert.equal(t.tasks[0].state, 'merged', `[${label}] the task was not delivered`);
  assert.equal(t.tasks[0].review?.verdict, 'approve', `[${label}] it shipped without an approval`);
}

// ------------------------------------------------------------------------
console.log('\nquit or killed at every stage, then Continue');

const STAGES = ['kickoff', 'building', 'reported', 'reviewing', 'approved'] as const;
type Stage = (typeof STAGES)[number];
const WHO_OWES: Record<Stage, string> = {
  kickoff: 'lead',
  building: 'builder',
  reported: 'lead',
  reviewing: 'reviewer',
  approved: 'lead',
};

/** Walk a fresh team to a stage, leaving its owner mid-turn. */
async function toStage(w: World, stage: Stage) {
  w.hire();
  w.settle('builder', 'reviewer'); // their standby briefings end quietly
  w.check('hired');
  if (stage === 'kickoff') return; // the lead is mid-kickoff
  await w.act('lead', 'assign', { member: 'builder', instructions: BUILD });
  w.end('lead');
  if (stage === 'building') return; // the builder is mid-assignment
  w.rev = 'r2';
  await w.act('builder', 'report_result', { summary: REPORT, status: 'done' });
  w.end('builder');
  if (stage === 'reported') return; // the lead is mid-turn on the report
  await w.act('lead', 'assign', { member: 'reviewer', instructions: REVIEW });
  w.end('lead');
  if (stage === 'reviewing') return; // the reviewer is mid-review
  await w.act('reviewer', 'give_verdict', { verdict: 'approve', notes: VERDICT });
  w.end('reviewer'); // the lead is mid-turn on the verdict
}

for (const stage of STAGES)
  for (const how of ['quit', 'kill'] as const)
    await test(`${how} while ${stage}: Continue wakes the ${WHO_OWES[stage]} and the task still ships`, async () => {
      const w = new World(`matrix-${stage}-${how}`);
      await toStage(w, stage);
      w.check(`${stage}, before the ${how}`);
      assert.ok(w.busy(WHO_OWES[stage]), `setup: the ${WHO_OWES[stage]} should be mid-turn`);

      if (how === 'quit') await w.quit();
      else w.kill();

      const t = w.team();
      assert.equal(t.state, 'awaiting_human', 'a team whose runs died must not claim to be working');
      assert.match(t.parkedReason ?? '', /quit|closed/i);
      w.check(`after the ${how}`);

      assert.equal(w.tc.continue_(w.id), true);
      w.check('after Continue');
      assert.ok(w.busy(WHO_OWES[stage]), `the ${WHO_OWES[stage]} owes the next move and was not woken`);
      const woke = w.last(WHO_OWES[stage]);
      if (stage === 'kickoff') assert.match(woke, /--version flag/, 'the lead needs the task itself again');
      if (stage === 'building') assert.match(woke, /--version flag to cli\.ts/, 'the builder needs its assignment again');
      if (stage === 'reviewing') assert.match(woke, /Review the --version change/, 'the reviewer needs its assignment again');
      if (stage === 'reported')
        assert.match(woke, /Added --version to cli\.ts/, 'the lead needs the report it may never have read');
      if (stage === 'approved') assert.match(woke, /ran the tests myself/, 'the lead needs the verdict it may never have read');
      // Nobody is told to redo work they already handed in.
      if (stage !== 'building') assert.ok(!w.busy('builder'), 'the builder was woken for nothing');

      await drive(w, `${stage}/${how}`);
      shipped(w, `${stage}/${how}`);
      assert.ok(w.reportsFrom('builder') <= 2, 'the builder built the same thing more than twice');
    });

await test('quit twice before anyone presses Continue: still one clean pick-up', async () => {
  const w = new World('double-quit');
  await toStage(w, 'building');
  await w.quit();
  await w.quit();
  assert.equal(w.tc.continue_(w.id), true);
  assert.ok(w.busy('builder'), 'the builder was not woken');
  assert.equal(w.inbox('builder').length, 1, 'the builder was woken more than once');
  assert.equal(w.tc.continue_(w.id), false, 'a second Continue must not wake anyone again');
  await drive(w, 'double-quit');
  shipped(w, 'double-quit');
});

await test('quit again right after Continue: the debt is still on the books', async () => {
  const w = new World('quit-after-continue');
  await toStage(w, 'building');
  await w.quit();
  w.tc.continue_(w.id);
  await w.quit(); // the builder was mid-turn on its reminder
  assert.equal(w.tc.continue_(w.id), true);
  assert.ok(w.busy('builder'), 'the builder was not woken the second time');
  assert.match(w.last('builder'), /--version flag to cli\.ts/);
  await drive(w, 'quit-after-continue');
  shipped(w, 'quit-after-continue');
});

await test('a report still queued behind the lead when airoom quits is not lost', async () => {
  const w = new World('queued-report');
  w.hire();
  w.settle('builder', 'reviewer');
  await w.act('lead', 'assign', { member: 'builder', instructions: BUILD });
  // The lead stays mid-turn (it keeps reading); the builder finishes fast.
  w.rev = 'r2';
  await w.act('builder', 'report_result', { summary: REPORT, status: 'done' });
  w.end('builder'); // the report is queued behind the lead's turn
  await w.quit(); // …and the queue dies with the process
  w.tc.continue_(w.id);
  assert.ok(w.busy('lead'), 'the lead was not woken');
  assert.match(w.last('lead'), /Added --version to cli\.ts/, 'the report never reached the lead');
  await drive(w, 'queued-report');
  shipped(w, 'queued-report');
});

// ------------------------------------------------------------------------
console.log('\nhow real leads actually finish (seen in live runs)');

await test('a lead that closes the last task and stops talking is finished for it, not nagged', async () => {
  const w = new World('closes-and-stops');
  await toStage(w, 'approved'); // the lead is mid-turn on the verdict
  const note = await w.act('lead', 'finish_task', { task: w.team().tasks[0].id, summary: 'Shipped --version with a test' });
  assert.match(note, /closed/);
  w.end('lead'); // "Task complete ✅" — and no `finish`
  const t = w.team();
  assert.equal(t.state, 'done', 'an empty board with the work delivered is a finished team');
  assert.match(t.doneSummary ?? '', /Shipped --version/);
  assert.equal(nags(w, 'lead', /without moving the team/), 0, 'the lead was nagged for a formality');
});

await test('finish_task with a paraphrased title closes the only task on the board', async () => {
  const w = new World('paraphrase');
  await toStage(w, 'approved');
  // The real title is "Add a --version flag"; leads quote it loosely.
  const note = await w.act('lead', 'finish_task', { task: 'Add --version flag to cli.js', summary: 'done' });
  assert.match(note, /closed/, `refused: ${note}`);
  assert.equal(w.team().tasks[0].state, 'merged');
});

// ------------------------------------------------------------------------
console.log('\nthe save file');

await test('a save torn in half by a crash loses nothing', async () => {
  const w = new World('torn');
  await toStage(w, 'building');
  const whole = readFileSync(w.file, 'utf8');
  // Another change lands, and the process dies halfway through writing it.
  writeFileSync(w.file, whole.slice(0, Math.floor(whole.length / 2)));
  w.kill();
  const t = w.tc.list().find((x) => x.id === w.id);
  assert.ok(t, 'the team vanished because its save file was cut short');
  assert.equal(t.state, 'awaiting_human');
  const kept = readdirSync(dir).filter((f) => f.startsWith('torn.json.corrupt'));
  assert.ok(kept.length, 'the damaged file must be kept for inspection, not overwritten');
  assert.equal(w.tc.continue_(w.id), true);
  assert.ok(w.busy('builder'));
  await drive(w, 'torn');
  shipped(w, 'torn');
});

await test('an unreadable save file is never silently replaced by an empty one', async () => {
  const w = new World('garbage');
  await toStage(w, 'building');
  writeFileSync(w.file, '{"v":2,"teams":[{"team":');
  // No backup either: nothing to recover from.
  for (const f of readdirSync(dir)) if (f.startsWith('garbage.json.') && !f.includes('corrupt')) writeFileSync(path.join(dir, f), 'x');
  w.kill();
  // The damaged file is moved aside before anything new is written.
  const kept = readdirSync(dir).filter((f) => f.startsWith('garbage.json.corrupt'));
  assert.ok(kept.length, 'the damaged file was destroyed');
  assert.match(readFileSync(path.join(dir, kept[0]), 'utf8'), /"teams"/);
});

// ------------------------------------------------------------------------
console.log('\nmessages that queue behind a turn');

for (const mode of ['turns', 'steer'] as const) {
  await test(`[${mode}] a fix pushed while the builder is still wrapping up: answered, never a false nag`, async () => {
    const w = new World(`queued-fix-${mode}`, mode);
    await toStage(w, 'building');
    w.rev = 'r2';
    await w.act('builder', 'report_result', { summary: REPORT, status: 'done' }); // still mid-turn
    await w.act('lead', 'assign', { member: 'builder', instructions: 'Also update the help text' }); // lead reacts at once
    w.end('lead');
    w.end('builder'); // the report turn ends
    w.check('after the report turn');
    if (mode === 'turns') {
      // The fix is its own next turn: nothing to nag about yet.
      assert.equal(nags(w, 'builder', /without a report/), 0, 'the builder was nagged for work it had not been shown');
      assert.ok(w.busy('builder'), 'the queued fix did not become its next turn');
    } else {
      // The fix was folded into the turn that just ended, and that turn ended
      // without a report on it: exactly one reminder is right.
      assert.equal(nags(w, 'builder', /without a report/), 1, 'an absorbed fix that went unreported needs one reminder');
      assert.ok(w.busy('builder'));
    }
    await drive(w, `queued-fix/${mode}`);
    shipped(w, `queued-fix/${mode}`);
  });

  await test(`[${mode}] a report that lands while the lead is mid-turn: acted on, never a silent stall`, async () => {
    const w = new World(`queued-lead-${mode}`, mode);
    w.hire();
    w.settle('builder', 'reviewer');
    await w.act('lead', 'assign', { member: 'builder', instructions: BUILD }); // the lead keeps working
    w.rev = 'r2';
    await w.act('builder', 'report_result', { summary: REPORT, status: 'done' });
    w.end('builder'); // pushed into the lead's live turn
    w.end('lead'); // that turn ends without another tool call
    w.check('after the lead’s turn');
    if (mode === 'turns') {
      assert.equal(nags(w, 'lead', /without moving the team/), 0, 'the lead was told it stalled while a report waited');
      assert.ok(w.busy('lead'), 'the report did not become the lead’s next turn');
    } else {
      assert.equal(nags(w, 'lead', /without moving the team/), 1, 'an absorbed report left unacted needs one reminder');
    }
    await drive(w, `queued-lead/${mode}`);
    shipped(w, `queued-lead/${mode}`);
  });
}

// ------------------------------------------------------------------------
console.log('\nthe human talking to members');

for (const mode of ['turns', 'steer'] as const) {
  await test(`[${mode}] chatting with the builder mid-assignment never nags it, and never hides who is waiting`, async () => {
    const w = new World(`chat-builder-${mode}`, mode);
    await toStage(w, 'building');
    await w.direct('builder', 'Use the existing args parser, please');
    w.end('builder'); // the assignment turn ends
    if (w.busy('builder')) w.end('builder'); // ('turns': it then answers you, without reporting)
    assert.equal(nags(w, 'builder', /without a report/), 0, 'your conversation got a nag injected into it');
    w.check('after the chat');
    const t = w.team();
    assert.ok(
      t.state === 'awaiting_human' && /builder/i.test(t.parkedReason ?? ''),
      'with nobody working, the panel must say the builder is waiting on you',
    );
    assert.equal(w.tc.continue_(w.id), true);
    assert.ok(w.busy('builder'), 'Continue should send the builder back to its assignment');
    assert.match(w.last('builder'), /--version flag to cli\.ts/);
    await drive(w, `chat-builder/${mode}`);
    shipped(w, `chat-builder/${mode}`);
  });

  await test(`[${mode}] chatting with the lead when nothing else is in flight: a visible hold, not a silent "working"`, async () => {
    const w = new World(`chat-lead-${mode}`, mode);
    await toStage(w, 'approved'); // the lead is mid-turn on the verdict
    await w.direct('lead', 'Hold on, do not merge yet');
    w.end('lead'); // the verdict turn ends without a tool
    if (w.busy('lead')) w.end('lead'); // ('turns': it answers you, "holding", and nothing else)
    assert.equal(nags(w, 'lead', /without moving the team/), 0, 'the lead was nagged over your conversation');
    w.check('after chatting with the lead');
    assert.equal(w.team().state, 'awaiting_human', 'nobody is working, so the panel must say so');
    assert.equal(w.tc.continue_(w.id), true);
    assert.ok(w.busy('lead'), 'Continue should hand the lead the ball back');
    await drive(w, `chat-lead/${mode}`);
    shipped(w, `chat-lead/${mode}`);
  });
}

await test('a chat that ended long ago does not soften a later, real stall', async () => {
  const w = new World('stale-chat');
  w.hire();
  w.settle('builder', 'reviewer');
  await w.direct('builder', 'Hi — what do you know about this repo so far?');
  w.end('builder'); // it answers; it owes nothing, so there is nothing to judge
  await w.act('lead', 'assign', { member: 'builder', instructions: BUILD });
  w.end('lead');
  w.end('builder'); // the ASSIGNMENT turn fizzles without a report
  assert.equal(nags(w, 'builder', /without a report/), 1, 'a real stall must still get its reminder');
  assert.equal(w.team().state, 'working');
});

await test('stopping the builder, then quitting: Continue still sends it back to its assignment', async () => {
  const w = new World('stop-then-quit');
  await toStage(w, 'building');
  w.agents.interrupt(w.sessionOf('builder')!); // the human's Stop on its desk
  assert.equal(w.team().state, 'awaiting_human');
  await w.quit();
  assert.equal(w.tc.continue_(w.id), true);
  assert.ok(w.busy('builder'));
  assert.match(w.last('builder'), /--version flag to cli\.ts/);
  await drive(w, 'stop-then-quit');
  shipped(w, 'stop-then-quit');
});

// ------------------------------------------------------------------------
console.log('\nmembers that fail');

await test('a member that failed is still named after a restart', async () => {
  const w = new World('failed-restart');
  await toStage(w, 'building');
  w.end('builder', { error: 'API Error: 529 overloaded' });
  assert.equal(w.team().state, 'awaiting_human');
  await w.quit();
  assert.equal(w.tc.continue_(w.id), true);
  assert.match(w.last('lead'), /failed/i, 'the lead must be told the builder failed, not "pick up where you left off"');
});

await test('a member whose conversation was deleted is started fresh with its assignment, not retried into the same wall', async () => {
  const w = new World('deleted-session');
  await toStage(w, 'building');
  const dead = w.sessionOf('builder')!;
  await w.quit();
  w.disk.sessions.delete(dead); // the transcript is gone (cleaned up, or deleted by hand)
  assert.equal(w.tc.continue_(w.id), true); // waking it fails: no such conversation
  w.check('after the wake-up hit a missing conversation');
  assert.ok(w.busy('builder'), 'the builder must be running again, in a new conversation');
  assert.notEqual(w.sessionOf('builder'), dead, 'it kept pointing at the conversation that no longer exists');
  assert.match(w.last('builder'), /--version flag to cli\.ts/, 'the fresh conversation needs the assignment');
  await drive(w, 'deleted-session');
  shipped(w, 'deleted-session');
});

await test('a fresh conversation that fails too parks with the reason instead of looping', async () => {
  const w = new World('deleted-twice');
  await toStage(w, 'building');
  const dead = w.sessionOf('builder')!;
  await w.quit();
  w.disk.sessions.delete(dead);
  w.tc.continue_(w.id);
  // The fresh one dies at once as well (say, the model is unavailable).
  w.end('builder', { error: 'API Error: model not available' });
  w.check('after the second failure');
  assert.equal(w.team().state, 'awaiting_human');
  assert.match(w.team().parkedReason ?? '', /error|not available/i);
});

await test('members that never got a conversation are briefed from scratch after a restart', async () => {
  const w = new World('no-session');
  w.hire();
  // airoom died before any session id came back.
  const saved = JSON.parse(readFileSync(w.file, 'utf8'));
  for (const s of saved.teams) {
    for (const m of s.members) m.sessionId = null;
    for (const m of s.team.members) m.sessionId = null;
  }
  writeFileSync(w.file, JSON.stringify(saved));
  w.kill();
  assert.equal(w.tc.continue_(w.id), true);
  assert.ok(w.busy('lead'), 'the lead was not started');
  assert.match(w.last('lead'), /--version flag/, 'a brand-new lead conversation must be given the task, not "pick up where you left off"');
  w.settle('builder', 'reviewer');
  await drive(w, 'no-session');
  shipped(w, 'no-session');
});

// ------------------------------------------------------------------------
console.log('\nholds that overlap');

await test('Continue after a restart releases a gate AND wakes the worker it interrupted in another lane', async () => {
  const w = new World('gate-and-owe');
  w.hire({ autonomy: 'gated', lanes: 2 });
  w.settle('builder', 'reviewer');
  await w.act('lead', 'assign', { member: 'builder', instructions: BUILD }); // parks: step-by-step
  w.end('lead');
  assert.equal(w.tc.continue_(w.id), true); // released: builder (lane 1) starts
  assert.ok(w.busy('builder'));
  // A second task lands in lane 2; the lead is told, and hands it to that crew.
  w.tc.addTask(w.id, 'Add a --help flag');
  w.settle('builder@2', 'reviewer@2');
  assert.ok(w.busy('lead'), 'the lead is told which lane took the new task');
  await w.act('lead', 'assign', { member: 'builder@2', instructions: 'Add the --help flag' }); // parks
  w.end('lead');
  assert.equal(w.team().state, 'awaiting_human');
  await w.quit(); // lane 1's builder dies mid-assignment
  assert.equal(w.tc.continue_(w.id), true);
  assert.ok(w.busy('builder@2'), 'the gated assignment was not released');
  assert.ok(w.busy('builder'), 'lane 1’s builder was left for dead — its task will never finish');
});

await test('a fix round parked at the cap survives a restart and is released exactly once', async () => {
  const w = new World('cap-restart');
  w.hire({ roundCap: 1 });
  w.settle('builder', 'reviewer');
  await w.act('lead', 'assign', { member: 'builder', instructions: BUILD });
  w.end('lead');
  for (let round = 0; round < 2; round++) {
    w.rev = `r${round + 2}`;
    await w.act('builder', 'report_result', { summary: REPORT, status: 'done' });
    w.end('builder');
    await w.act('lead', 'assign', { member: 'reviewer', instructions: REVIEW });
    w.end('lead');
    await w.act('reviewer', 'give_verdict', { verdict: 'request_changes', notes: 'handle -V too' });
    w.end('reviewer');
    await w.act('lead', 'assign', { member: 'builder', instructions: 'Handle -V as well' });
    w.end('lead');
  }
  const t = w.team();
  assert.equal(t.state, 'awaiting_human');
  assert.match(t.parkedReason ?? '', /cap/i);
  await w.quit();
  assert.match(w.team().parkedReason ?? '', /cap/i, 'a quit must not paper over the cap');
  const before = w.inbox('builder').length;
  assert.equal(w.tc.continue_(w.id), true);
  assert.equal(w.inbox('builder').length, before + 1, 'the parked fix must be delivered once');
  assert.match(w.last('builder'), /Handle -V as well/);
});

// ------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`(save files kept for inspection in ${dir})`);
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });
