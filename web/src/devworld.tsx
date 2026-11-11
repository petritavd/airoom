/**
 * Render fixture: the world with a hand-written fleet instead of a live server.
 *
 *   npm run dev  →  http://localhost:<port>/devworld.html
 *
 * One screen showing every robot status, all six themes, a project family
 * (archway), a team at its bench and a spawn ghost — so art changes can be
 * judged against every state at once instead of whatever the real fleet
 * happens to be doing. No websocket: the snapshot below IS the fleet.
 * `localStorage.setItem('airoom.hour', '23')` still drives time of day.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { FleetSnapshot, Robot, RobotStatus, Room, Team, TeamRole, Handoff } from '@shared/types';
import { PixelWorld } from './render/PixelWorld';
import { DecorPalette } from './ui/DecorPalette';
import { RoomRoster } from './ui/RoomRoster';
import { FolderPicker } from './ui/FolderPicker';
import { UpdateBar } from './ui/UpdateBar';
import type { ReleaseInfo } from '@shared/types';
import { Logo } from './ui/Logo';
import { ProjectChooser } from './ui/ProjectChooser';
import type { RoomConfigs } from './roomConfig';
import './styles.css';

const now = new Date().toISOString();

function room(path: string, robotCount: number, needsAttention = false): Room {
  return { id: path, name: path.split('/').pop()!, path, robotCount, needsAttention };
}

let n = 0;
function robot(roomId: string, status: RobotStatus, extra: Partial<Robot> = {}): Robot {
  n++;
  return {
    sessionId: `fix-${n}`,
    roomId,
    title: `${status.replace('_', ' ')} agent ${n}`,
    status,
    currentAction: status === 'working' ? 'Running Bash: npm test' : '',
    gitBranch: n % 2 ? 'main' : 'feat/renderer',
    lastActivity: now, // recent → waiting robots stay seated instead of door-marching
    messageCount: 12,
    recentSteps: [],
    ...extra,
  };
}

const ROOMS: Room[] = [
  room('/w/tmp', 2),
  room('/w/stickyboard', 3, true),
  room('/w/stickyboard/web', 2),
  room('/w/applyai', 1, true),
  room('/w/applyai/api', 2),
  room('/w/pepsi', 8, true),
  room('/w/rose', 1),
  room('/w/slate', 3),
];

const TEAM_ID = 'fix-team';
const ROLES: TeamRole[] = ['lead', 'builder', 'reviewer'];
const ROBOTS: Robot[] = [
  robot('/w/tmp', 'working', { skills: ['vue-best-practices', 'frontend-design'] }),
  robot('/w/tmp', 'idle', { playbook: { id: 'pb-fix', runId: 'run-fix', name: 'Cut a release' } }),
  robot('/w/stickyboard', 'working'),
  robot('/w/stickyboard', 'working'),
  robot('/w/stickyboard', 'waiting_input'),
  robot('/w/stickyboard/web', 'working'),
  robot('/w/stickyboard/web', 'idle'),
  robot('/w/applyai', 'error'),
  robot('/w/applyai/api', 'working'),
  robot('/w/applyai/api', 'done'),
  robot('/w/pepsi', 'working'),
  robot('/w/pepsi', 'waiting_input'),
  robot('/w/pepsi', 'idle'),
  robot('/w/pepsi', 'working'),
  robot('/w/pepsi', 'done'),
  robot('/w/pepsi', 'idle'),
  robot('/w/pepsi', 'working'),
  robot('/w/pepsi', 'idle'),
  robot('/w/rose', 'done'),
  ...ROLES.map((role, i) =>
    robot('/w/slate', i === 2 ? 'waiting_input' : 'working', { team: { id: TEAM_ID, role } }),
  ),
];

const TEAM: Team = {
  id: TEAM_ID,
  roomId: '/w/slate',
  task: 'Redesign the pixel renderer',
  autonomy: 'auto_capped',
  roundCap: 3,
  roundsUsed: 1,
  state: 'working',
  members: ROLES.map((role) => ({
    role,
    kind: role === 'lead' ? ('lead' as const) : role === 'reviewer' ? ('reviewer' as const) : ('worker' as const),
    label: role.charAt(0).toUpperCase() + role.slice(1),
    writes: role === 'builder',
    lane: role === 'lead' ? 0 : 1,
    sessionId: ROBOTS.find((r) => r.team?.role === role)!.sessionId,
  })),
  costUsd: 0.42,
  createdAt: now,
  updatedAt: now,
  tasksDone: 0,
  lanes: 1,
  worktrees: false,
  tasks: [
    {
      id: 'task-1',
      title: 'Redesign the pixel renderer',
      brief: 'Redesign the pixel renderer',
      state: 'working' as const,
      lane: 1,
      roundsUsed: 1,
      awaitingFrom: 'builder',
      createdAt: now,
    },
  ],
};

const SNAPSHOT: FleetSnapshot = { rooms: ROOMS, robots: ROBOTS, teams: [TEAM], away: [], generatedAt: now };

/**
 * A project with a team running three lanes — the shape the office has to draw
 * once a team is bigger than the classic trio: a lead in the project itself
 * and a crew per worktree, each in its own room off it.
 */
const LANE_TEAM = 'fix-lanes';
const laneRoom = (n: number, task: string, count: number, wants = false): Room => ({
  id: `/w/rose/.lane-${n}`,
  name: task,
  path: `/w/rose/.lane-${n}`,
  robotCount: count,
  needsAttention: wants,
  lane: { teamId: LANE_TEAM, homeRoomId: '/w/rose', lane: n, task, branch: `airoom/lane-${n}` },
});

const LANE_MEMBERS = [
  { role: 'lead', kind: 'lead' as const, label: 'Lead', lane: 0, room: '/w/rose', status: 'working' as RobotStatus },
  { role: 'backend', kind: 'worker' as const, label: 'Backend', writes: true, lane: 1, room: '/w/rose/.lane-1', status: 'working' as RobotStatus },
  { role: 'reviewer', kind: 'reviewer' as const, label: 'Reviewer', lane: 1, room: '/w/rose/.lane-1', status: 'idle' as RobotStatus },
  { role: 'backend@2', kind: 'worker' as const, label: 'Backend · lane 2', writes: true, lane: 2, room: '/w/rose/.lane-2', status: 'working' as RobotStatus },
  { role: 'reviewer@2', kind: 'reviewer' as const, label: 'Reviewer · lane 2', lane: 2, room: '/w/rose/.lane-2', status: 'waiting_input' as RobotStatus },
];

const LANE_ROBOTS: Robot[] = LANE_MEMBERS.map((m, i) => ({
  sessionId: `lane-${i}`,
  roomId: m.room,
  title: m.label,
  status: m.status,
  currentAction: m.status === 'working' ? 'Editing src/gate.ts' : '',
  lastActivity: now,
  messageCount: 8,
  recentSteps: [],
  team: { id: LANE_TEAM, role: m.role },
}));

const LANES_SNAPSHOT: FleetSnapshot = {
  rooms: [
    room('/w/tmp', 2),
    room('/w/rose', 1),
    // Deliberately long: a task title is whatever the human typed, and a sign
    // that runs across the wall into the next room is what this guards.
    laneRoom(1, 'create an amazing plan of what to fix in code, what features', 2),
    laneRoom(2, 'Docs pass', 2, true),
    room('/w/slate', 3),
  ],
  robots: [...LANE_ROBOTS, robot('/w/rose', 'idle'), robot('/w/tmp', 'working'), robot('/w/tmp', 'idle'), robot('/w/slate', 'done')],
  teams: [
    {
      ...TEAM,
      id: LANE_TEAM,
      name: 'Importer crew',
      roomId: '/w/rose',
      lanes: 3,
      worktrees: true,
      task: 'Split the importer and its docs',
      members: LANE_MEMBERS.map((m, i) => ({
        role: m.role,
        kind: m.kind,
        label: m.label,
        writes: m.writes,
        lane: m.lane,
        sessionId: `lane-${i}`,
      })),
    },
  ],
  away: [],
  generatedAt: now,
};

/** One of each theme, materials left to the theme's own default. */
const CONFIGS: RoomConfigs = {
  '/w/tmp': { theme: 'oak' },
  '/w/stickyboard': { theme: 'forest', notes: 'ship the parser\nreview #412\nflaky test' },
  '/w/stickyboard/web': { theme: 'forest' },
  '/w/applyai': { theme: 'plum' },
  '/w/applyai/api': { theme: 'plum' },
  '/w/pepsi': { theme: 'ocean' },
  '/w/rose': { theme: 'rose' },
  '/w/slate': { theme: 'slate' },
};

const noop = () => {};

// ---------------------------------------------------------------- panel rig
// http://localhost:<port>/devworld.html#panel — the AgentPanel with a
// scripted conversation and switchable run states, so both chat and terminal
// views can be judged against every block type at once: long markdown, tool
// clusters (with a failure), markers, attachments, the approval gate, and
// queue-while-busy. No websocket, no cost.
import { useEffect, useState } from 'react';
import { AgentPanel } from './ui/AgentPanel';
import { TeamPanel } from './ui/TeamPanel';
import type { Step } from '@shared/types';
import type { RunState } from './net/useFleet';
import './chat.css';

const T0 = Date.now() - 40 * 60_000;
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let fs = 0;
const fstep = (kind: Step['kind'], label: string, min: number, extra: Partial<Step> = {}): Step =>
  ({ id: `fx-${++fs}`, ts: at(min), kind, label, ...extra }) as Step;

const FIXTURE_STEPS: Step[] = [
  fstep('user', 'the room panel flashes oak on reload — every room shows the default theme for a beat before its own colour lands. can you find why?', 0),
  fstep('assistant_text', 'On it — tracing where the panel accent comes from on first paint.', 1),
  fstep('tool_use', 'Grep: "THEMES[0]" · web/src', 2, { toolUseId: 't1', tool: { name: 'Grep', target: '"THEMES[0]" · web/src' } }),
  fstep('tool_result', 'tool result', 2, { toolUseId: 't1', detail: '3 matches — App.tsx, draw.ts, PixelWorld.tsx' }),
  fstep('tool_use', 'Read App.tsx:560-610', 3, { toolUseId: 't2', tool: { name: 'Read', target: 'web/src/App.tsx:560-610' } }),
  fstep('tool_use', 'Read draw.ts:60-80', 3, { toolUseId: 't3', tool: { name: 'Read', target: 'web/src/render/draw.ts:60-80' } }),
  fstep('tool_use', 'Bash: npm run dev --prefix web', 4, { toolUseId: 't4', tool: { name: 'Bash', target: 'npm run dev --prefix web' } }),
  fstep('tool_result', 'tool result', 4, { toolUseId: 't4', detail: 'ready in 412ms' }),
  fstep('tool_use', 'Bash: npm test --prefix web', 5, { toolUseId: 't5', tool: { name: 'Bash', target: 'npm test --prefix web' } }),
  fstep('tool_result', 'tool result', 5, { toolUseId: 't5', detail: 'FAIL src/render/draw.test.ts\n  ✕ theme falls back to oak (12 ms)\n\nExpected: "#2f7d4a"\nReceived: "#b0680f"', isError: true }),
  fstep(
    'assistant_text',
    [
      'Found it. The panel accent falls back to the default theme whenever a room\'s config has not arrived yet — and on reload the panel mounts before the fetch resolves.',
      '',
      '## Two clean fixes',
      '',
      '1. **Hold the trim** until configs resolve — one extra render state.',
      '2. **Cache each room\'s last theme** in `localStorage` and seed from that.',
      '',
      'The cache kills the flash outright and costs one line on write:',
      '',
      '```tsx',
      "const seed = localStorage.getItem(`airoom.theme.${roomId}`);",
      'const accent = THEMES.find((t) => t.id === (config?.theme ?? seed))?.accent ?? THEMES[0].accent;',
      '```',
      '',
      'The flash is worst on slow disks because the config read races first paint — the cache wins that race every time, and a stale colour for one frame is indistinguishable from the right one.',
    ].join('\n'),
    6,
  ),
  fstep('marker', 'Conversation compacted', 18, { detail: '112k → 9k tokens' }),
  fstep('user', 'attach shows the current look', 30, { images: 1, imageDims: '1872×1762' }),
  fstep('user', 'do the localStorage version', 34),
];

const FIXTURE_ROBOT: Robot = {
  sessionId: 'fix-panel',
  roomId: '/w/tmp',
  title: 'theme flash on reload',
  status: 'working',
  currentAction: 'Running Bash: npm test',
  gitBranch: 'feat/renderer',
  lastActivity: at(39),
  messageCount: 6,
  recentSteps: [],
  name: 'Gitta',
};

/** Model rows for the rig: Claude's list plus a graded local set, so the
 *  picker's "Local · Ollama" section and the composer note can be eyeballed. */
const RIG_MODELS = [
  { value: '', displayName: 'Sonnet 5', primary: true },
  { value: 'opus', displayName: 'Opus 5', primary: true, supportsFastMode: true },
  { value: 'haiku', displayName: 'Haiku 4.5', primary: false, description: 'fast and cheap' },
  { value: 'ollama/qwen3-coder:30b', displayName: 'qwen3-coder:30b', primary: false, provider: 'ollama' as const, quality: 'strong' as const, qualityNote: 'Big enough to plan, call tools and finish multi-step work.', description: '30.5B · 256k context · local', params: '30.5B', contextK: 256 },
  { value: 'ollama/gpt-oss:20b', displayName: 'gpt-oss:20b', primary: false, provider: 'ollama' as const, quality: 'fair' as const, qualityNote: 'Handles single-file edits and questions; not recommended for teams.', description: '20.9B · 128k context · local', params: '20.9B', contextK: 128 },
  { value: 'ollama/qwen3:8b', displayName: 'qwen3:8b', primary: false, provider: 'ollama' as const, quality: 'weak' as const, qualityNote: 'Too small to drive agents reliably — loses track of its tools and wanders. Fine for a quick question.', description: '8.2B · 40k context · local', params: '8.2B', contextK: 40 },
  { value: 'ollama/llama2:7b', displayName: 'llama2:7b', primary: false, provider: 'ollama' as const, quality: 'unfit' as const, qualityNote: 'No tool calling — Claude Code cannot use it.', description: '7B · 4k context · local', params: '7B', contextK: 4 },
];

function PanelRig() {
  const [runMode, setRunMode] = useState<'idle' | 'busy' | 'gate'>('busy');
  // #panel-team opens the desk on the Team brief with a local model chosen,
  // to see the hire form's grading and its warning.
  const teamRig = window.location.hash.includes('team');
  // #panel-noollama: Ollama installed but not serving — the picker's hint row.
  const noOllama = window.location.hash.includes('noollama');
  // #panel-nolocal: no Ollama at all — the discoverability row.
  const noLocal = window.location.hash.includes('nolocal');
  // #panel-member: the robot is on a team — the chip back to its panel.
  const memberRig = window.location.hash.includes('member');
  const run: RunState | undefined =
    runMode === 'idle'
      ? undefined
      : {
          runKey: 'fix-panel',
          roomId: '/w/tmp',
          sessionId: 'fix-panel',
          active: true,
          thread:
            runMode === 'busy'
              ? [{ id: 'live1', kind: 'agent', text: 'Writing the cache seed now — App.tsx first, then the write on theme change. The read has to happen before the first', streaming: true }]
              : [],
          pendingPermission:
            runMode === 'gate'
              ? {
                  requestId: 'fix-perm',
                  label: 'Bash: npm test --prefix web',
                  tool: {
                    name: 'Bash',
                    target: 'npm test --prefix web',
                    cwd: '/w/tmp',
                    title: 'Run the web test suite',
                    input: { command: 'npm test --prefix web' },
                  },
                  canAlways: true,
                }
              : null,
          cost: 0.87,
          context: { usedTokens: 82_000, maxTokens: 200_000, percent: 41 },
        };
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <div style={{ position: 'fixed', top: 4, left: 8, zIndex: 200, display: 'flex', gap: 6 }}>
        {(['idle', 'busy', 'gate'] as const).map((m) => (
          <button key={m} onClick={() => setRunMode(m)} style={{ fontFamily: 'monospace', background: runMode === m ? '#16324f' : '#141a25', color: '#cfe3ff', border: '1px solid #2a3550', padding: '2px 8px', cursor: 'pointer' }}>
            {m}
          </button>
        ))}
      </div>
      <AgentPanel
        robot={teamRig ? null : FIXTURE_ROBOT}
        team={memberRig ? { label: 'Builder', state: 'awaiting_human' } : null}
        onOpenTeam={noop}
        roomId="/w/tmp"
        hireMode={teamRig ? 'team' : 'agent'}
        teamHired={0}
        memberMode={memberRig ? 'bypassPermissions' : undefined}
        memberModel={memberRig ? 'opus' : undefined}
        onHireMode={noop}
        teamAutonomy="auto_capped"
        teamRoundCap={2}
        teamMode="default"
        teamModel={teamRig ? 'ollama/qwen3:8b' : ''}
        canHire={true}
        skillChoices={[]}
        onListSkills={noop}
        onCreateSkill={() => true}
        onTeamDefaults={noop}
        onHireTeam={noop}
        onLetGo={noop}
        onDelete={noop}
        onNameAgent={noop}
        roomName="tmp"
        accent="#b0680f"
        transcript={{ sessionId: 'fix-panel', steps: FIXTURE_STEPS, hasMore: true }}
        loadingMore={false}
        run={teamRig ? undefined : run}
        models={noOllama || noLocal ? RIG_MODELS.filter((m) => !('provider' in m)) : RIG_MODELS}
        commands={[]}
        onSubscribe={noop}
        onLoadMore={noop}
        onNotice={noop}
        onSend={() => true}
        onInterrupt={noop}
        onPermission={noop}
        onSetMode={noop}
        onSetFastMode={noop}
        onRewind={noop}
        rewind={null}
        onClearRewind={noop}
        onClearRun={noop}
        onClose={noop}
      />
    </div>
  );
}

const LONG_SUMMARY = `**Reasoning-model detection in intent classification — complete, reviewer-approved, uncommitted.**

## What was built

\`needs_reasoning\` now flows through intent classification into automode model selection, gated by a three-signal conjunction: the LLM flag from the \`classify_intent\` schema, an independently-produced \`complexity == "high"\` band, and a deterministic suppression check.

Files: \`routing/model_router.py\`, \`config/config.py\`, \`intent/classification_prompt.py\`, plus new \`tests/test_reasoning_routing.py\`. Eight files, all in scope. Nothing committed or pushed.

## Ships inert — deliberately

\`AUTOMODE_MODEL_TIERS\` has no "reasoning" entry, so every decision resolves to the existing "high" tier and no traffic behaves differently.

## Tests

**1000 passing**, up from 963. Same 16 pre-existing failures throughout, zero introduced.

## Review found real problems, three rounds running

- Round 1: the suppression list vetoed 9 of 13 hard queries including all three ticket-named cases.
- Round 2: the fix reopened the generation category and a missing \`\\b\` matched "memo" inside "memory".
- Round 3 was subtractive — reverted both, pinned them with tests that fail on reintroduction.

## Two things needing your decision

1. Whether the reasoning tier should ship enabled anywhere before a week of shadow traffic.
2. Whether marker-as-noun (the residual) is acceptable, or worth a sentence-subject parser.

That is the whole report; the log below has every handoff.`;

function TeamRig() {
  const team = {
    id: 't1',
    roomId: '/w/tmp',
    task: "I have this ticket, don't push nor commit, just make the changes for now. Task: Detect in intent classification whether a query needs a reasoning model.",
    state: 'done',
    autonomy: 'auto_capped',
    roundsUsed: 3,
    roundCap: 2,
    costUsd: 74.73,
    tasksDone: 0,
    name: 'Reasoning crew',
    lanes: 3,
    worktrees: true,
    members: [
      { role: 'lead', kind: 'lead', label: 'Lead', lane: 0, sessionId: 'l1' },
      { role: 'builder', kind: 'worker', label: 'Builder', writes: true, lane: 1, sessionId: 'b1' },
      { role: 'reviewer', kind: 'reviewer', label: 'Reviewer', lane: 1, sessionId: 'r1' },
      { role: 'builder@2', kind: 'worker', label: 'Builder · lane 2', writes: true, lane: 2, sessionId: 'b2' },
      { role: 'reviewer@2', kind: 'reviewer', label: 'Reviewer · lane 2', lane: 2, sessionId: 'r2' },
    ],
    tasks: [
      {
        id: 't1',
        title: 'needs_reasoning gate',
        review: { verdict: 'approve', by: 'reviewer', at: at(9), rev: 'f00dbabe', stale: true },
        brief: 'Add the three-signal conjunction gate described in the ticket.',
        state: 'working',
        lane: 1,
        branch: 'airoom/lane-1',
        roundsUsed: 2,
        awaitingFrom: 'reviewer',
        createdAt: at(40),
      },
      {
        id: 't2',
        title: 'Docs pass',
        review: { verdict: 'request_changes', by: 'reviewer@2', at: at(4), rev: 'c0ffee00' },
        brief: 'Rewrite the reasoning docs to match the new gate.',
        state: 'blocked',
        lane: 2,
        branch: 'airoom/lane-2',
        roundsUsed: 0,
        note: 'Merge conflict on docs/reasoning.md, src/gate.ts. The project folder was left untouched.',
        createdAt: at(30),
      },
      {
        id: 't3',
        title: 'Telemetry',
        brief: 'Count how often the gate fires, behind the existing metrics helper.',
        state: 'queued',
        lane: null,
        roundsUsed: 0,
        createdAt: at(20),
      },
      {
        id: 't0',
        title: 'Spike',
        waived: { at: at(40) },
        brief: 'Prove the approach.',
        state: 'merged',
        lane: null,
        branch: 'airoom/lane-1',
        roundsUsed: 1,
        createdAt: at(80),
      },
    ],
    doneSummary: LONG_SUMMARY,
  } as unknown as Team;
  const log = [
    { id: 'h1', kind: 'assign', from: 'lead', to: 'builder', summary: 'Implement needs_reasoning gate', detail: 'Three-signal conjunction; see ticket.', ts: at(30) },
    { id: 'h2', kind: 'result', from: 'builder', to: 'lead', summary: 'Gate implemented, 8 files', ts: at(12) },
    { id: 'h3', kind: 'verdict', from: 'reviewer', to: 'lead', summary: 'Round 3 approved', ts: at(2) },
    { id: 'h4', kind: 'finish', from: 'lead', to: 'human', summary: 'Complete, uncommitted', ts: at(1) },
  ] as unknown as Handoff[];
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <TeamPanel
        team={team}
        log={log}
        robots={[]}
        away={[]}
        onBringBack={noop}
        onOpenMember={noop}
        onContinue={noop}
        onStop={noop}
        onNewTask={noop}
        onRename={noop}
        onCancelTask={noop}
        onMergeTask={noop}
        onCloseTask={noop}
        onDismiss={noop}
        onClose={noop}
        onSubscribe={noop}
      />
    </div>
  );
}

/** The world, with whichever fleet the variant asked for. */
function Rig({ snapshot }: { snapshot: FleetSnapshot }) {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <main className="stage">
        <PixelWorld
          snapshot={snapshot}
          selectedId={null}
          configs={CONFIGS}
          edit={null}
          onSelect={noop}
          onSpawn={noop}
          onTeam={noop}
          handoffSignal={null}
          onOpenSettings={noop}
          onOpenRoster={noop}
          connectors={FIXTURE_CONNECTORS}
          onOpenConnectors={noop}
          onCycleTheme={noop}
          onChangeDecor={noop}
          onDisarm={noop}
          onExitEdit={noop}
        />
      </main>
    </div>
  );
}

/** The office as it opens: every status, a team, the sockets, a pulse. */
function DefaultRig() {
  const pulse = usePulseBeat();
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <main className="stage">
        <PixelWorld
          snapshot={SNAPSHOT}
          selectedId={null}
          configs={CONFIGS}
          edit={null}
          onSelect={noop}
          onSpawn={noop}
          onTeam={noop}
          handoffSignal={null}
          onOpenSettings={noop}
          onOpenRoster={noop}
          connectors={FIXTURE_CONNECTORS}
          onOpenConnectors={noop}
          pulseSignal={pulse}
          onCycleTheme={noop}
          onChangeDecor={noop}
          onDisarm={noop}
          onExitEdit={noop}
        />
      </main>
    </div>
  );
}

/** Every 2.5s an agent in tmp "calls" a connector, so the cable pulse can be
 *  seen without a live run. */
function usePulseBeat() {
  const [sig, setSig] = useState<{ seq: number; sessionId: string; roomId: string; server: string } | null>(null);
  useEffect(() => {
    let seq = 0;
    const t = setInterval(() => setSig({ seq: ++seq, sessionId: seq % 2 ? 'fix-1' : 'fix-2', roomId: '/w/tmp', server: seq % 2 ? 'github' : 'pencil' }), 2500);
    return () => clearInterval(t);
  }, []);
  return sig;
}

/** Sockets on the wall: every status, in one room, plus a user-wide one. */
const FIXTURE_CONNECTORS: Record<string, import('@shared/types').Connector[]> = {
  '/w/tmp': [
    { name: 'github', scope: 'project', status: 'connected', transport: 'stdio', tools: [{ name: 'list_prs', readOnly: true }], onWall: true, loaded: true },
    { name: 'slack', scope: 'claudeai', status: 'needs-auth', transport: 'claudeai', tools: [], onWall: true, loaded: true },
    { name: 'postgres', scope: 'project', status: 'failed', transport: 'http', error: 'connection refused', tools: [], onWall: true, loaded: true },
    { name: 'pencil', scope: 'user', status: 'connected', transport: 'stdio', tools: [], onWall: true, loaded: true },
    { name: 'sentry', scope: 'project', status: 'disabled', transport: 'http', tools: [], onWall: false, loaded: false },
  ],
  '/w/pepsi': [{ name: 'github', scope: 'user', status: 'connected', transport: 'stdio', tools: [], onWall: true, loaded: true }],
};

/** The four floating dialogs, each over the office, at a size that has to scroll. */
function DialogRig({ which }: { which: string }) {
  const pepsi = ROBOTS.filter((r) => r.roomId === '/w/pepsi');
  const away = Array.from({ length: 9 }, (_, i) => ({
    sessionId: `away-${i}`,
    roomId: '/w/pepsi',
    title: `Let-go agent ${i + 1} with a fairly long title that needs room`,
    lastActivity: now,
    messageCount: 12 + i,
  }));
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <main className="stage">
        <PixelWorld
          snapshot={SNAPSHOT}
          selectedId={null}
          configs={CONFIGS}
          edit={which === 'palette' ? { roomId: '/w/pepsi', placing: 'plant' } : null}
          onSelect={noop}
          onSpawn={noop}
          onTeam={noop}
          handoffSignal={null}
          onOpenSettings={noop}
          onOpenRoster={noop}
          onCycleTheme={noop}
          onChangeDecor={noop}
          onDisarm={noop}
          onExitEdit={noop}
        />
        {which === 'palette' && (
          <DecorPalette
            roomName="pepsi"
            placing="plant"
            floor="stone"
            hasDecor
            onPick={noop}
            onFloor={noop}
            onPreset={noop}
            onClear={noop}
            onDone={noop}
          />
        )}
        {which === 'roster' && (
          <>
            <div className="panel-backdrop" />
            <RoomRoster roomName="pepsi" robots={[...pepsi, ...pepsi, ...pepsi]} away={away} onOpen={noop} onLetGo={noop} onBringBack={noop} onClose={noop} />
          </>
        )}
        {which === 'picker' && (
          <>
            <div className="panel-backdrop" />
            <FolderPicker onPick={noop} onClose={noop} />
          </>
        )}
        {which === 'chooser' && (
          <>
            <div className="panel-backdrop" />
            <ProjectChooser
              rooms={ROOMS}
              hidden={['/w/old-experiment', '/w/scratch/try-2']}
              names={{}}
              firstRun
              onDone={noop}
              onClose={noop}
            />
          </>
        )}
      </main>
    </div>
  );
}

/** The strips at the top of the window: a new build, and a note from us on its
 *  own — with the traffic-light room the desktop app adds. */
function UpdateRig() {
  const checkedAt = new Date(now).toISOString();
  const build: ReleaseInfo = {
    current: '0.1.15',
    latest: { version: '0.1.16', url: 'https://airoom.dev/download', notes: 'https://airoom.dev/whats-new' },
    updateAvailable: true,
    message: null,
    checkedAt,
  };
  const note: ReleaseInfo = {
    current: '0.1.16',
    latest: { version: '0.1.16', url: 'https://airoom.dev/download' },
    updateAvailable: false,
    message: {
      id: 'rig-teams',
      text: 'Teams are here: hire a lead and a crew, and watch them work in a room of their own.',
      url: 'https://airoom.dev/#teams',
    },
    checkedAt,
  };
  const stack = { display: 'flex', flexDirection: 'column' } as const;
  return (
    <div className="electron" style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', gap: 40 }}>
      <div style={stack}>
        <UpdateBar release={build} />
        <header className="topbar">
          <Logo />
        </header>
      </div>
      <div style={stack}>
        <UpdateBar release={note} />
        <header className="topbar">
          <Logo />
        </header>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.hash.includes('update') ? (
      <UpdateRig />
    ) : window.location.hash.includes('team-panel') ? (
      <TeamRig />
    ) : window.location.hash.includes('lanes') ? (
      <Rig snapshot={LANES_SNAPSHOT} />
    ) : /#(palette|roster|picker|chooser)/.test(window.location.hash) ? (
      <DialogRig which={window.location.hash.slice(1)} />
    ) : window.location.hash.includes('panel') ? (
      <PanelRig />
    ) : (
      <DefaultRig />
    )}
  </StrictMode>,
);
