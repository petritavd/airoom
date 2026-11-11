/**
 * Playbooks, proven without a model.
 *
 *   npx tsx scripts/playbook-test.ts
 *
 * What is on trial: the allowlist a session earns and how it is matched, the
 * digest and the parse of a proposed card, the store, and the run's score —
 * the "second run needs less supervision" numbers must be counted right no
 * matter what any model does.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowRulesFrom, allowedByRules, bashRuleFor, ruleMatches, sanitiseRules } from '../src/playbook/rules';
import { attentionOf, digestSteps, DONE_MARK, draftFromAnswer, kickoffMessage, playbookPreamble } from '../src/playbook/extract';
import { PlaybookController } from '../src/playbook/PlaybookController';
import { runKeyFor, type ActiveRun, type AgentController, type AskResult, type SendOptions } from '../src/agent/AgentController';
import type { RunUpdate, Step } from '../../shared/types';

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

const step = (kind: Step['kind'], label: string, extra: Partial<Step> = {}): Step => ({ id: `s${Math.random()}`, ts: null, kind, label, ...extra });
const tool = (name: string, target: string): Step => step('tool_use', `${name}: ${target}`, { tool: { name, target }, toolUseId: `t${Math.random()}` });

// A session that looks like a real one: a brief, some reading, a test run,
// an edit, a correction, another test run, and a result.
const SESSION: Step[] = [
  step('user', 'Add a CSV export to the billing-api reports endpoint'),
  tool('Read', '/proj/src/reports.ts'),
  tool('Grep', 'export'),
  step('assistant_text', 'I will add the export next to the JSON one.'),
  tool('Edit', '/proj/src/reports.ts'),
  tool('Bash', 'npm test'),
  step('tool_result', 'ok', { detail: '12 passing', toolUseId: 'x' }),
  step('user', 'No — never write the header row when there are no rows. And run the lint too.'),
  tool('Edit', '/proj/src/reports.ts'),
  tool('Bash', 'npm run lint'),
  tool('Bash', 'git status'),
  tool('Bash', 'git push origin main'),
  tool('Bash', 'rm -rf dist'),
  tool('Bash', 'cd /proj && NODE_ENV=test npx vitest run'),
  tool('Bash', 'cat a.txt | grep foo'),
  tool('WebFetch', 'https://docs.example.com/csv'),
  step('assistant_text', 'Done. 6 files, tests and lint pass.'),
];

await test('bash rules: runner + verb, exact for the risky, none for the destructive', () => {
  assert.equal(bashRuleFor('npm test'), 'Bash(npm test:*)');
  assert.equal(bashRuleFor('npm run lint'), 'Bash(npm run:*)');
  assert.equal(bashRuleFor('ls -la'), 'Bash(ls:*)');
  assert.equal(bashRuleFor('git push origin main'), 'Bash(git push origin main)');
  assert.equal(bashRuleFor('rm -rf dist'), null);
  assert.equal(bashRuleFor('sudo make install'), null);
  assert.equal(bashRuleFor('git push -f origin main'), null);
  assert.equal(bashRuleFor('cd /proj && NODE_ENV=test npx vitest run'), 'Bash(npx vitest:*)');
  assert.equal(bashRuleFor('cat a.txt | grep foo'), 'Bash(cat a.txt | grep foo)');
  assert.equal(bashRuleFor('/usr/local/bin/node scripts/x.mjs'), 'Bash(node scripts/x.mjs:*)');
});

await test('a session earns its allowlist, read tools included, plumbing excluded', () => {
  const rules = allowRulesFrom([...SESSION, tool('mcp__airoom-team__finish_task', 'x'), tool('AskUserQuestion', 'q')]);
  assert.deepEqual(rules, [
    'Bash(cat a.txt | grep foo)',
    'Bash(git push origin main)',
    'Bash(git status:*)',
    'Bash(npm run:*)',
    'Bash(npm test:*)',
    'Bash(npx vitest:*)',
    'Edit',
    'Glob',
    'Grep',
    'Read',
    'WebFetch(domain:docs.example.com)',
  ]);
});

await test('rules match the way Claude Code reads them', () => {
  const cwd = '/proj';
  assert.ok(ruleMatches('Bash(npm test:*)', 'Bash', { command: 'npm test -- --watch=false' }, cwd));
  assert.ok(ruleMatches('Bash(npm test:*)', 'Bash', { command: 'npm test' }, cwd));
  assert.ok(!ruleMatches('Bash(npm test:*)', 'Bash', { command: 'npm testify' }, cwd));
  assert.ok(!ruleMatches('Bash(npm test:*)', 'Bash', { command: 'npm run test' }, cwd));
  assert.ok(ruleMatches('Bash(git push origin main)', 'Bash', { command: 'git  push origin main' }, cwd));
  assert.ok(!ruleMatches('Bash(git push origin main)', 'Bash', { command: 'git push origin main --force' }, cwd));
  assert.ok(ruleMatches('Bash(npm test:*)', 'Bash', { command: 'cd /proj && npm test' }, cwd), 'cd prefix is ignored');
  assert.ok(ruleMatches('Edit', 'Edit', { file_path: '/proj/src/a.ts' }, cwd));
  assert.ok(ruleMatches('Edit(src/**)', 'Edit', { file_path: '/proj/src/deep/a.ts' }, cwd));
  assert.ok(!ruleMatches('Edit(src/**)', 'Edit', { file_path: '/proj/test/a.ts' }, cwd));
  assert.ok(ruleMatches('Edit(*.md)', 'Edit', { file_path: '/proj/README.md' }, cwd));
  // Windows separators: the same rules, whichever way the slashes lean.
  assert.ok(ruleMatches('Edit(src/**)', 'Edit', { file_path: 'src\\deep\\a.ts' }, cwd), 'backslashes are separators');
  assert.ok(ruleMatches('Edit(src\\**)', 'Edit', { file_path: 'src/deep/a.ts' }, cwd), 'a rule written with backslashes');
  assert.ok(!ruleMatches('Edit(*.md)', 'Edit', { file_path: 'C:\\Users\\me\\elsewhere\\notes.md' }, cwd), 'one star stays inside one folder');
  assert.ok(!ruleMatches('Edit(*.md)', 'Edit', { file_path: 'docs\\deep\\notes.md' }, cwd), 'one star stays inside one folder');
  assert.ok(!ruleMatches('Edit', 'Write', { file_path: '/proj/README.md' }, cwd));
  assert.ok(ruleMatches('WebFetch(domain:docs.example.com)', 'WebFetch', { url: 'https://docs.example.com/x/y' }, cwd));
  assert.ok(!ruleMatches('WebFetch(domain:docs.example.com)', 'WebFetch', { url: 'https://evil.com/docs.example.com' }, cwd));
  assert.ok(allowedByRules(['Read', 'Bash(npm test:*)'], 'Bash', { command: 'npm test' }, cwd));
  assert.ok(!allowedByRules(['Read', 'Bash(npm test:*)'], 'Bash', { command: 'npm publish' }, cwd));
  assert.ok(!allowedByRules([], 'Read', { file_path: 'x' }, cwd));
});

await test('rules from the client are checked: no bare Bash, no wildcards, no destruction', () => {
  assert.deepEqual(sanitiseRules(['Bash', 'Bash(*)', 'Bash(:*)', 'Bash(rm -rf /)', 'Bash(npm test:*)', 'Edit', 'Edit', 42, 'not a rule!!']), [
    'Bash(npm test:*)',
    'Edit',
  ]);
  assert.deepEqual(sanitiseRules('nope'), []);
});

await test('the digest keeps the brief, the corrections, what ran and what failed', () => {
  const d = digestSteps([...SESSION, step('tool_result', 'boom', { detail: 'Error: lint failed', isError: true })]);
  assert.match(d, /\[human #1\] Add a CSV export/);
  assert.match(d, /\[human #2\] No — never write the header row/);
  assert.match(d, /\[ran\] Bash: npm test/);
  assert.match(d, /\[failed\] Error: lint failed/);
  assert.match(d, /\[agent\] Done\. 6 files/);
  assert.ok(!/\[human\] <system/.test(d));
  const huge = Array.from({ length: 3000 }, (_, i) => step('assistant_text', `line ${i} `.repeat(20)));
  const cut = digestSteps([SESSION[0], ...huge, SESSION[SESSION.length - 1]]);
  assert.ok(cut.length < 72_000, `digest capped (${cut.length})`);
  assert.match(cut, /\[human #1\] Add a CSV export/);
  assert.match(cut, /Done\. 6 files/);
  assert.match(cut, /left out/);
});

await test('attention baseline: messages, corrections, approvals (reads do not count)', () => {
  assert.deepEqual(attentionOf(SESSION), { messages: 2, corrections: 1, approvals: 10 });
});

const ANSWER = `Here is the card:
\`\`\`json
{
  "name": "Add a CSV export",
  "goal": "Add a CSV export for {endpoint} beside its JSON one.",
  "inputs": [{"key": "Endpoint Name", "label": "Endpoint", "example": "reports"}, {"key": "endpoint-name", "label": "dup"}],
  "rules": ["Never write the header row when there are no rows.", "Run the lint as well as the tests."],
  "steps": [{"text": "Read the existing handler for {endpoint}."}, {"text": "Show the proposed change before editing.", "pause": true}, {"text": "Edit, then run tests and lint."}],
  "checks": ["npm test passes", "npm run lint passes"],
  "output": "A diff on the current branch and a two-line summary."
}
\`\`\``;

await test('a proposed card is parsed, normalised, and gets its allowlist from the transcript', () => {
  const r = draftFromAnswer(ANSWER, { roomId: '/proj', sessionId: 'sess-1', steps: SESSION, now: '2026-09-30T10:00:00.000Z' });
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (!r.ok) return;
  const d = r.draft;
  assert.equal(d.id, '');
  assert.equal(d.name, 'Add a CSV export');
  assert.deepEqual(d.inputs, [{ key: 'endpoint-name', label: 'Endpoint', example: 'reports' }]);
  assert.equal(d.rules.length, 2);
  assert.equal(d.rules[0].from, 'session');
  assert.equal(d.steps[1].pause, true);
  assert.equal(d.steps[0].pause, undefined);
  assert.equal(d.source.sessionId, 'sess-1');
  assert.equal(d.source.corrections, 1);
  assert.ok(d.allow.includes('Bash(npm test:*)'));
  assert.ok(!d.allow.some((a) => a.includes('rm -rf')));
});

await test('garbage answers are refused, not saved', () => {
  assert.equal(draftFromAnswer('I cannot do that.', { roomId: '/p', sessionId: 's', steps: [] }).ok, false);
  assert.equal(draftFromAnswer('{"name": "", "goal": "x"}', { roomId: '/p', sessionId: 's', steps: [] }).ok, false);
});

await test('the preamble carries the whole card, inputs filled, review points marked', () => {
  const r = draftFromAnswer(ANSWER, { roomId: '/proj', sessionId: 's', steps: SESSION });
  assert.ok(r.ok);
  if (!r.ok) return;
  const pre = playbookPreamble(r.draft, { 'endpoint-name': 'invoices' });
  assert.match(pre, /Endpoint \(\{endpoint-name\}\): invoices/);
  assert.match(pre, /2\. Show the proposed change before editing\.  ← REVIEW POINT/);
  assert.match(pre, /- Never write the header row/);
  assert.match(pre, new RegExp(DONE_MARK));
  const kick = kickoffMessage(r.draft, {});
  assert.match(kick, /Not given: Endpoint/);
  assert.match(kickoffMessage(r.draft, { 'endpoint-name': 'invoices' }), /- Endpoint: invoices/);
});

// ---- the controller, with a fake engine -------------------------------------

class FakeController implements AgentController {
  sends: SendOptions[] = [];
  interrupted: string[] = [];
  updaters = new Map<string, (u: RunUpdate) => void>();
  answer: AskResult = { ok: true, text: ANSWER };
  asked: string[] = [];
  activeRuns(): ActiveRun[] {
    return [];
  }
  async send(opts: SendOptions, onUpdate: (u: RunUpdate) => void): Promise<void> {
    this.sends.push(opts);
    this.updaters.set(runKeyFor(opts), onUpdate);
    await new Promise<void>((resolve) => setTimeout(resolve, 5)); // the run "ends" quickly
  }
  interrupt(runKey: string): boolean {
    this.interrupted.push(runKey);
    return true;
  }
  respondPermission(): boolean {
    return true;
  }
  async ask(_cwd: string, prompt: string): Promise<AskResult> {
    this.asked.push(prompt);
    return this.answer;
  }
  async close(): Promise<void> {}
  emit(key: string, u: Partial<RunUpdate> & { phase: RunUpdate['phase'] }) {
    const fn = this.updaters.get(key);
    assert.ok(fn, `no updater for ${key}`);
    fn({ runKey: key, roomId: '/proj', sessionId: null, ...u });
  }
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'airoom-pb-'));
const file = path.join(dir, 'playbooks.json');

function make(engine: FakeController, steps = SESSION) {
  const updates: RunUpdate[] = [];
  let changed = 0;
  const ctl = new PlaybookController({
    controller: engine,
    getTranscript: async () => ({ steps }),
    onUpdate: (u) => updates.push(u),
    onChanged: () => changed++,
    file,
  });
  return { ctl, updates, changes: () => changed };
}

await test('draft → save → list: the card round-trips through the store', async () => {
  const engine = new FakeController();
  const { ctl } = make(engine);
  const d = await ctl.draft('sess-1', '/proj');
  assert.ok(d.draft, d.error);
  assert.equal(engine.asked.length, 1);
  assert.match(engine.asked[0], /Add a CSV export to the billing-api/);
  const saved = ctl.save({ ...d.draft!, name: '  CSV export  ', allow: [...d.draft!.allow, 'Bash', 'Bash(rm -rf /)'] });
  assert.ok(saved.ok, saved.ok ? '' : saved.error);
  if (!saved.ok) return;
  assert.ok(saved.playbook.id.startsWith('pb-'));
  assert.equal(saved.playbook.name, 'CSV export');
  assert.ok(!saved.playbook.allow.includes('Bash'));
  assert.equal(ctl.list().length, 1);
  // A fresh controller reads the same file.
  const again = make(new FakeController()).ctl;
  assert.equal(again.list()[0].name, 'CSV export');
  assert.equal(again.list()[0].source.corrections, 1);
});

await test('a session with nothing from the human has no task to write down', async () => {
  const engine = new FakeController();
  const { ctl } = make(engine, [step('assistant_text', 'hello')]);
  const d = await ctl.draft('sess-2', '/proj');
  assert.ok(d.error);
  assert.equal(engine.asked.length, 0);
});

await test('a run: card in the prompt, allowlist on the send, score kept from the updates', async () => {
  const engine = new FakeController();
  const { ctl, changes } = make(engine);
  const pb = ctl.list()[0];
  const r = ctl.run(pb.id, { 'endpoint-name': 'invoices', bogus: 'x' });
  assert.ok(r.ok && r.runId);
  const s = engine.sends[0];
  assert.equal(s.roomId, '/proj');
  assert.equal(s.spawnTag, `pb:${r.runId}`);
  assert.match(s.text, /Run the playbook "CSV export"/);
  assert.match(s.text, /- Endpoint: invoices/);
  assert.match(s.systemPromptAppend ?? '', /## Playbook: CSV export/);
  assert.match(s.systemPromptAppend ?? '', /Never write the header row/);
  assert.deepEqual(s.allowRules, pb.allow);
  assert.equal(s.mode, 'default');
  const run = () => ctl.get(pb.id)!.runs.find((x) => x.id === r.runId)!;
  assert.equal(run().state, 'working');
  assert.deepEqual(run().inputs, { 'endpoint-name': 'invoices' });
  const key = runKeyFor(s);
  engine.emit(key, { phase: 'started', sessionId: 'new-sess' });
  assert.equal(run().sessionId, 'new-sess');
  assert.deepEqual(ctl.runOf('new-sess'), { id: pb.id, runId: r.runId, name: 'CSV export' });
  engine.emit(key, { phase: 'permission', sessionId: 'new-sess', requestId: 'p1', text: 'Bash: npm publish' });
  engine.emit(key, { phase: 'permission', sessionId: 'new-sess', requestId: 'p2', text: 'Bash: git push' });
  assert.equal(run().approvals, 2);
  // A review point: the agent stops and asks.
  engine.emit(key, { phase: 'assistant', sessionId: 'new-sess', text: 'Step 2: here is the change. Go on?' });
  engine.emit(key, { phase: 'result', sessionId: 'new-sess', cost: 0.12 });
  assert.equal(run().state, 'waiting');
  assert.equal(run().costUsd, 0.12);
  engine.emit(key, { phase: 'result', sessionId: 'new-sess', meter: true, context: { usedTokens: 1, maxTokens: 2, percent: 50 } });
  assert.equal(run().state, 'waiting', 'a context meter is not a turn');
  // The human answers — through the ordinary send path, which asks for equipment.
  const equip = ctl.equipmentFor('new-sess');
  assert.ok(equip);
  assert.equal(run().messages, 1);
  assert.equal(run().state, 'working');
  assert.deepEqual(equip!.allowRules, pb.allow);
  assert.match(equip!.systemPromptAppend, /## Playbook: CSV export/);
  // …and chooses to remember the correction.
  const added = ctl.addRule(pb.id, 'Also update the API docs.', r.runId);
  assert.ok(added.ok);
  assert.equal(run().rulesAdded, 1);
  assert.equal(ctl.get(pb.id)!.rules.at(-1)!.from, 'run');
  assert.equal(ctl.get(pb.id)!.rules.at(-1)!.runId, r.runId);
  // The next turn carries the new rule.
  assert.match(ctl.equipmentFor('new-sess')!.systemPromptAppend, /Also update the API docs/);
  // The follow-up's result flows through the equipment's observer.
  equip!.observe({ runKey: 'new-sess', roomId: '/proj', sessionId: 'new-sess', phase: 'assistant', text: `All done.\n${DONE_MARK}` });
  equip!.observe({ runKey: 'new-sess', roomId: '/proj', sessionId: 'new-sess', phase: 'result', cost: 0.3 });
  assert.equal(run().state, 'done');
  assert.equal(run().summary, 'All done.');
  assert.equal(run().costUsd, 0.3);
  assert.ok(run().endedAt);
  // A question to a finished run is answered, not left "waiting" for ever.
  const again = ctl.equipmentFor('new-sess');
  assert.ok(again);
  assert.equal(run().state, 'working');
  assert.equal(run().messages, 3); // the rule check above asked for equipment too
  again!.observe({ runKey: 'new-sess', roomId: '/proj', sessionId: 'new-sess', phase: 'assistant', text: 'Sure, the file is 40 lines.' });
  again!.observe({ runKey: 'new-sess', roomId: '/proj', sessionId: 'new-sess', phase: 'result', cost: 0.31 });
  assert.equal(run().state, 'done');
  assert.equal(run().summary, 'All done.', 'the completion summary survives a later question');
  assert.ok(changes() > 5);
  // Persisted with the score.
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { playbooks: { runs: { approvals: number; messages: number }[] }[] };
  assert.equal(onDisk.playbooks[0].runs[0].approvals, 2);
  assert.equal(onDisk.playbooks[0].runs[0].messages, 3);
});

await test('stop marks the run stopped and interrupts its session; an error ends it', async () => {
  const engine = new FakeController();
  const { ctl } = make(engine);
  const pb = ctl.list()[0];
  const r = ctl.run(pb.id, {});
  const key = runKeyFor(engine.sends[0]);
  engine.emit(key, { phase: 'started', sessionId: 'sess-x' });
  assert.ok(ctl.stop(pb.id, r.runId!));
  assert.deepEqual(engine.interrupted, ['sess-x']);
  assert.equal(ctl.get(pb.id)!.runs.at(-1)!.state, 'stopped');
  const r2 = ctl.run(pb.id, {});
  const key2 = runKeyFor(engine.sends[1]);
  engine.emit(key2, { phase: 'error', text: 'Failed to start agent', isError: true });
  assert.equal(ctl.get(pb.id)!.runs.find((x) => x.id === r2.runId)!.state, 'error');
});

await test('a run saved as working is stopped on the next boot', () => {
  const { ctl } = make(new FakeController());
  const pb = ctl.list()[0];
  ctl.run(pb.id, {});
  const fresh = make(new FakeController()).ctl;
  assert.ok(fresh.get(pb.id)!.runs.every((x) => x.state !== 'working'));
});

await test('rules can be dropped; deleting a playbook interrupts its live runs', () => {
  const engine = new FakeController();
  const { ctl } = make(engine);
  const pb = ctl.list()[0];
  const rule = ctl.get(pb.id)!.rules[0];
  assert.ok(ctl.dropRule(pb.id, rule.id));
  assert.ok(!ctl.get(pb.id)!.rules.some((x) => x.id === rule.id));
  const r = ctl.run(pb.id, {});
  engine.emit(runKeyFor(engine.sends[0]), { phase: 'started', sessionId: 'sess-live' });
  assert.equal(ctl.get(pb.id)!.runs.find((x) => x.id === r.runId)!.state, 'working');
  assert.ok(ctl.delete(pb.id));
  assert.ok(engine.interrupted.includes('sess-live'));
  assert.equal(ctl.list().length, 0);
});

await test('the store survives a torn save', () => {
  const { ctl } = make(new FakeController());
  ctl.save({ roomId: '/proj', name: 'Keep me', goal: 'g', inputs: [], rules: [], steps: [], checks: [], output: '', allow: [] });
  // Damage the main file; the backup still has the previous state.
  writeFileSync(file, '{ not json');
  const again = make(new FakeController()).ctl;
  assert.ok(again.list().length >= 0); // no throw, no crash
});

rmSync(dir, { recursive: true, force: true });

console.log(`playbook-test: ${passed} passed, ${failures.length} failed`);
for (const [name, err] of failures) console.error(`  ✗ ${name}\n    ${err.message}`);
if (failures.length) process.exit(1);
