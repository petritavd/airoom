/**
 * The floor plan, checked as geometry.
 *
 *   npm test   (tsx scripts/layout-test.ts)
 *
 * `computeLayout` is pure arithmetic — no canvas, no DOM — so the rules that
 * matter can be proven here instead of squinted at in a screenshot. What is on
 * trial is the things a wrong number makes invisible: a room of negative width
 * (which throws inside the canvas and blanks the whole office), a bench that
 * runs through a wall, a lane that is laid out as a project of its own.
 */
import assert from 'node:assert/strict';
import type { FleetSnapshot, Robot, Room, Team } from '../../shared/types';
import { computeLayout, hitTest, interiorOf, teamPlateHit, teamPodHit } from '../../web/src/render/draw';

let passed = 0;
const failures: Array<[string, Error]> = [];
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

const now = new Date().toISOString();
const room = (id: string, robotCount: number): Room => ({
  id,
  name: id.split('/').pop()!,
  path: id,
  robotCount,
  needsAttention: false,
});
const lane = (n: number, count: number): Room => ({
  ...room(`/w/proj/.lane-${n}`, count),
  lane: { teamId: 'T', homeRoomId: '/w/proj', lane: n, task: `Task ${n}`, branch: `airoom/lane-${n}` },
});
const bot = (id: string, roomId: string, role?: string): Robot => ({
  sessionId: id,
  roomId,
  title: id,
  status: 'working',
  currentAction: '',
  lastActivity: now,
  messageCount: 1,
  recentSteps: [],
  ...(role ? { team: { id: 'T', role } } : {}),
});

function laneFleet(lanes: number): FleetSnapshot {
  const members = [
    { role: 'lead', kind: 'lead' as const, label: 'Lead', lane: 0, room: '/w/proj' },
    ...Array.from({ length: lanes }, (_, i) => i + 1).flatMap((n) => [
      { role: n > 1 ? `builder@${n}` : 'builder', kind: 'worker' as const, label: 'Builder', writes: true, lane: n, room: `/w/proj/.lane-${n}` },
      { role: n > 1 ? `reviewer@${n}` : 'reviewer', kind: 'reviewer' as const, label: 'Reviewer', lane: n, room: `/w/proj/.lane-${n}` },
    ]),
  ];
  const team: Team = {
    id: 'T',
    roomId: '/w/proj',
    task: 'Do the thing',
    autonomy: 'auto',
    roundCap: 2,
    roundsUsed: 0,
    state: 'working',
    members: members.map((m, i) => ({ ...m, sessionId: `s${i}` })),
    costUsd: 0,
    createdAt: now,
    updatedAt: now,
    tasksDone: 0,
    tasks: [],
    lanes,
    worktrees: true,
  };
  return {
    rooms: [room('/w/proj', 1), ...Array.from({ length: lanes }, (_, i) => lane(i + 1, 2)), room('/w/other', 2)],
    robots: [...members.map((m, i) => bot(`s${i}`, m.room, m.role)), bot('x1', '/w/other')],
    teams: [team],
    away: [],
    generatedAt: now,
  };
}

console.log('\nthe floor plan');

test('a lane is laid out beside its project, not as a project of its own', () => {
  const l = computeLayout(laneFleet(2), 1440, 900);
  const proj = l.cells.find((c) => c.room?.id === '/w/proj')!;
  const l1 = l.cells.find((c) => c.room?.id === '/w/proj/.lane-1')!;
  const l2 = l.cells.find((c) => c.room?.id === '/w/proj/.lane-2')!;
  assert.ok(proj && l1 && l2, 'all three rooms are on the plan');
  assert.equal(l1.row, proj.row, 'a lane shares its project’s row');
  assert.ok(Math.abs(proj.x + proj.w - l1.x) <= 1, 'lane 1 begins where the project ends');
  assert.ok(Math.abs(l1.x + l1.w - l2.x) <= 1, 'lane 2 begins where lane 1 ends');
  assert.ok(proj.archRight && l1.archLeft, 'the project opens into lane 1');
  assert.ok(l1.archRight && l2.archLeft, 'lane 1 opens into lane 2');
});

test('every cell has a positive size, even on a cramped floor', () => {
  // A negative width reaches the canvas as a negative radius and throws, which
  // blanks the entire office — so this holds at every size, not just roomy ones.
  for (const [w, h] of [
    [1920, 1080],
    [1440, 900],
    [1024, 700],
    [820, 460],
    [640, 900],
    [420, 720],
  ] as [number, number][]) {
    for (const lanes of [1, 2, 3, 4]) {
      const l = computeLayout(laneFleet(lanes), w, h);
      for (const c of l.cells) assert.ok(c.w > 0 && c.h > 0, `${w}x${h}, ${lanes} lanes: cell ${c.idx} is ${c.w}x${c.h}`);
    }
  }
});

test('each crew gets its own bench, inside its own room', () => {
  const l = computeLayout(laneFleet(3), 1600, 950);
  assert.equal(l.teamPods.length, 4, 'the lead, plus one crew per lane');
  for (const pod of l.teamPods) {
    const cell = l.cells[pod.cellIdx];
    const { iX, iW } = interiorOf(cell);
    for (const seat of pod.seats)
      assert.ok(
        seat.p.x > iX && seat.p.x < iX + iW,
        `a seat of ${pod.roomId} sits at ${Math.round(seat.p.x)}, outside its room (${Math.round(iX)}..${Math.round(iX + iW)})`,
      );
    assert.ok(pod.x >= iX - 1 && pod.x + pod.w <= iX + iW + 1, `the bench of ${pod.roomId} runs through a wall`);
  }
  assert.deepEqual(
    l.teamPods.map((p) => p.seats.length),
    [1, 2, 2, 2],
    'the lead sits alone; every lane crew is a pair',
  );
});

test('no ghost desk in a lane — you do not hire into a worktree', () => {
  const l = computeLayout(laneFleet(2), 1440, 900);
  assert.ok(!l.spawnSpots.some((s) => s.roomId.includes('.lane-')), 'a lane offers no "+ new" place');
  assert.ok(l.spawnSpots.some((s) => s.roomId === '/w/proj'), 'the project still does');
});

test('a team with no lanes looks exactly as it always did', () => {
  const l = computeLayout(laneFleet(1), 1440, 900);
  const pods = l.teamPods.filter((p) => p.roomId === '/w/proj');
  assert.equal(l.cells.filter((c) => c.room?.lane).length, 1, 'lane 1 of a one-lane team is still a room');
  assert.equal(pods.length, 1, 'the lead has its bench in the project');
});

console.log('\nclicking a team');

/** The classic trio at a bench in its project room — the common case. */
function trioFleet(): FleetSnapshot {
  const members = [
    { role: 'lead', kind: 'lead' as const, label: 'Lead', lane: 0 },
    { role: 'builder', kind: 'worker' as const, label: 'Builder', writes: true, lane: 1 },
    { role: 'reviewer', kind: 'reviewer' as const, label: 'Reviewer', lane: 1 },
  ];
  const team: Team = {
    id: 'T',
    roomId: '/w/proj',
    task: 'create an amazing plan of what to fix in code, what features to add',
    autonomy: 'auto',
    roundCap: 2,
    roundsUsed: 0,
    state: 'working',
    members: members.map((m, i) => ({ ...m, sessionId: `s${i}` })),
    costUsd: 0,
    createdAt: now,
    updatedAt: now,
    tasksDone: 0,
    tasks: [],
    lanes: 1,
    worktrees: false,
  };
  return {
    rooms: [room('/w/proj', 3), room('/w/other', 2)],
    robots: [...members.map((m, i) => bot(`s${i}`, '/w/proj', m.role)), bot('x1', '/w/other')],
    teams: [team],
    away: [],
    generatedAt: now,
  };
}

test('the plaque is the team’s button: on the bench, off every desk, and it wins the click', () => {
  for (const [w, h] of [
    [1440, 900],
    [1000, 700],
  ] as [number, number][]) {
    const l = computeLayout(trioFleet(), w, h);
    const pod = l.teamPods[0];
    const p = pod.plate;
    assert.ok(p.w >= 40 && p.h >= 8, `plaque too small to hit: ${p.w}x${p.h}`);
    assert.ok(p.x >= pod.x && p.x + p.w <= pod.x + pod.w && p.y >= pod.y, 'the plaque sits on its own bench');
    // …and never under the room's nameplate, which rests on the top glass.
    const { iY } = interiorOf(l.cells[pod.cellIdx]);
    assert.ok(p.y >= iY + 10, `the plaque (${Math.round(p.y)}) runs into the room sign (${Math.round(iY)})`);
    for (const d of l.desks)
      assert.ok(d.y >= p.y + p.h || d.x >= p.x + p.w || d.x + d.w <= p.x, 'no member’s desk overlaps the plaque');
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    assert.equal(teamPlateHit(l, cx, cy)?.teamId, 'T');
    assert.equal(hitTest(l, cx, cy), null, 'nobody is sitting where the plaque is');
    assert.equal(p.label, 'TEAM', 'an unnamed team’s plaque says TEAM — never the job');
  }
});

test('a named team’s plaque carries the name, sized to it, still inside the room', () => {
  const fleet = trioFleet();
  fleet.teams[0].name = 'Reasoning crew';
  const l = computeLayout(fleet, 1440, 900);
  const p = l.teamPods[0].plate;
  assert.equal(p.label, 'Reasoning crew');
  const plain = computeLayout(trioFleet(), 1440, 900).teamPods[0].plate;
  assert.ok(p.w > plain.w, 'wider than TEAM, to fit the name');
  const { iX, iW } = interiorOf(l.cells[l.teamPods[0].cellIdx]);
  assert.ok(p.x >= iX && p.x + p.w <= iX + iW, 'and never past the walls');
  fleet.teams[0].name = 'A very long team name that goes on and on';
  assert.match(computeLayout(fleet, 1440, 900).teamPods[0].plate.label, /…$/, 'a long name is cut for the sign');
});

test('most of a bench opens the team, and a member only from its own robot and screen', () => {
  const l = computeLayout(trioFleet(), 1440, 900);
  const pod = l.teamPods[0];
  let total = 0;
  let team = 0;
  for (let y = pod.y; y <= pod.y + pod.h; y += 2)
    for (let x = pod.x; x <= pod.x + pod.w; x += 2) {
      total++;
      if (!hitTest(l, x, y) && (teamPlateHit(l, x, y) || teamPodHit(l, x, y))) team++;
    }
  const share = team / total;
  // It was 29%, all of it empty floor above the robots' heads.
  assert.ok(share >= 0.45, `only ${Math.round(share * 100)}% of the bench opens the team`);
  const memberDesks = l.desks.filter((d) => d.robot.team);
  assert.equal(memberDesks.length, 3);
  for (const d of memberDesks) {
    const s = l.cells[d.cellIdx].scale;
    assert.ok(d.y + d.h <= d.deskTop + 26 * s + 1, 'a member’s box stops at the front of its own screen');
  }
  // Every member is still reachable through its own robot.
  for (const d of memberDesks) assert.equal(hitTest(l, d.seat.x, d.seat.y + 6)?.sessionId, d.robot.sessionId);
});

console.log(failures.length ? `\n${passed} passed, ${failures.length} FAILED\n` : `\n${passed} passed, 0 failed\n`);
process.exit(failures.length ? 1 : 0);
