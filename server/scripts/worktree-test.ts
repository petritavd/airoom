/**
 * Lanes, against real git.
 *
 *   npm test   (tsx scripts/worktree-test.ts)
 *
 * Everything else in the team suite stubs git out. This one does not: it makes
 * a throwaway repository in a temp directory and runs the actual commands,
 * because this is the code that touches the USER'S repository. The properties
 * on trial are the ones that would cost someone real work — a merge must never
 * run over uncommitted changes to tracked files, a conflict must leave the
 * project folder exactly as it found it, a lane's second task must start from
 * the project as it is NOW, and nothing here may ever delete a branch that
 * still holds work.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeLane,
  commitLane,
  currentBranch,
  dirtyFiles,
  hasCommits,
  isGitRepo,
  laneHasWork,
  mergeBranch,
  openLane,
  repoRoot,
  startBranch,
} from '../src/team/worktrees';

let passed = 0;
const failures: Array<[string, Error]> = [];
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

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const root = mkdtempSync(path.join(os.tmpdir(), 'airoom-wt-'));
// Lanes are cut under this instead of the real ~/.airoom, so a test run leaves
// nothing behind in anyone's home directory.
process.env.AIROOM_LANES_DIR = path.join(root, 'lanes');
let seq = 0;
/** Each test gets its own team id: lanes are keyed by it. */
const team = () => `team-${++seq}`;

/** A fresh repository on `main` with one commit and a file to fight over. */
function repo(): string {
  const dir = path.join(root, `r${++seq}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@airoom.local']);
  git(dir, ['config', 'user.name', 'airoom test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // Git for Windows checks out with CRLF by default; these tests read merged
  // files back byte for byte, and a worktree inherits the setting.
  git(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(path.join(dir, 'shared.txt'), 'one\ntwo\nthree\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'first']);
  return dir;
}

const branches = (dir: string) => git(dir, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean).sort();

console.log('\nlanes, against real git');

await test('a lane is a worktree on a branch named after its task, off the project branch', () => {
  const dir = repo();
  assert.equal(isGitRepo(dir), true);
  // .native expands Windows 8.3 short names (RUNNER~1), which git never uses.
  assert.equal(repoRoot(dir), realpathSync.native(dir));
  assert.equal(hasCommits(dir), true);
  assert.equal(currentBranch(dir), 'main');
  const lane = openLane(dir, team(), 'lane-1', 'Fix the parser', 'main');
  assert.ok(lane, 'the lane was not cut');
  assert.equal(lane.branch, 'airoom/fix-the-parser');
  assert.ok(existsSync(path.join(lane.path, 'shared.txt')), 'the lane is a real checkout');
  assert.equal(git(lane.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'airoom/fix-the-parser');
  closeLane(dir, lane);
  assert.equal(existsSync(lane.path), false, 'a closed lane leaves no folder behind');
});

await test('two tasks with the same name get two branches', () => {
  const dir = repo();
  const id = team();
  const a = openLane(dir, id, 'lane-1', 'Docs', 'main')!;
  const b = openLane(dir, id, 'lane-2', 'Docs', 'main')!;
  assert.notEqual(a.path, b.path);
  assert.deepEqual([a.branch, b.branch], ['airoom/docs', 'airoom/docs-2']);
});

await test("a lane's work is committed and merged back into the project", () => {
  const dir = repo();
  const lane = openLane(dir, team(), 'lane-1', 'Add new', 'main')!;
  writeFileSync(path.join(lane.path, 'new.txt'), 'from the lane\n');
  assert.equal(laneHasWork(lane, dir, 'main'), true);
  const c = commitLane(lane, 'airoom: add new.txt');
  assert.deepEqual({ ok: c.ok, committed: c.committed }, { ok: true, committed: true });
  assert.deepEqual(mergeBranch(dir, lane.branch, 'add new.txt', 'main'), { ok: true });
  assert.equal(readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'from the lane\n', 'the work arrived in the project');
  assert.equal(dirtyFiles(dir), 0, 'the merge left the project folder clean');
});

await test('a lane that changed nothing merges as empty rather than failing', () => {
  const dir = repo();
  const lane = openLane(dir, team(), 'lane-1', 'Nothing', 'main')!;
  assert.equal(laneHasWork(lane, dir, 'main'), false);
  assert.deepEqual(mergeBranch(dir, lane.branch, 'nothing', 'main'), { ok: true, empty: true });
});

await test('a conflict is reported by file and the project folder is left untouched', () => {
  const dir = repo();
  const lane = openLane(dir, team(), 'lane-1', 'Shared edit', 'main')!;
  // Both sides edit the same line — the case that must never be resolved by a
  // machine while the human is not looking.
  writeFileSync(path.join(lane.path, 'shared.txt'), 'one\nLANE\nthree\n');
  commitLane(lane, 'lane edit');
  writeFileSync(path.join(dir, 'shared.txt'), 'one\nMAIN\nthree\n');
  git(dir, ['commit', '-qam', 'main edit']);

  const res = mergeBranch(dir, lane.branch, 'shared edit', 'main');
  assert.equal(res.ok, false);
  assert.deepEqual(res.conflicts, ['shared.txt']);
  assert.equal(readFileSync(path.join(dir, 'shared.txt'), 'utf8'), 'one\nMAIN\nthree\n', 'no conflict markers in the project');
  assert.equal(dirtyFiles(dir), 0, 'the aborted merge left nothing behind');
  assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  // The work is not lost: it is still on the branch, for the human to resolve.
  assert.equal(git(dir, ['show', `${lane.branch}:shared.txt`]), 'one\nLANE\nthree');
});

await test('a merge refuses to run over uncommitted edits to tracked files', () => {
  const dir = repo();
  const lane = openLane(dir, team(), 'lane-1', 'x', 'main')!;
  writeFileSync(path.join(lane.path, 'new.txt'), 'x\n');
  commitLane(lane, 'lane edit');
  writeFileSync(path.join(dir, 'shared.txt'), 'my own half-finished edit\n');
  const res = mergeBranch(dir, lane.branch, 'anything', 'main');
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /uncommitted/);
  assert.equal(readFileSync(path.join(dir, 'shared.txt'), 'utf8'), 'my own half-finished edit\n', 'the edit survived');
});

await test('an empty branch merges even over a dirty project — there is nothing to collide', () => {
  const dir = repo();
  const lane = openLane(dir, team(), 'lane-1', 'Nothing', 'main')!;
  writeFileSync(path.join(dir, 'shared.txt'), 'my own half-finished edit\n');
  assert.deepEqual(mergeBranch(dir, lane.branch, 'nothing', 'main'), { ok: true, empty: true });
  assert.equal(readFileSync(path.join(dir, 'shared.txt'), 'utf8'), 'my own half-finished edit\n', 'untouched');
});

await test('…but an untracked file in the project is not a reason to refuse', () => {
  // A build folder or a scratch file cannot be swept into the merge commit and
  // cannot be clobbered by it (git refuses on its own if the branch adds the
  // same path). Refusing on those made merges park on nearly every real
  // project, where something untracked is always lying around.
  const dir = repo();
  const lane = openLane(dir, team(), 'lane-1', 'x', 'main')!;
  writeFileSync(path.join(lane.path, 'new.txt'), 'x\n');
  commitLane(lane, 'lane edit');
  writeFileSync(path.join(dir, 'scratch.log'), 'not tracked\n');
  assert.deepEqual(mergeBranch(dir, lane.branch, 'x', 'main'), { ok: true });
  assert.ok(existsSync(path.join(dir, 'scratch.log')), 'and it is still there');
});

await test('a merge refuses when the project has moved to another branch', () => {
  // The work forked from main and belongs on main — not on whatever the human
  // happened to check out this afternoon.
  const dir = repo();
  const lane = openLane(dir, team(), 'lane-1', 'x', 'main')!;
  writeFileSync(path.join(lane.path, 'new.txt'), 'x\n');
  commitLane(lane, 'lane edit');
  git(dir, ['checkout', '-q', '-b', 'feature']);
  const res = mergeBranch(dir, lane.branch, 'x', 'main');
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /on feature now, not main/);
  assert.equal(existsSync(path.join(dir, 'new.txt')), false, 'nothing landed on the wrong branch');
  git(dir, ['checkout', '-q', 'main']);
  assert.deepEqual(mergeBranch(dir, lane.branch, 'x', 'main'), { ok: true }, 'and works again once back');
});

await test("a lane's next task starts from the project as it is NOW", () => {
  // The bug this covers: one branch per lane, reused forever, so the second
  // task in lane 1 started from the first task's world and never saw what lane
  // 2 had merged in the meantime.
  const dir = repo();
  const lane = openLane(dir, team(), 'lane-1', 'First', 'main')!;
  writeFileSync(path.join(lane.path, 'first.txt'), 'a\n');
  commitLane(lane, 'first');
  assert.deepEqual(mergeBranch(dir, lane.branch, 'first', 'main'), { ok: true });
  // Meanwhile somebody else — another lane, or the human — moved main on.
  writeFileSync(path.join(dir, 'elsewhere.txt'), 'b\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'elsewhere']);

  const r = startBranch(lane, dir, 'main', 'Second');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.branch, 'airoom/second');
  assert.ok(existsSync(path.join(lane.path, 'elsewhere.txt')), 'the lane sees what landed on main since');
  assert.equal(git(lane.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'airoom/second');
  assert.ok(!branches(dir).includes('airoom/first'), 'the merged branch it left behind is tidied away');
});

await test('switching a lane keeps whatever the last task left loose, on its own branch', () => {
  const dir = repo();
  const lane = openLane(dir, team(), 'lane-1', 'Cancelled', 'main')!;
  writeFileSync(path.join(lane.path, 'half.txt'), 'half done, never committed\n');
  const r = startBranch(lane, dir, 'main', 'Next');
  assert.equal(r.ok, true, r.error);
  assert.ok(branches(dir).includes('airoom/cancelled'), 'an unmerged branch is work, and stays');
  assert.equal(git(dir, ['show', 'airoom/cancelled:half.txt']), 'half done, never committed', 'the loose file is on it');
  assert.equal(existsSync(path.join(lane.path, 'half.txt')), false, 'and the new task starts clean');
});

await test('closing a lane commits loose work before the folder goes', () => {
  const dir = repo();
  const lane = openLane(dir, team(), 'lane-1', 'Unfinished', 'main')!;
  writeFileSync(path.join(lane.path, 'new.txt'), 'unmerged\n');
  closeLane(dir, lane);
  assert.equal(existsSync(lane.path), false, 'the folder goes');
  assert.equal(git(dir, ['show', `${lane.branch}:new.txt`]), 'unmerged', 'the work did not go with it');
  assert.ok(branches(dir).includes(lane.branch), 'the branch stays — it is work');
});

await test('a merged lane takes its branch with it when closed', () => {
  const dir = repo();
  const lane = openLane(dir, team(), 'lane-1', 'Merged', 'main')!;
  writeFileSync(path.join(lane.path, 'new.txt'), 'merged\n');
  commitLane(lane, 'lane edit');
  assert.equal(mergeBranch(dir, lane.branch, 'x', 'main').ok, true);
  closeLane(dir, lane);
  assert.ok(!branches(dir).includes(lane.branch), 'a merged branch is tidied away');
});

await test('a folder that is not a repository refuses lanes instead of throwing', () => {
  const plain = path.join(root, 'plain');
  mkdirSync(plain, { recursive: true });
  assert.equal(isGitRepo(plain), false);
  assert.equal(repoRoot(plain), null);
  assert.equal(openLane(plain, team(), 'lane-1', 'x', 'main'), null);
});

await test('a repository with no commits has nothing to branch from', () => {
  const empty = path.join(root, 'empty');
  mkdirSync(empty, { recursive: true });
  git(empty, ['init', '-q', '-b', 'main']);
  assert.equal(isGitRepo(empty), true);
  assert.equal(hasCommits(empty), false);
  assert.equal(openLane(empty, team(), 'lane-1', 'x', 'main'), null);
});

console.log('\na team running two lanes, for real');

/**
 * The whole loop against a real repository: two tasks, two worktrees, two
 * crews, both merged back. Only the models are faked — every git operation
 * here is the one that would run on the user's own project.
 */
await (async () => {
  const { TeamController } = await import('../src/team/TeamController');
  const sends: { tag: string; roomId: string }[] = [];
  const controller = {
    activeRuns: () => [],
    async send(opts: { spawnTag?: string; roomId: string }) {
      sends.push({ tag: opts.spawnTag ?? '', roomId: opts.roomId });
    },
    interrupt: () => true,
    respondPermission: () => true,
    async close() {},
  };
  const dir = repo();
  const tc = new TeamController({
    controller: controller as never,
    onUpdate: () => {},
    onHandoff: () => {},
    onTeamsChanged: () => {},
    file: path.join(root, 'e2e-teams.json'),
  });
  const hired = tc.hire({ roomId: dir, task: 'Add the header', autonomy: 'auto', lanes: 2 });
  const id = hired.teamId!;
  const lead = tc.handlersFor(id, 'lead');
  /** The lane's reviewer signs off on the task as it stands — the gate insists. */
  const approveLane = async (title: string) => {
    const lane = tc.list()[0].tasks.find((t) => t.title === title)!.lane!;
    await tc.handlersFor(id, lane === 1 ? 'reviewer' : `reviewer@${lane}`).give_verdict({ verdict: 'approve', notes: 'looked, fine' });
  };
  const laneOf = (title: string) => [...tc.laneRooms().entries()].find(([, i]) => i.task === title)!;

  await test('hiring with lanes cuts a real worktree, on the first task’s branch, and staffs it there', () => {
    assert.equal(hired.ok, true, hired.error);
    const t = tc.list()[0];
    assert.equal(t.lanes, 2);
    assert.equal(t.worktrees, true, 'a git repo with commits gets real lanes');
    assert.equal(tc.laneRooms().size, 1, 'only the lane in use exists');
    const [cwd, info] = [...tc.laneRooms()][0];
    assert.ok(existsSync(path.join(cwd, 'shared.txt')), 'the crew works in a real checkout');
    assert.equal(info.homeRoomId, dir);
    assert.equal(info.branch, 'airoom/add-the-header', 'the branch is named after the task, not the lane');
    assert.equal(t.tasks[0].branch, 'airoom/add-the-header');
    assert.equal(sends.find((x) => x.tag.endsWith(':lead'))!.roomId, dir, 'the lead stays in the project');
    assert.equal(sends.find((x) => x.tag.endsWith(':builder'))!.roomId, cwd, 'the crew is inside the lane');
  });

  await lead.add_task({ title: 'Footer', brief: 'Add the footer' });

  await test('a second task opens a second worktree beside the first', () => {
    assert.equal(tc.laneRooms().size, 2);
    const paths = [...tc.laneRooms().keys()];
    assert.notEqual(paths[0], paths[1]);
    for (const p of paths) assert.ok(existsSync(p), `${p} is a real folder`);
    assert.ok(sends.some((x) => x.tag.endsWith(':builder@2') && x.roomId === paths[1]), 'the second crew was staffed in the second lane');
  });

  await test('each lane commits and merges its own work, independently', async () => {
    writeFileSync(path.join(laneOf('Add the header')[0], 'header.txt'), 'header\n');
    writeFileSync(path.join(laneOf('Footer')[0], 'footer.txt'), 'footer\n');
    await approveLane('Add the header');
    await lead.finish_task({ task: 'Add the header', summary: 'header done' });
    assert.equal(readFileSync(path.join(dir, 'header.txt'), 'utf8'), 'header\n', 'lane 1 arrived');
    assert.equal(existsSync(path.join(dir, 'footer.txt')), false, 'lane 2 has not been closed yet');
    await approveLane('Footer');
    await lead.finish_task({ task: 'Footer', summary: 'footer done' });
    assert.equal(readFileSync(path.join(dir, 'footer.txt'), 'utf8'), 'footer\n', 'lane 2 arrived too');
    assert.equal(dirtyFiles(dir), 0, 'the project folder is clean after both merges');
    assert.deepEqual(tc.list()[0].tasks.map((t) => t.state), ['merged', 'merged']);
  });

  await test('the next task in a lane starts from everything that has merged', async () => {
    // Lane 1 merged the header, lane 2 the footer. A third task in lane 1 must
    // see BOTH — the first version left it on the header branch, blind to the
    // footer, so its first edit to a shared file was a conflict in waiting.
    await lead.add_task({ title: 'Third', brief: 'Uses both' });
    const [cwd, info] = laneOf('Third');
    assert.equal(info.lane, 1, 'it took the first free lane');
    assert.equal(info.branch, 'airoom/third', 'on a branch of its own');
    assert.ok(existsSync(path.join(cwd, 'header.txt')), 'sees lane 1’s merge');
    assert.ok(existsSync(path.join(cwd, 'footer.txt')), 'sees lane 2’s merge');
    assert.ok(!branches(dir).includes('airoom/add-the-header'), 'the merged branch it replaced is gone');
    await approveLane('Third');
    await lead.finish_task({ task: 'Third', summary: 'nothing changed' });
  });

  await test('a conflict parks that lane and leaves the others alone', async () => {
    await lead.add_task({ title: 'Rewrite', brief: 'Rewrite shared.txt' });
    await lead.add_task({ title: 'Quiet', brief: 'Touch nothing important' });
    writeFileSync(path.join(laneOf('Rewrite')[0], 'shared.txt'), 'one\nLANE\nthree\n');
    writeFileSync(path.join(dir, 'shared.txt'), 'one\nHUMAN\nthree\n');
    git(dir, ['commit', '-qam', 'my own edit']);

    await approveLane('Rewrite');
    const answer = await lead.finish_task({ task: 'Rewrite', summary: 'rewritten' });
    assert.match(answer, /conflict/i);
    assert.match(answer, /shared\.txt/);
    const t = tc.list()[0];
    assert.equal(t.state, 'awaiting_human', 'a conflict is the human’s to settle');
    assert.equal(t.tasks.find((x) => x.title === 'Rewrite')!.state, 'blocked');
    assert.equal(t.tasks.find((x) => x.title === 'Quiet')!.state, 'working', 'the other lane carries on');
    assert.equal(readFileSync(path.join(dir, 'shared.txt'), 'utf8'), 'one\nHUMAN\nthree\n', 'the project was not touched');
    assert.equal(dirtyFiles(dir), 0);
  });

  await test('a retried merge, once the human has settled it, frees the lane and lets the queue in', async () => {
    // Lane 1 is blocked on the conflict and lane 2 is busy with Quiet, so a
    // third task has nowhere to go until one of them clears.
    await lead.add_task({ title: 'Waiting', brief: 'queued behind the conflict' });
    assert.equal(tc.list()[0].tasks.find((x) => x.title === 'Waiting')!.state, 'queued', 'both lanes are held');

    // The human resolves it their way: take the lane's version onto main.
    writeFileSync(path.join(dir, 'shared.txt'), 'one\nLANE\nthree\n');
    git(dir, ['commit', '-qam', 'resolved by hand']);
    const answer = await lead.merge_task({ task: 'Rewrite' });
    assert.match(answer, /Merged|Nothing to merge/);
    const t = tc.list()[0];
    assert.equal(t.tasks.find((x) => x.title === 'Rewrite')!.state, 'merged');
    assert.equal(t.tasks.find((x) => x.title === 'Waiting')!.state, 'working', 'the freed lane took the queued task');
    assert.equal(t.tasks.find((x) => x.title === 'Waiting')!.lane, 1);
    assert.equal(t.state, 'working', 'the hold that was about the conflict is over');
  });

  await test('finish does not declare the team done over an unmerged conflict', async () => {
    // Make Waiting conflict, close Quiet, and the only live task is the blocked one.
    writeFileSync(path.join(laneOf('Waiting')[0], 'shared.txt'), 'one\nWAITING\nthree\n');
    writeFileSync(path.join(dir, 'shared.txt'), 'one\nHUMAN AGAIN\nthree\n');
    git(dir, ['commit', '-qam', 'human again']);
    await approveLane('Waiting');
    assert.match(await lead.finish_task({ task: 'Waiting', summary: 'tried' }), /conflict/i);
    await approveLane('Quiet');
    await lead.finish_task({ task: 'Quiet', summary: 'quiet done' });
    const answer = await lead.finish({ summary: 'all wrapped up' });
    assert.match(answer, /Not finished/);
    assert.equal(tc.list()[0].state, 'awaiting_human', 'the hold stands');
    assert.equal(tc.list()[0].doneSummary, undefined);
  });

  await test('dismissing takes the lanes down and names what was left unmerged', async () => {
    // Leave something uncommitted in the blocked lane, cancel it, and dismiss.
    const cwd = [...tc.laneRooms().entries()].find(([, i]) => i.branch === 'airoom/waiting')![0];
    writeFileSync(path.join(cwd, 'loose.txt'), 'never committed\n');
    const waiting = tc.list()[0].tasks.find((x) => x.title === 'Waiting')!;
    tc.cancelTask(id, waiting.id);
    const left = tc.unmergedBranches(id);
    assert.ok(left.includes('airoom/waiting'), `the cancelled task’s loose work is reported: ${left}`);
    const paths = [...tc.laneRooms().keys()];
    tc.stop(id);
    assert.equal(tc.dismiss(id), true);
    for (const p of paths) assert.equal(existsSync(p), false, `${p} was left behind`);
    assert.equal(git(dir, ['show', 'airoom/waiting:loose.txt']), 'never committed', 'the loose work was committed, not discarded');
    for (const b of left) assert.ok(branches(dir).includes(b), `${b} was deleted with work on it`);
  });
})();

/**
 * The review gate, against a real repository.
 *
 * The unit tests hand the referee a fingerprint function; these let it use the
 * real one, because the first version of that function called git with a
 * switch git does not have, returned '' on the error, and compared '' to ''
 * as "nothing moved" — so every edit made after an approval merged unreviewed.
 */
await (async () => {
  const { TeamController } = await import('../src/team/TeamController');
  const controller = {
    activeRuns: () => [],
    async send() {},
    interrupt: () => true,
    respondPermission: () => true,
    async close() {},
  };
  const dir = repo();
  const tc = new TeamController({
    controller: controller as never,
    onUpdate: () => {},
    onHandoff: () => {},
    onTeamsChanged: () => {},
    file: path.join(root, 'gate-teams.json'),
  });
  const id = tc.hire({ roomId: dir, task: 'Gated job', autonomy: 'auto', lanes: 2 }).teamId!;
  const lead = tc.handlersFor(id, 'lead');
  const laneCwd = (title: string) => [...tc.laneRooms().entries()].find(([, i]) => i.task === title)![0];
  const taskNamed = (title: string) => tc.list().find((t) => t.id === id)!.tasks.find((t) => t.title === title)!;
  const approve = (lane: number) =>
    tc.handlersFor(id, lane === 1 ? 'reviewer' : `reviewer@${lane}`).give_verdict({ verdict: 'approve', notes: 'read it' });

  await test('an edit after the approval is refused, and the fingerprint is a real one', async () => {
    const cwd = laneCwd('Gated job');
    writeFileSync(path.join(cwd, 'gated.txt'), 'first draft\n');
    await approve(1);
    const rev = taskNamed('Gated job').review!.rev;
    assert.match(rev, /^[0-9a-f]{40}$/, `the approval must record a real tree hash, got ${JSON.stringify(rev)}`);

    writeFileSync(path.join(cwd, 'gated.txt'), 'sneaky second draft\n');
    const refused = await lead.finish_task({ task: 'Gated job', summary: 'shipping' });
    assert.match(refused, /moved since/);
    assert.equal(taskNamed('Gated job').state, 'working', 'the task stays open');
    assert.equal(existsSync(path.join(dir, 'gated.txt')), false, 'nothing unreviewed reached the project');

    await approve(1); // a fresh look at what is actually there
    assert.match(await lead.finish_task({ task: 'Gated job', summary: 'shipping' }), /is closed/);
    assert.equal(readFileSync(path.join(dir, 'gated.txt'), 'utf8'), 'sneaky second draft\n', 'the reviewed version merged');
  });

  await test('committing the same content does not void an approval', async () => {
    await lead.add_task({ title: 'Committed', brief: 'commit before closing' });
    const cwd = laneCwd('Committed');
    writeFileSync(path.join(cwd, 'committed.txt'), 'body\n');
    await approve(taskNamed('Committed').lane!);
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-qm', 'the crew committed its own work']);
    assert.match(await lead.finish_task({ task: 'Committed', summary: 'done' }), /is closed/);
    assert.equal(readFileSync(path.join(dir, 'committed.txt'), 'utf8'), 'body\n');
  });

  await test('merge_task cannot merge what no reviewer approved', async () => {
    await lead.add_task({ title: 'Unreviewed', brief: 'never shown to a reviewer' });
    const cwd = laneCwd('Unreviewed');
    writeFileSync(path.join(cwd, 'unreviewed.txt'), 'nobody looked\n');
    const refused = await lead.merge_task({ task: 'Unreviewed' });
    assert.match(refused, /Not merged/);
    assert.match(refused, /no verdict yet/);
    assert.equal(existsSync(path.join(dir, 'unreviewed.txt')), false, 'the branch did not land');
    assert.notEqual(taskNamed('Unreviewed').state, 'merged');
  });

  await test('the human merging an unreviewed lane by hand is recorded as such', async () => {
    const task = taskNamed('Unreviewed');
    const r = tc.mergeTask(id, task.id);
    assert.equal(r.ok, true, r.error);
    assert.ok(taskNamed('Unreviewed').waived?.at, 'the board must say it went in without a review');
    assert.equal(readFileSync(path.join(dir, 'unreviewed.txt'), 'utf8'), 'nobody looked\n');
  });
})();

rmSync(root, { recursive: true, force: true });
console.log(failures.length ? `\n${passed} passed, ${failures.length} FAILED\n` : `\n${passed} passed, 0 failed\n`);
process.exit(failures.length ? 1 : 0);
