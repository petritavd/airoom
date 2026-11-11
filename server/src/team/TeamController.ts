import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { runKeyFor, type AgentController } from '../agent/AgentController';
import {
  branchHasWork,
  closeLane,
  commitLane,
  currentBranch,
  hasCommits,
  isGitRepo,
  laneHasWork,
  mergeBranch,
  openLane,
  NO_VCS,
  repoRoot,
  revisionOf,
  slugify,
  startBranch,
  type Lane,
} from './worktrees';
import type {
  Handoff,
  MemberKind,
  PermissionMode,
  RosterMember,
  RunUpdate,
  RoleNotes,
  Team,
  TeamAutonomy,
  TeamMember,
  TeamRole,
  TeamTask,
} from '../../../shared/types';

/**
 * Teams: a lead session that orchestrates and a roster of ordinary sessions
 * that do the work — coordinated by routing structured messages between them.
 *
 * THE LEAD ORCHESTRATES, THIS CLASS REFEREES.
 * The lead decides *what* happens next; this class decides whether it is
 * ALLOWED to. Round caps, the step-by-step gate and the single-writer rule are
 * enforced here, in code, because they are cost and safety policy — and cost
 * policy must not depend on an LLM remembering its instructions. Everything
 * the lead does arrives as a tool call; every tool call lands in one place
 * (`routeAssign`, `routeToLead`); policy lives at that choke point.
 *
 * WHY MEMBERS ARE ORDINARY SESSIONS
 * Every member is a normal robot: it can be chatted with, its tools still ask
 * for permission, it can be denied, resumed, rewound. The team layer only adds
 * an MCP toolset (`airoom-team`) and a role preamble to their runs. If the
 * team is dismissed, the sessions remain — nothing about them was special.
 *
 * TASKS, LANES AND CREWS
 * The board holds tasks; a lane is a place one task can be worked. Lane 1 of a
 * single-lane team is the project folder itself, which is why such a team
 * behaves exactly like the old three-robot team. A team with more lanes gets a
 * git worktree per lane and a CREW per lane — a copy of the roster — because a
 * Claude session is bound to the folder it started in and cannot be moved
 * between them. Crews for lanes 2+ are staffed the moment a second task
 * actually starts, so a team that never runs two things at once never pays for
 * them.
 */

/** Tools a non-writing member must not hold. Bash can still write in
 *  principle — the preamble forbids it and review catches it, but the hard
 *  block on the file tools is what makes "single writer" true in practice. */
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

const TEAM_MCP = 'airoom-team';
const TOOL_PREFIX = `mcp__${TEAM_MCP}__`;

const MAX_LOG = 200; // handoffs kept per team
const DEFAULT_ROUND_CAP = 2;
const MAX_MEMBERS = 6;
const MAX_LANES = 4;

/** The classic team, and what a hire request without a roster still means. */
const STANDARD_ROSTER: RosterMember[] = [
  { kind: 'lead', label: 'Lead' },
  { kind: 'worker', label: 'Builder', writes: true },
  { kind: 'reviewer', label: 'Reviewer' },
];

interface Member {
  /** id within the team: `builder`, or `builder@2` for the lane-2 crew */
  role: TeamRole;
  /** which roster entry it was stamped from — crews across lanes share it */
  rosterId: TeamRole;
  kind: MemberKind;
  label: string;
  writes: boolean;
  /** 1..lanes for crew members; 0 for the lead, who belongs to no lane */
  lane: number;
  /** the folder its session runs in — the project, or the lane's worktree */
  cwd: string;
  sessionId: string | null;
  /** one nudge per assignment when a member ends a turn without reporting */
  nudged: boolean;
  /** the task it currently holds */
  taskId: string | null;
  /** assignments it has had for that task — the second and later ones are
   *  rework, which is what a "fix round" counts */
  assigns: number;
}

interface Parked {
  to: TeamRole;
  text: string;
  handoff: Handoff;
  taskId: string | null;
}

interface LaneState {
  n: number;
  /** null when the lane IS the project folder (a single-lane team) */
  worktree: Lane | null;
  cwd: string;
  /** the task being worked here, if any */
  taskId: string | null;
  /** a crew is staffed on first use */
  staffed: boolean;
}

interface TeamState {
  team: Team;
  members: Member[]; // lead first
  roster: RosterMember[];
  lanes: LaneState[];
  handoffs: Handoff[];
  /** deliveries the referee held back (gated mode, or a round cap) */
  parked: Parked[];
  /** a member whose run died — the lead is told on the next Continue so it can
   *  re-assign, instead of waiting forever for a report nobody will send */
  failed: TeamRole | null;
  mode: PermissionMode;
  model?: string;
  /** The human changed a member's permission mode in its own panel; team
   *  sends honour it — silently reverting a mode the picker still displays
   *  was how "I set the builder to auto-edits" kept asking anyway. */
  memberModes: Partial<Record<TeamRole, PermissionMode>>;
  /** Per-member model overrides — chosen at hire, or later. Absent = team model. */
  memberModels: Partial<Record<TeamRole, string>>;
  /** airoom went away (quit or killed) while this team had turns in flight.
   *  The conversations survive on disk and so does every debt, but anything
   *  still queued for a member died with the process — so the next Continue
   *  re-briefs whoever owes work and replays to the lead what it may never
   *  have read. */
  interrupted: boolean;
  /** the git repository the lanes branch from, when there are real lanes */
  repo: string | null;
  /** The branch the project was on at hire. Every task branch forks from it
   *  and merges back to it — not to wherever the human happens to be later. */
  baseBranch: string | null;
}

export interface TeamDeps {
  controller: AgentController;
  /** run updates from member sessions, forwarded for normal broadcasting */
  onUpdate: (u: RunUpdate) => void;
  onHandoff: (h: Handoff) => void;
  /** team state changed — the gateway rebroadcasts its snapshot */
  onTeamsChanged: () => void;
  /** persistence path override (tests point this at a scratch file) */
  file?: string;
  /** git is stubbed out in tests: lanes are named but never really cut */
  noGit?: boolean;
  /** the folder fingerprint the review gate compares — tests hand in their own */
  revisionOf?: (cwd: string) => string;
  /** How a judgement waits out SETTLE_MS. Defaults to an unref'd timer;
   *  tests run it when they choose. */
  defer?: (fn: () => void, ms: number) => void;
}

/** What a team is told when airoom goes away underneath it. */
const SHUTDOWN_REASON = 'airoom was quit while this team was working. Continue to pick it back up.';

/**
 * How long a quiet member is given before its turn is judged, when messages
 * were pushed into that turn while it ran. The runtime either folds such a
 * message into the turn in flight (it lands at the next tool call) or answers
 * it in a turn of its own right after — and which one happens depends on
 * timing only the runtime sees. A follow-up turn shows itself within about a
 * second of the result; the rest of the window is room for a slow API.
 */
const SETTLE_MS = 8_000;

/** What the referee knows about a member's turns — never persisted: a restart
 *  ends every one of them. */
interface Live {
  /** a turn is running that airoom started (or will, once a spawn resolves) */
  inFlight: boolean;
  /** messages pushed into the turn in flight — each may or may not get a turn of its own */
  pushed: number;
  /** the human typed into this member's own chat since its last turn was judged */
  spoke: boolean;
}

export class TeamController {
  private teams = new Map<string, TeamState>();
  /** keyed `teamId:role` */
  private live = new Map<string, Live>();
  /** Set once the process is shutting down — see shutDown(). */
  private stopping = false;
  private deps: TeamDeps;
  private file: string;
  private seq = 0;

  constructor(deps: TeamDeps) {
    this.deps = deps;
    this.file = deps.file ?? path.join(os.homedir(), '.airoom', 'teams.json');
    this.load();
  }

  // ------------------------------------------------------------------ public

  list(): Team[] {
    return [...this.teams.values()].map((s) => s.team);
  }

  /** role of a session, for decorating robots in the snapshot */
  memberOf(sessionId: string): { id: string; role: TeamRole } | undefined {
    for (const s of this.teams.values())
      for (const m of s.members) if (m.sessionId === sessionId) return { id: s.team.id, role: m.role };
    return undefined;
  }

  log(teamId: string): Handoff[] {
    return this.teams.get(teamId)?.handoffs ?? [];
  }

  /** Rooms whose team is parked — they need the human's attention. */
  roomsAwaitingHuman(): Set<string> {
    const out = new Set<string>();
    for (const s of this.teams.values()) {
      if (s.team.state !== 'awaiting_human') continue;
      out.add(s.team.roomId);
      for (const l of s.lanes) if (l.cwd !== s.team.roomId) out.add(l.cwd);
    }
    return out;
  }

  /**
   * Folders that are lanes rather than projects, so the office can draw them
   * docked to the room they branched from instead of as rooms in their own
   * right. A worktree IS a directory with sessions in it — without this it
   * would show up as a mysterious new project named after a task.
   */
  laneRooms(): Map<string, { teamId: string; homeRoomId: string; lane: number; task: string; branch: string; teamName?: string }> {
    const out = new Map<string, { teamId: string; homeRoomId: string; lane: number; task: string; branch: string; teamName?: string }>();
    for (const s of this.teams.values())
      for (const l of s.lanes) {
        if (!l.worktree) continue;
        const task = l.taskId ? s.team.tasks.find((t) => t.id === l.taskId) : undefined;
        out.set(l.cwd, {
          teamId: s.team.id,
          homeRoomId: s.team.roomId,
          lane: l.n,
          task: task?.title ?? 'idle',
          branch: l.worktree.branch,
          ...(s.team.name ? { teamName: s.team.name } : {}),
        });
      }
    return out;
  }

  /** What the human calls this team. Empty clears it. Persists with the team,
   *  and reaches the room sign and the panel on the next snapshot. */
  rename(teamId: string, name: string): boolean {
    const state = this.teams.get(teamId);
    if (!state) return false;
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (clean) state.team.name = clean;
    else delete state.team.name;
    this.changed(state);
    return true;
  }

  hire(opts: {
    roomId: string;
    task: string;
    autonomy: TeamAutonomy;
    roundCap?: number;
    mode?: PermissionMode;
    model?: string;
    roleNotes?: RoleNotes;
    roleModes?: Partial<Record<TeamRole, PermissionMode>>;
    roleModels?: Partial<Record<TeamRole, string>>;
    /** lead first; omitted = the standard trio */
    roster?: RosterMember[];
    lanes?: number;
    ownRoom?: boolean;
    thrift?: boolean;
  }): { ok: boolean; error?: string; teamId?: string; notice?: string } {
    // One active team per room: the rug, the roster and the panel all assume
    // it, and two leads sharing one working tree would fight over files anyway.
    for (const s of this.teams.values())
      if (s.team.roomId === opts.roomId && (s.team.state === 'working' || s.team.state === 'awaiting_human'))
        return { ok: false, error: 'This room already has a team on the job. Stop or dismiss it first.' };

    const roster = normaliseRoster(opts.roster ?? STANDARD_ROSTER);
    if (roster.length < 2) return { ok: false, error: 'A team needs a lead and at least one other member.' };

    const now = new Date().toISOString();
    const id = `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    // A team gets a space of its own when it is bigger than the classic trio,
    // when it runs several tasks at once, or when the human asks for one. That
    // space is a git worktree: a room in the office IS a folder, so a team
    // cannot have a room of its own without having a checkout of its own.
    let notice: string | undefined;
    let lanes = Math.max(1, Math.min(MAX_LANES, Math.floor(opts.lanes ?? 1)));
    const ownRoom = opts.ownRoom ?? roster.length > 3;
    let repo: string | null = null;
    let baseBranch: string | null = null;
    if (lanes > 1 || ownRoom) {
      if (this.deps.noGit) {
        repo = opts.roomId;
        baseBranch = 'main';
      } else {
        repo = isGitRepo(opts.roomId) ? repoRoot(opts.roomId) : null;
        baseBranch = repo ? currentBranch(repo) : null;
        if (!repo || !hasCommits(repo) || !baseBranch) {
          lanes = 1;
          repo = null;
          baseBranch = null;
          notice =
            'A room of its own needs a git repository, on a branch, with at least one commit — this team works in the project folder, one task at a time.';
        }
      }
    }
    let worktrees = !!repo && (lanes > 1 || ownRoom);

    const firstTask = mkTask(opts.task);
    const team: Team = {
      id,
      roomId: opts.roomId,
      task: opts.task,
      autonomy: opts.autonomy,
      roundCap: Math.max(0, Math.min(10, opts.roundCap ?? DEFAULT_ROUND_CAP)),
      roundsUsed: 0,
      state: 'working',
      members: [],
      costUsd: 0,
      tasksDone: 0,
      roleNotes: opts.roleNotes && Object.values(opts.roleNotes).some((v) => v?.trim()) ? { ...opts.roleNotes } : undefined,
      createdAt: now,
      updatedAt: now,
      tasks: [firstTask],
      lanes,
      worktrees,
      ownRoom: worktrees,
      ...(opts.thrift ? { thrift: true } : {}),
    };

    const state: TeamState = {
      team,
      members: [],
      roster,
      lanes: [],
      handoffs: [],
      parked: [],
      failed: null,
      mode: opts.mode ?? 'default',
      model: opts.model,
      memberModes: { ...(opts.roleModes ?? {}) },
      memberModels: { ...(opts.roleModels ?? {}) },
      interrupted: false,
      repo,
      baseBranch,
    };
    // Per-member settings that came in on the roster itself. The hire form's
    // older per-role maps still work, because an id matches its label.
    for (const r of roster) {
      const rid = r.kind === 'lead' ? 'lead' : slugify(r.label, r.kind);
      if (r.note?.trim()) team.roleNotes = { ...(team.roleNotes ?? {}), [rid]: r.note.trim() };
      if (r.mode) state.memberModes[rid] = r.mode;
      if (r.model) state.memberModels[rid] = r.model;
    }
    this.teams.set(id, state);

    // Lane 1 always exists. With worktrees on it is a checkout of its own, so
    // the project folder stays clean and merges are possible at all. It is cut
    // HERE, before anyone is hired: if git will not give us one, the team
    // downgrades to the project folder with a notice, rather than parking its
    // very first task on an error nobody has done anything to deserve.
    const lane1 = this.ensureLane(state, 1);
    if (worktrees) {
      const cut = this.laneForTask(state, lane1, firstTask);
      if (!cut.ok) {
        worktrees = false;
        team.worktrees = false;
        team.ownRoom = false;
        team.lanes = 1;
        state.repo = null;
        state.baseBranch = null;
        notice = `Could not give this team a room of its own (${cut.error}) — it works in the project folder, one task at a time.`;
      }
    }

    // The lead lives in the project folder: it reads the repository, merges
    // lanes and talks to the human, none of which belong inside a worktree.
    this.addMember(state, roster[0], 0, team.roomId);

    this.emit(state, { from: 'human', to: 'lead', kind: 'assign', summary: firstTask.title, detail: opts.task });
    // Everyone starts at once. Staffing lazily (on the lead's first
    // assignment) meant the bench filled up one robot at a time over a couple
    // of minutes, which looked like the feature failing rather than like a
    // team getting to work. Their briefings are real context they would have
    // been given anyway, so the turn is not wasted.
    this.startTask(state, firstTask, 1, true);
    this.sendToMember(state, 'lead', kickoffText(state, firstTask));
    this.changed(state);
    return { ok: true, teamId: id, notice };
  }

  // --------------------------------------------------------------- the board

  /**
   * Put a task on the board.
   *
   * Unlike the old "next task", this works while the team is busy: hand the
   * lead three jobs in a row and they land in lanes as lanes come free. The
   * sessions are RESUMED, never replaced, which is the whole point — by the
   * second task they already know the project's layout, conventions and test
   * command, so the exploration you paid for once is not paid for again.
   */
  addTask(
    teamId: string,
    brief: string,
    by: 'human' | 'lead' = 'human',
    title?: string,
  ): { ok: boolean; error?: string; taskId?: string } {
    const state = this.teams.get(teamId);
    if (!state) return { ok: false, error: 'No such team.' };
    const clean = brief.trim();
    if (clean.length < 4) return { ok: false, error: 'Give them something to do.' };

    const task = mkTask(clean, title);
    state.team.tasks.push(task);
    state.team.task = clean;
    // Work is the one thing that restarts a stopped team: the sessions are all
    // still there, and "give them something else" is the panel's own offer.
    if (state.team.state === 'stopped' || state.team.state === 'done') {
      state.team.state = 'working';
      state.team.doneSummary = undefined;
      state.team.parkedReason = undefined;
    }
    this.emit(state, { from: by, to: 'lead', kind: 'assign', summary: task.title, detail: clean });
    this.pump(state);
    // Nothing free? The lead is told anyway, so it can plan around the queue
    // rather than discovering one it never agreed to.
    if (task.state === 'queued')
      this.sendToMember(
        state,
        'lead',
        frame(
          by === 'human' ? 'the human' : 'airoom',
          `A new task is on the board and QUEUED — every lane is busy. It starts on its own as soon as one frees.\n\n${task.title}\n\n${clean}`,
        ),
      );
    else if (by === 'human' && task.lane === 1 && state.team.lanes === 1)
      this.sendToMember(state, 'lead', nextTaskText(state, task));
    this.changed(state);
    return { ok: true, taskId: task.id };
  }

  /** The panel's "give them this task" is just a board add. */
  newTask(teamId: string, task: string): { ok: boolean; error?: string } {
    const r = this.addTask(teamId, task, 'human');
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  cancelTask(teamId: string, taskId: string): { ok: boolean; error?: string } {
    const state = this.teams.get(teamId);
    const task = state?.team.tasks.find((t) => t.id === taskId);
    if (!state || !task) return { ok: false, error: 'No such task.' };
    if (task.state === 'merged' || task.state === 'cancelled') return { ok: false, error: 'That task is already closed.' };
    const lane = state.lanes.find((l) => l.taskId === task.id);
    if (lane) {
      for (const m of this.crew(state, lane.n)) {
        if (m.taskId !== task.id) continue;
        const key = m.sessionId ?? runKeyFor({ roomId: m.cwd, spawnTag: `${state.team.id}:${m.role}` });
        this.deps.controller.interrupt(key);
        m.taskId = null;
        m.assigns = 0;
      }
      lane.taskId = null;
    }
    task.state = 'cancelled';
    task.lane = null;
    task.holder = undefined;
    task.awaitingFrom = undefined;
    task.closedAt = new Date().toISOString();
    // The branch survives: it may hold work, and airoom does not delete work.
    // A hold that was about this task — its conflict, its stalled worker — is
    // over with it; a gate for some other task is not.
    if (
      state.team.state === 'awaiting_human' &&
      !state.parked.length &&
      !state.team.tasks.some((t) => t.state === 'blocked')
    ) {
      state.team.state = 'working';
      state.team.parkedReason = undefined;
    }
    this.emit(state, { from: 'human', to: 'lead', kind: 'note', summary: `Task cancelled: ${task.title}` });
    this.sendToMember(
      state,
      'lead',
      frame('the human', `The human cancelled the task "${task.title}". Stop work on it and carry on with the rest of the board.`),
    );
    this.pump(state);
    this.changed(state);
    return { ok: true };
  }

  /** The human merging a lane by hand from the panel. */
  mergeTask(teamId: string, taskId: string): { ok: boolean; error?: string } {
    const state = this.teams.get(teamId);
    const task = state?.team.tasks.find((t) => t.id === taskId);
    if (!state || !task) return { ok: false, error: 'No such task.' };
    // The human may merge whatever they like — it is their repository. But a
    // merge without a standing approval is recorded as one, so the board never
    // shows work as reviewed when it was not.
    if (this.reviewGate(state, task, 'merged')) task.waived = { at: new Date().toISOString() };
    const r = this.doMerge(state, task);
    this.changed(state);
    return r.ok ? { ok: true } : { ok: false, error: r.message };
  }

  /**
   * The human pressed Continue: settle EVERY outstanding hold, in one pass.
   *
   * Holds overlap more often than not — a quit while one lane was gated and
   * another was mid-assignment, a member that died while a fix waited at the
   * cap. Handling only the first kind found left the rest stranded: a gate
   * released while lane 1's builder, killed by the restart, was never told
   * to go on, and the lead waited forever for its report.
   */
  continue_(teamId: string): boolean {
    const state = this.teams.get(teamId);
    if (!state || state.team.state !== 'awaiting_human') return false;
    const afterRestart = state.interrupted;
    state.interrupted = false;
    state.team.state = 'working';
    state.team.parkedReason = undefined;

    // 1. Deliveries the referee held back — released exactly once.
    const parked = state.parked;
    state.parked = [];
    const released = new Set<TeamRole>();
    for (const p of parked) {
      this.deliver(state, p.to, p.text, p.handoff, p.taskId);
      released.add(p.to);
    }

    const toLead: string[] = [];

    // 2. A member that died. Say so plainly and let the lead decide — "pick up
    //    where you left off" is useless advice when the thing you left off on
    //    is a corpse, and the failure may be the size of the work itself.
    const failed = state.failed;
    state.failed = null;
    if (failed) {
      const m = this.member(state, failed);
      toLead.push(
        `${m?.label ?? failed}'s session failed and stopped. It is NOT going to send the report you were waiting for.`,
        `Assigning to "${failed}" again ${m?.sessionId ? 'resumes its conversation' : 'starts it in a fresh conversation'} — re-send the work, ideally in a smaller piece if the last one was large.`,
        'If it fails a second time, use ask_human rather than trying again.',
      );
    }

    // 3. Everyone who still owes work and is not mid-turn: after a restart, a
    //    stop, or a conversation with the human. Nudging the LEAD here is a
    //    deadlock — it checks team_status, sees it is waiting on them, and
    //    settles in to wait for sessions that are not running. Wake the
    //    members themselves, with the assignment in hand.
    const woken: string[] = [];
    for (const { task, who } of this.owing(state)) {
      if (released.has(who) || who === failed) continue;
      // Already working? A reminder pushed into a live turn arrives as
      // steering and derails the very work it asks for.
      if (this.memberBusy(state, who)) continue;
      this.rebrief(state, who, task);
      woken.push(this.member(state, who)?.label ?? who);
    }
    if (woken.length)
      toLead.push(
        `${woken.join(' and ')} ${woken.length > 1 ? 'have' : 'has'} been reminded to finish and report — the report${
          woken.length > 1 ? 's arrive' : ' arrives'
        } here. Do not re-assign unless ${woken.length > 1 ? 'they stay' : 'it stays'} silent.`,
      );

    // 4. Whatever reached the lead just before airoom went away may have died
    //    in a queue with the process. Replaying it costs a few lines; losing
    //    it strands a finished report nobody acts on.
    if (afterRestart) {
      const unread = this.unreadByLead(state);
      if (unread.length)
        toLead.push(
          '',
          'These reached you just before airoom closed — you may not have acted on them yet:',
          ...unread.map((h) => `- ${this.describe(state, h)}`),
        );
    }

    // 5. The lead: one message, and only when it has something to hear or
    //    the ball is its own.
    const lead = this.member(state, 'lead');
    const leadsMove = !this.owing(state).length && !released.size;
    if (lead && !lead.sessionId && afterRestart) {
      // The process died before the lead's first turn even began: its new
      // conversation knows nothing, and "pick up where you left off" to a
      // blank session is how a restarted team came back with no idea what it
      // was for. (Without a restart, a missing id only means the kickoff is
      // still resolving — briefing it twice would be the bug.)
      this.sendToMember(state, 'lead', [rejoinText(state), ...toLead].join('\n'));
    } else if (toLead.length || leadsMove) {
      if (!toLead.length && this.memberBusy(state, 'lead')) {
        this.emit(state, {
          from: 'server',
          to: 'human',
          kind: 'note',
          summary: 'The lead is still working — the hold is lifted without interrupting it.',
        });
      } else {
        this.sendToMember(
          state,
          'lead',
          frame(
            'the human',
            [
              afterRestart
                ? 'The human pressed Continue. (airoom had been closed; it is open again, and every conversation is intact.)'
                : 'The human pressed Continue.',
              ...toLead,
              leadsMove ? '\nIt is your move: pick up where you left off; check team_status if unsure.' : '',
            ]
              .filter((l, i, all) => l !== '' || (i > 0 && i < all.length - 1))
              .join('\n'),
          ),
        );
      }
    } else if (!released.size) {
      this.emit(state, {
        from: 'server',
        to: 'human',
        kind: 'note',
        summary: 'The team is still working — the hold is lifted without interrupting it.',
      });
    }
    this.changed(state);
    return true;
  }

  /** Send a member back to the assignment it still owes a report on. */
  private rebrief(state: TeamState, who: TeamRole, task: TeamTask) {
    const m = this.member(state, who);
    if (!m) return;
    const lastAssign = [...state.handoffs].reverse().find((h) => h.to === who && h.kind === 'assign');
    m.nudged = false;
    this.sendToMember(
      state,
      who,
      frame(
        'airoom',
        [
          m.sessionId
            ? 'Your earlier run ended before you reported — a stop, an airoom restart, or a conversation with the human. The assignment still stands: finish it and report as usual.'
            : `You are ${m.label.toUpperCase()} on this team. Your earlier conversation could not be resumed, so here is your assignment in full.`,
          lastAssign ? `\nThe assignment, again:\n${lastAssign.detail ?? lastAssign.summary}` : `\nThe task:\n${task.brief}`,
          `\nWhen done, call ${reportTool(m.kind)} — the team is waiting on it (task: ${task.title}).`,
        ].join('\n'),
      ),
    );
  }

  /** What was sent to the lead after it last acted — after a restart it may
   *  never have read it: a message queued behind a turn dies with the process. */
  private unreadByLead(state: TeamState): Handoff[] {
    const h = state.handoffs;
    let i = h.length - 1;
    while (i >= 0 && h[i].from !== 'lead') i--;
    return h.slice(i + 1).filter((x) => x.to === 'lead' && x.from !== 'server').slice(-6);
  }

  /** One handoff, readable by the lead it is replayed to. */
  private describe(state: TeamState, h: Handoff): string {
    const who = h.from === 'human' ? 'The human' : (this.member(state, h.from)?.label ?? h.from);
    const body = shorten(h.detail ?? h.summary, 1500);
    if (h.kind === 'result') return `${who} reported: ${body}`;
    if (h.kind === 'verdict') return `${who}'s verdict — ${h.verdict ?? 'unknown'}: ${body}`;
    if (h.kind === 'assign') return `${who} asked for: ${body}`;
    return `${who}: ${body}`;
  }

  stop(teamId: string): boolean {
    const state = this.teams.get(teamId);
    if (!state) return false;
    for (const m of state.members) {
      const key = m.sessionId ?? runKeyFor({ roomId: m.cwd, spawnTag: `${state.team.id}:${m.role}` });
      this.deps.controller.interrupt(key);
    }
    state.team.state = 'stopped';
    state.parked = [];
    this.emit(state, { from: 'human', to: 'lead', kind: 'note', summary: 'Team stopped by the human.' });
    this.changed(state);
    return true;
  }

  dismiss(teamId: string): boolean {
    const state = this.teams.get(teamId);
    if (!state) return false;
    if (state.team.state === 'working' || state.team.state === 'awaiting_human') return false; // stop first
    // Take the lanes down. Loose work is committed first, a branch that was
    // merged is deleted with its lane, and anything still holding work keeps
    // its branch, in the repository, untouched.
    if (state.repo && !this.deps.noGit)
      for (const l of state.lanes) if (l.worktree) closeLane(state.repo, l.worktree);
    this.teams.delete(teamId);
    this.persist();
    this.deps.onTeamsChanged();
    return true;
  }

  /** Lane branches that still hold unmerged work — the panel warns with these
   *  before a dismiss takes the worktrees away. */
  unmergedBranches(teamId: string): string[] {
    const state = this.teams.get(teamId);
    if (!state?.repo || this.deps.noGit) return [];
    const base = state.baseBranch ?? undefined;
    const out = new Set<string>();
    // The branch each lane is on now (which may hold uncommitted work), and
    // every task's branch — a cancelled task's branch is nobody's lane any
    // more, but it can still hold the work that was done before the cancel.
    for (const l of state.lanes) if (l.worktree && laneHasWork(l.worktree, state.repo, base)) out.add(l.worktree.branch);
    for (const t of state.team.tasks) if (t.branch && branchHasWork(state.repo, t.branch, base)) out.add(t.branch);
    return [...out];
  }

  // -------------------------------------------------------------- lanes/crew

  private ensureLane(state: TeamState, n: number): LaneState {
    const found = state.lanes.find((l) => l.n === n);
    if (found) return found;
    const lane: LaneState = { n, worktree: null, cwd: state.team.roomId, taskId: null, staffed: false };
    state.lanes.push(lane);
    return lane;
  }

  /**
   * Put a lane on a task's own branch.
   *
   * The first task in a lane cuts the worktree; every later one switches it to
   * a fresh branch off the project's branch as it stands now, so a crew never
   * starts from another task's stale world. Whatever the previous task left
   * loose is committed to its own branch first — nothing is ever discarded.
   */
  private laneForTask(state: TeamState, lane: LaneState, task: TeamTask): { ok: boolean; error?: string } {
    const slug = slugify(task.title, 'task');
    if (this.deps.noGit) {
      const previous = lane.worktree?.branch;
      const want = `airoom/${slug}`;
      const branch = previous === want ? `${want}-2` : want;
      lane.worktree = { path: path.join(state.team.roomId, `.lane-${lane.n}`), branch };
    } else if (!state.repo || !state.baseBranch) {
      return { ok: false, error: 'no repository to branch from' };
    } else if (!lane.worktree) {
      const wt = openLane(state.repo, state.team.id, `lane-${lane.n}`, slug, state.baseBranch);
      if (!wt) return { ok: false, error: 'git would not create the worktree' };
      lane.worktree = wt;
    } else {
      const r = startBranch(lane.worktree, state.repo, state.baseBranch, slug);
      if (!r.ok || !r.branch) return { ok: false, error: r.error ?? 'could not switch branch' };
      lane.worktree.branch = r.branch;
    }
    lane.cwd = lane.worktree.path;
    task.branch = lane.worktree.branch;
    task.worktree = lane.worktree.path;
    return { ok: true };
  }

  /** Spawn a lane's crew: one copy of the roster, minus the lead. */
  private staffLane(state: TeamState, n: number) {
    const lane = this.ensureLane(state, n);
    if (lane.staffed) return;
    lane.staffed = true;
    for (const r of state.roster) {
      if (r.kind === 'lead') continue;
      const m = this.addMember(state, r, n, lane.cwd);
      this.sendToMember(state, m.role, standbyText(state, m));
    }
  }

  private addMember(state: TeamState, r: RosterMember, lane: number, cwd: string): Member {
    const rosterId = r.kind === 'lead' ? 'lead' : slugify(r.label, r.kind);
    const role = lane > 1 ? `${rosterId}@${lane}` : rosterId;
    const m: Member = {
      role,
      rosterId,
      kind: r.kind,
      label: lane > 1 ? `${r.label} · lane ${lane}` : r.label,
      writes: r.kind === 'worker' && r.writes !== false,
      lane,
      cwd,
      sessionId: null,
      nudged: false,
      taskId: null,
      assigns: 0,
    };
    state.members.push(m);
    const pub: TeamMember = { role, kind: m.kind, label: m.label, sessionId: null, writes: m.writes, lane };
    state.team.members.push(pub);
    // A crew member inherits its roster entry's own settings.
    if (lane > 1) {
      if (state.memberModes[rosterId]) state.memberModes[role] = state.memberModes[rosterId];
      if (state.memberModels[rosterId]) state.memberModels[role] = state.memberModels[rosterId];
    }
    this.publishSettings(state);
    return m;
  }

  private member(state: TeamState, role: TeamRole): Member | undefined {
    return state.members.find((m) => m.role === role);
  }

  /**
   * airoom itself is going away. Every live run is about to die with it, and
   * the wreckage says nothing anyone can act on — "the run ended:
   * error_during_execution" is what killing the process looks like from the
   * inside, and that string is what the human was left holding. Park each
   * working team with the real reason instead, and stop letting the dying runs
   * overwrite it.
   */
  shutDown(): void {
    this.stopping = true;
    for (const state of this.teams.values()) {
      if (state.team.state !== 'working' && state.team.state !== 'awaiting_human') continue;
      // The RUNS die with the process; the conversations do not — they are on
      // disk and resume. So every debt stays on the books: whoever owed a
      // report still owes it, and Continue sends them back to it. Wiping the
      // debt here made an ordinary quit worse than a crash — the lead was told
      // "pick up where you left off" and the builder was never woken.
      const inFlight = state.members.some((m) => this.memberBusy(state, m.role) || this.liveOf(state, m.role).inFlight);
      if (state.team.state === 'working' || inFlight) state.interrupted = true;
      if (state.team.state !== 'working') continue; // a gate or a question keeps its own, truer reason
      state.team.state = 'awaiting_human';
      state.team.parkedReason = SHUTDOWN_REASON;
      this.emit(state, {
        from: 'server',
        to: 'human',
        kind: 'note',
        summary: 'airoom was quit while this team was working.',
      });
      state.team.updatedAt = new Date().toISOString();
    }
    this.persist();
  }

  /**
   * The fingerprint the review gate compares. '' means git could not answer,
   * which the gate refuses on rather than reading as "nothing moved".
   */
  private rev(cwd: string): string {
    if (this.deps.revisionOf) return this.deps.revisionOf(cwd);
    if (this.deps.noGit) return NO_VCS;
    return revisionOf(cwd) ?? '';
  }

  private crew(state: TeamState, lane: number): Member[] {
    return state.members.filter((m) => m.lane === lane);
  }

  /** Every (task, member) pair where a report is still owed. */
  private owing(state: TeamState): { task: TeamTask; who: TeamRole }[] {
    return state.team.tasks
      .filter((t) => (t.state === 'working' || t.state === 'blocked') && t.awaitingFrom)
      .map((t) => ({ task: t, who: t.awaitingFrom as TeamRole }));
  }

  private taskOf(state: TeamState, role: TeamRole): TeamTask | undefined {
    const m = this.member(state, role);
    if (!m) return undefined;
    if (m.taskId) return state.team.tasks.find((t) => t.id === m.taskId);
    const lane = state.lanes.find((l) => l.n === m.lane);
    return lane?.taskId ? state.team.tasks.find((t) => t.id === lane.taskId) : undefined;
  }

  /** Start every queued task a free lane can take. */
  private pump(state: TeamState) {
    if (state.team.state === 'stopped') return;
    for (const task of state.team.tasks) {
      if (task.state !== 'queued') continue;
      const free = this.freeLane(state);
      if (free === null) return;
      // git refused the lane: the task is parked, not started, and trying the
      // next queued task in the same lane would only park that one too.
      if (!this.startTask(state, task, free)) return;
    }
  }

  private freeLane(state: TeamState): number | null {
    for (let n = 1; n <= state.team.lanes; n++) {
      const lane = state.lanes.find((l) => l.n === n);
      if (!lane) return n; // never opened — free by definition
      if (!lane.taskId) return n;
    }
    return null;
  }

  /** Returns false when git refused the lane and the task was parked instead. */
  private startTask(state: TeamState, task: TeamTask, n: number, atHire = false): boolean {
    const lane = this.ensureLane(state, n);
    // A worktree lane is put on this task's own branch before anyone touches
    // it. At hire that already happened (so the team could downgrade cleanly
    // if git refused); later, a refusal parks the task where the human can see
    // it, and the lane stays free for the next one.
    if (state.team.worktrees && !(lane.worktree && task.branch && lane.worktree.branch === task.branch)) {
      const r = this.laneForTask(state, lane, task);
      if (!r.ok) {
        task.state = 'blocked';
        task.note = `Could not start "${task.title}" in lane ${n}: ${r.error}.`;
        this.holdForHuman(state, task.note);
        return false;
      }
    }
    const wasStaffed = lane.staffed;
    this.staffLane(state, n);
    lane.taskId = task.id;
    task.state = 'working';
    task.lane = n;
    task.roundsUsed = 0;
    task.note = undefined;
    for (const m of this.crew(state, n)) {
      m.taskId = task.id;
      m.assigns = 0;
      m.nudged = false;
    }
    // A crew that already exists is told its lane has new work; a brand-new
    // crew was just told in its standby briefing.
    if (wasStaffed) for (const m of this.crew(state, n)) this.sendToMember(state, m.role, standbyText(state, m, true));
    // The lead is told which lane took the work — except at hire, when the
    // kickoff it is about to receive says all of this already.
    if (state.team.lanes > 1 && !atHire)
      this.sendToMember(
        state,
        'lead',
        frame(
          'airoom',
          [
            `Task "${task.title}" has started in LANE ${n}.`,
            lane.worktree ? `Lane ${n} is the worktree ${lane.worktree.path} on branch ${lane.worktree.branch}.` : '',
            `Its crew: ${this.crew(state, n)
              .map((m) => `"${m.role}" (${m.label})`)
              .join(', ')}. Assign to those ids for this task.`,
            '',
            task.brief,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
    return true;
  }

  // ------------------------------------------------------- the referee's desk

  /**
   * The lead wants to hand work to a member. Everything that makes teams safe
   * to leave alone happens in these few lines.
   */
  private routeAssign(state: TeamState, to: TeamRole, instructions: string, context = ''): string {
    const { team } = state;
    if (team.state === 'stopped')
      return 'The human stopped this team. It can only be restarted from the team panel — say so and stop here.';
    const member = this.member(state, to);
    if (!member || member.kind === 'lead')
      return `There is no member called "${to}". Call team_status to see who is on this team, and use the ids it lists.`;
    // Finishing is the lead's own call, not a locked door. When more work
    // arrives — a late review, a defect found after the fact — the lead has the
    // sessions that already know this task, and refusing left it with nowhere
    // to put the work. Fix-round caps still apply.
    if (team.state === 'done') {
      team.state = 'working';
      team.doneSummary = undefined;
      team.parkedReason = undefined;
      this.emit(state, {
        from: 'server',
        to: 'human',
        kind: 'note',
        summary: 'The lead reopened the finished team to send more work.',
      });
    }

    let task = this.taskOf(state, to);
    // Reopening: the lead finished, then more work turned up. Its last task in
    // this lane comes back rather than the assignment being refused — the lead
    // has nowhere else to put a late fix, and hiring a fresh team to apply one
    // is the expensive mistake this avoids.
    if (!task || (task.state !== 'working' && task.state !== 'blocked')) {
      const last = [...state.team.tasks]
        .reverse()
        .find((t) => t.state !== 'cancelled' && (t.lane === member.lane || t.lane === null));
      const laneFree = !state.lanes.find((l) => l.n === member.lane)?.taskId;
      if (last && laneFree) {
        task = last;
        this.reopenTask(state, task, member.lane);
      } else {
        return `Lane ${member.lane} has no live task, so there is nothing to assign "${to}" to. Put work on the board with add_task first, or assign to a member whose lane is busy.`;
      }
    }

    // THE SINGLE-WRITER RULE. Two agents editing one working tree is not
    // parallelism; it is a merge conflict with extra steps. Readers are
    // unlimited — they cannot collide with anything.
    if (member.writes) {
      const busy = this.crew(state, member.lane).find(
        (m) => m.writes && m.role !== to && m.taskId === task.id && task.awaitingFrom === m.role,
      );
      if (busy)
        return `REFUSED: ${busy.label} is still editing in lane ${member.lane}, and only one member may write in a lane at a time. Wait for its report, then assign "${to}".`;
    }

    const handoff: Handoff = this.mkHandoff(state, {
      from: 'lead',
      to,
      kind: 'assign',
      summary: firstLine(instructions),
      detail: instructions,
    });
    // The lead has already read the project by the time it assigns. Passing on
    // what it found is the single biggest saving available here: without it
    // every member re-explores the same repository from scratch, and you pay
    // for the same discovery on several separate bills.
    const text = frame(
      'the lead',
      context.trim()
        ? `${instructions}\n\n--- what I already worked out (trust this, do not re-derive it) ---\n${context.trim()}`
        : instructions,
    );

    // Fix rounds: every assignment to a member after its first, for the same
    // task, is a rework pass.
    if (member.assigns >= 1 && member.writes && team.autonomy === 'auto_capped') {
      if (task.roundsUsed >= team.roundCap) {
        this.park(
          state,
          { to, text, handoff, taskId: task.id },
          `Fix-round cap reached (${team.roundCap}) on "${task.title}". Continue to allow another round.`,
        );
        return `PARKED: the fix-round cap (${team.roundCap}) is reached on "${task.title}". The human has been asked to continue — do nothing until then, or call ask_human with what you would do next.`;
      }
    }

    // Step-by-step mode: every assignment waits for the human's go-ahead.
    if (team.autonomy === 'gated') {
      this.park(
        state,
        { to, text, handoff, taskId: task.id },
        `The lead wants to hand work to ${member.label}. Continue to allow it.`,
      );
      return `PARKED: this team runs step-by-step, so the human must press Continue before ${member.label} starts. Do nothing until then.`;
    }

    this.deliver(state, to, text, handoff, task.id);
    return `Delivered to ${member.label}.`;
  }

  /** A member reports back — always routed to the lead, never parked. */
  private routeToLead(
    state: TeamState,
    from: TeamRole,
    handoffPatch: Omit<Handoff, 'id' | 'teamId' | 'ts'>,
    text: string,
  ): string {
    if (state.team.state === 'stopped') return 'This team is no longer running.';
    const task = this.taskOf(state, from);
    // A report the lead was still owed outlives a premature finish — throwing
    // away work that was actually done is the one outcome nobody wants.
    if (state.team.state === 'done') {
      if (!task || task.awaitingFrom !== from) return 'This team is no longer running.';
      state.team.state = 'working';
      state.team.doneSummary = undefined;
      if (task.state !== 'working') this.reopenTask(state, task, this.member(state, from)?.lane ?? 1);
    }
    const handoff = this.mkHandoff(state, handoffPatch);
    if (task && task.awaitingFrom === from) {
      task.awaitingFrom = undefined;
      task.holder = undefined;
    }
    const m = this.member(state, from);
    if (m) m.nudged = false;
    this.deliver(state, 'lead', text, handoff, task?.id ?? null);
    return 'Delivered to the lead.';
  }

  /** Put a closed task back in front of a lane, keeping its rounds spent. */
  private reopenTask(state: TeamState, task: TeamTask, laneNo: number) {
    const lane = this.ensureLane(state, task.lane ?? laneNo);
    // A reopened worktree task is put back on a branch of its own, cut from
    // the project as it stands now — its old branch was merged and is gone,
    // or is unmerged and stays as it is either way.
    if (state.team.worktrees && !(lane.worktree && task.branch && lane.worktree.branch === task.branch)) {
      const r = this.laneForTask(state, lane, task);
      if (!r.ok) {
        task.state = 'blocked';
        task.note = `Could not reopen "${task.title}" in lane ${lane.n}: ${r.error}.`;
        this.holdForHuman(state, task.note);
        return;
      }
    }
    task.state = 'working';
    task.lane = lane.n;
    task.closedAt = undefined;
    lane.taskId = task.id;
    for (const m of this.crew(state, lane.n)) if (!m.taskId) m.taskId = task.id;
    state.team.tasksDone = Math.max(0, state.team.tasksDone - 1);
  }

  private park(state: TeamState, parked: Parked, reason: string) {
    state.parked.push(parked);
    state.team.state = 'awaiting_human';
    state.team.parkedReason = reason;
    const task = parked.taskId ? state.team.tasks.find((t) => t.id === parked.taskId) : undefined;
    if (task) {
      task.state = 'blocked';
      task.note = reason;
    }
    // The parked handoff is visible immediately (it explains WHY the room is
    // waving), marked as headed to the human first.
    this.deps.onHandoff({ ...parked.handoff, to: 'human', summary: `parked: ${parked.handoff.summary}` });
    this.changed(state);
  }

  /** Is this member mid-turn? A nudge pushed into a live turn is steering.
   *  The runtime is the authority once a session id exists; before that
   *  (a spawn still resolving) only airoom's own record can answer. */
  private memberBusy(state: TeamState, role: TeamRole): boolean {
    const id = this.member(state, role)?.sessionId;
    if (id && this.deps.controller.isBusy) return this.deps.controller.isBusy(id) === true;
    return this.live.get(`${state.team.id}:${role}`)?.inFlight === true;
  }

  /** Actually push a framed message into a member's session. */
  private deliver(state: TeamState, to: TeamRole, text: string, handoff: Handoff, taskId: string | null) {
    // Work is moving again, so any hold that was NOT a gate — a stall report, a
    // member that died, a stop — is now stale. Nothing used to clear it: the
    // team ran to completion under a "needs you" banner, and the Continue it
    // invited arrived in the middle of live work. A real gate (a parked
    // handoff) is never cleared here; only the human releases those.
    if (state.team.state === 'awaiting_human' && !state.parked.length) {
      state.team.state = 'working';
      state.team.parkedReason = undefined;
      if (state.failed === to) state.failed = null;
      this.emit(state, {
        from: 'server',
        to: 'human',
        kind: 'note',
        summary: 'The team moved on its own — clearing the hold that was waiting on you.',
      });
    }
    const task = taskId ? state.team.tasks.find((t) => t.id === taskId) : undefined;
    const member = this.member(state, to);
    if (member && member.kind !== 'lead') {
      // A fix round is a REWORK: the same writer sent back to the same task.
      // A reviewer looking again is not one, or a single review loop would
      // burn two of the human's rounds instead of one.
      if (member.assigns >= 1 && member.writes && task) task.roundsUsed += 1;
      member.assigns += 1;
      if (task) member.taskId = task.id;
      member.nudged = false;
      if (task) {
        task.awaitingFrom = to;
        task.holder = to;
        if (task.state === 'blocked') {
          task.state = 'working';
          task.note = undefined;
        }
      }
    } else {
      // Fresh input for the lead: it gets a fresh chance to stall once.
      const lead = this.member(state, 'lead');
      if (lead) lead.nudged = false;
    }
    state.handoffs.push(handoff);
    if (state.handoffs.length > MAX_LOG) state.handoffs.shift();
    this.deps.onHandoff(handoff);
    this.sendToMember(state, to, text);
    this.changed(state);
  }

  // ------------------------------------------------------------ closing tasks

  private closeTask(
    state: TeamState,
    task: TeamTask,
    summary: string,
    quiet = false,
    byHuman = false,
  ): { closed: boolean; note: string } {
    // The gate. A crew with a reviewer closes nothing the reviewer has not
    // approved AS IT NOW STANDS — the prompt used to ask the lead nicely, and
    // a lead in a hurry merged unreviewed work with nobody the wiser. The
    // human may override from the panel; that is written on the board.
    if (!byHuman) {
      const refusal = this.reviewGate(state, task);
      if (refusal) {
        this.changed(state);
        return { closed: false, note: refusal };
      }
    }
    task.summary = summary;
    task.state = 'done';
    task.closedAt = new Date().toISOString();
    state.team.tasksDone += 1;
    // `awaitingFrom` is deliberately NOT cleared. A lead that closes a task
    // while someone still owes a report has been premature, and the report is
    // still coming; keeping the debt on the books is what lets that late work
    // reopen the task instead of being thrown away.
    const lane = state.lanes.find((l) => l.taskId === task.id);
    if (lane)
      for (const m of this.crew(state, lane.n)) {
        if (task.awaitingFrom === m.role) continue;
        m.taskId = null;
        m.assigns = 0;
      }
    if (!quiet)
      this.emit(state, {
        from: 'lead',
        to: 'human',
        kind: 'finish',
        summary: `${task.title} — ${firstLine(summary)}`,
        detail: summary,
      });

    let note = `"${task.title}" is closed.`;
    const merge = this.doMerge(state, task);
    note += ` ${merge.message}`;
    if (!merge.ok) {
      // A conflict is the human's to resolve; the lane keeps its branch and
      // the rest of the board carries on in its own lanes.
      this.changed(state);
      return { closed: true, note };
    }
    // doMerge freed the lane and pumped the queue, so whatever started next is
    // already live — say so, or the lead learns about it from team_status.
    const started = state.team.tasks.find((t) => t.state === 'working' && t.lane === lane?.n && t.id !== task.id);
    const live = state.team.tasks.filter((t) => t.state === 'working' || t.state === 'queued' || t.state === 'blocked');
    if (started)
      note += ` Next up in lane ${started.lane}: "${started.title}" — its crew is ${this.crew(state, started.lane ?? 1)
        .map((m) => `"${m.role}"`)
        .join(', ')}; assign when ready.`;
    note += live.length
      ? ` Still on the board: ${live.map((t) => `"${t.title}"`).join(', ')}.`
      : ' The board is empty — call finish when you are done reporting.';
    this.changed(state);
    return { closed: true, note };
  }

  /**
   * Why a task may not close yet, or null when it may. Only crews with a
   * reviewer are gated: a crew without one is unreviewed by design, and the
   * board says so rather than pretending.
   */
  private reviewGate(state: TeamState, task: TeamTask, verb = 'closed'): string | null {
    if (task.waived) return null;
    const lane = state.lanes.find((l) => l.taskId === task.id);
    // A lane still holding the task names its own reviewers; once the lane is
    // freed the task is judged on the record alone.
    const reviewers = (lane ? this.crew(state, lane.n) : state.members).filter((m) => m.kind === 'reviewer');
    if (!reviewers.length) return null;
    const r = task.review;
    const name = (role: TeamRole) => this.member(state, role)?.label ?? role;
    const ask = `if the human wants it ${verb} regardless, they can do that from the panel.`;
    if (!r) return `Not ${verb}: "${task.title}" has no verdict yet. Assign ${name(reviewers[0].role)} to review it; ${ask}`;
    if (r.verdict !== 'approve')
      return `Not ${verb}: ${name(r.by)} requested changes on "${task.title}". Fix them, then ask for a fresh verdict.`;
    // No lane left to look at: the recorded verdict is all there is.
    if (!lane) {
      if (r.stale)
        return `Not ${verb}: the changes moved after ${name(r.by)} approved "${task.title}". Ask for a fresh verdict on what is there now.`;
      return null;
    }
    const now = this.rev(lane.cwd);
    if (!now || !r.rev) {
      // git could not answer. Refusing is the only safe reading: treating an
      // unanswerable comparison as "unchanged" is how unreviewed edits merge.
      r.stale = true;
      return `Not ${verb}: airoom could not check whether "${task.title}" still matches what ${name(r.by)} approved. Ask for a fresh verdict, or ${ask}`;
    }
    if (now !== r.rev) {
      r.stale = true;
      return `Not ${verb}: the changes moved since ${name(r.by)} approved "${task.title}". Ask for a fresh verdict on what is there now.`;
    }
    r.stale = undefined;
    return null;
  }

  /**
   * The human closing a task from the panel without an approval on record —
   * the one override the gate accepts. It is recorded on the task, the lead is
   * told, and the board reads "closed without review" for as long as it lives.
   */
  closeTaskByHuman(teamId: string, taskId: string): { ok: boolean; error?: string } {
    const state = this.teams.get(teamId);
    const task = state?.team.tasks.find((t) => t.id === taskId);
    if (!state || !task) return { ok: false, error: 'No such task.' };
    if (task.state !== 'working' && task.state !== 'blocked') return { ok: false, error: 'That task is not open.' };
    task.waived = { at: new Date().toISOString() };
    const r = this.closeTask(state, task, task.summary ?? 'Closed by the human without a review.', false, true);
    this.sendToMember(
      state,
      'lead',
      frame('the human', `The human closed "${task.title}" without waiting for a review. ${r.note}`),
    );
    this.changed(state);
    return r.closed ? { ok: true } : { ok: false, error: r.note };
  }

  /**
   * Bring a task's branch home, and say in one line what happened.
   *
   * On success the task's lane is freed and the queue pumped — HERE, on every
   * path that can succeed, and not only in closeTask. The retry a lead makes
   * after a conflict used to mark the task merged and leave its lane occupied
   * for the rest of the team's life.
   */
  private doMerge(state: TeamState, task: TeamTask): { ok: boolean; message: string } {
    if (!state.team.worktrees || !task.branch || !state.repo || !state.baseBranch) {
      if (task.state === 'done') task.state = 'merged';
      this.laneFreed(state, task);
      return { ok: true, message: 'It ran in the project folder, so there is nothing to merge.' };
    }
    if (this.deps.noGit) {
      task.state = 'merged';
      task.note = `Merged ${task.branch}.`;
      this.laneFreed(state, task);
      return { ok: true, message: task.note };
    }
    // If the branch is still checked out in a lane, whatever is loose there is
    // committed first. If the lane has moved on, that already happened when it
    // switched branches, and the branch merges as it stands.
    const lane = state.lanes.find((l) => !!l.worktree && l.worktree.branch === task.branch);
    if (lane?.worktree) {
      const commit = commitLane(lane.worktree, `airoom: ${task.title}`);
      if (!commit.ok) {
        task.state = 'blocked';
        task.note = `Could not commit lane ${lane.n}: ${commit.error}`;
        this.holdForHuman(state, task.note);
        return { ok: false, message: task.note };
      }
    }
    const res = mergeBranch(state.repo, task.branch, task.title, state.baseBranch);
    if (res.ok) {
      task.state = 'merged';
      task.note = res.empty ? 'Nothing to merge — the lane changed no files.' : `Merged ${task.branch} into ${state.baseBranch}.`;
      this.laneFreed(state, task);
      return { ok: true, message: task.note };
    }
    task.state = 'blocked';
    task.note = res.conflicts?.length
      ? `Merge conflict on ${res.conflicts.slice(0, 6).join(', ')}${
          res.conflicts.length > 6 ? `, +${res.conflicts.length - 6} more` : ''
        }. The project folder was left untouched; the work is on ${task.branch}.`
      : `Merge failed: ${res.error ?? 'unknown'}`;
    this.holdForHuman(state, task.note);
    return { ok: false, message: task.note };
  }

  /** A task is off its lane for good: free the lane and let the queue in. */
  private laneFreed(state: TeamState, task: TeamTask) {
    const lane = state.lanes.find((l) => l.taskId === task.id);
    if (lane) lane.taskId = null;
    // A hold that was about THIS task's merge is over. A gate for another task
    // (a parked delivery) is not.
    if (
      state.team.state === 'awaiting_human' &&
      !state.parked.length &&
      !state.team.tasks.some((t) => t.state === 'blocked')
    ) {
      state.team.state = 'working';
      state.team.parkedReason = undefined;
    }
    this.pump(state);
  }

  /** Park the TEAM on something only the human can settle. */
  private holdForHuman(state: TeamState, reason: string) {
    state.team.state = 'awaiting_human';
    state.team.parkedReason = reason;
    this.emit(state, { from: 'server', to: 'human', kind: 'note', summary: reason });
  }

  // ------------------------------------------------------------ member runs

  private sendToMember(state: TeamState, role: TeamRole, text: string) {
    const { team } = state;
    const member = this.member(state, role);
    if (!member) return;
    this.noteSend(state, role, 'team');
    const server = this.toolsFor(state, role);
    void this.deps.controller
      .send(
        {
          roomId: member.cwd,
          sessionId: member.sessionId ?? undefined,
          spawnTag: `${team.id}:${role}`,
          text,
          mode: state.memberModes[role] ?? state.mode,
          model: state.memberModels[role] ?? state.model,
          mcpServers: { [TEAM_MCP]: server },
          systemPromptAppend: preambleFor(state, member),
          extraDisallowedTools: member.writes ? [] : WRITE_TOOLS,
          autoAllowToolPrefixes: [TOOL_PREFIX],
        },
        (u) => this.onRunUpdate(state, role, u),
      )
      .catch((err) => {
        this.turnOver(state, role);
        this.memberTrouble(state, role, `${member.label} failed to start: ${String(err)}`);
      });
  }

  private liveOf(state: TeamState, role: TeamRole): Live {
    const key = `${state.team.id}:${role}`;
    let l = this.live.get(key);
    if (!l) this.live.set(key, (l = { inFlight: false, pushed: 0, spoke: false }));
    return l;
  }

  /** A message is on its way to a member — from the team, or from the human
   *  typing into its own chat. */
  private noteSend(state: TeamState, role: TeamRole, from: 'team' | 'direct') {
    const l = this.liveOf(state, role);
    if (this.memberBusy(state, role)) l.pushed += 1; // lands inside the turn in flight
    l.inFlight = true;
    if (from === 'direct') l.spoke = true;
  }

  /** The turn in flight is over: stopped, failed, or finished. */
  private turnOver(state: TeamState, role: TeamRole): number {
    const l = this.liveOf(state, role);
    const pushed = l.pushed;
    l.inFlight = false;
    l.pushed = 0;
    return pushed;
  }

  private later(fn: () => void, ms: number) {
    if (this.deps.defer) return this.deps.defer(fn, ms);
    setTimeout(fn, ms).unref?.();
  }

  private onRunUpdate(state: TeamState, role: TeamRole, u: RunUpdate) {
    this.observeRun(state, role, u);
    this.deps.onUpdate(u);
  }

  /**
   * Copy each member's effective permission mode and model onto the public
   * record, so its own panel can show what it is really running with instead
   * of the app's defaults.
   */
  private publishSettings(state: TeamState) {
    for (const pub of state.team.members) {
      pub.mode = state.memberModes[pub.role] ?? state.mode;
      const model = state.memberModels[pub.role] ?? state.model;
      pub.model = model || undefined;
    }
  }

  /** Team-side bookkeeping for one member's run update (no broadcasting). */
  private observeRun(state: TeamState, role: TeamRole, u: RunUpdate) {
    const member = this.member(state, role);
    if (!member) return;
    if (u.sessionId && !member.sessionId) {
      member.sessionId = u.sessionId;
      const pub = state.team.members.find((m) => m.role === role);
      if (pub) pub.sessionId = u.sessionId;
      this.changed(state);
    }
    if (u.phase === 'result') {
      // The controller sends a SECOND result after every turn carrying only the
      // context meter. Counting it as a turn ending made one silent turn read
      // as two, so the lead's single allowed stall was spent and the team
      // parked in the same second it was nudged — a "needs you" banner over a
      // team that was working fine.
      if (u.meter) return;
      if (typeof u.cost === 'number' && u.cost > 0) {
        state.team.costUsd += u.cost;
        this.changed(state);
      }
      const pushed = this.turnOver(state, role);
      if (u.interrupted) {
        this.liveOf(state, role).spoke = false;
        const task = this.taskOf(state, role);
        if (state.team.state !== 'working') return;
        if (task?.awaitingFrom === role && member.kind !== 'lead') {
          // The HUMAN stopped it — an instruction, not an accident. Nudging it
          // back to work meant the stop button restarted the very thing it
          // stopped. Park instead, keeping the debt so Continue re-briefs it.
          state.team.state = 'awaiting_human';
          state.team.parkedReason = `You stopped ${member.label} mid-assignment. Continue to have it pick the work back up, or step into its chat first.`;
          this.emit(state, { from: 'server', to: 'human', kind: 'note', summary: `${member.label} was stopped by the human.` });
          this.changed(state);
        } else if (role === 'lead' && !this.owing(state).length && !state.parked.length) {
          // The lead was stopped while it held the ball. Without this the team
          // sat "working" forever with nobody moving and nothing on screen
          // saying why.
          state.team.state = 'awaiting_human';
          state.team.parkedReason = 'You stopped the lead. Continue when you want it to pick the task back up.';
          this.emit(state, { from: 'server', to: 'human', kind: 'note', summary: 'The lead was stopped by the human.' });
          this.changed(state);
        }
        return;
      }
      // Messages were pushed into this turn while it ran — a fix, a report,
      // the human's own words. The runtime either folded them into the turn
      // that just ended or is about to answer them in a turn of its own. Wait
      // for it to show which: judging now nagged members about work they had
      // not been shown yet, and never judging would let an absorbed message
      // end in silence.
      if (pushed > 0) {
        this.later(() => {
          if (this.memberBusy(state, role)) return; // a follow-up turn is running; it is judged when it ends
          this.judgeTurnEnd(state, member);
        }, SETTLE_MS);
        return;
      }
      this.judgeTurnEnd(state, member);
    }
    if (u.phase === 'error') {
      this.turnOver(state, role);
      if (state.team.state !== 'working') return;
      // A run dying because airoom is being quit is not the member's failure,
      // and shutDown has already said the true thing.
      if (this.stopping) return;
      // The conversation itself is gone — deleted by hand, or cleaned up by
      // Claude Code after a month. Resuming it again is a wall the team would
      // walk into on every Continue; start the member over instead.
      if (member.sessionId && /no conversation found/i.test(u.text ?? '')) {
        this.startFresh(state, member);
        return;
      }
      this.memberTrouble(state, role, `${member.label} hit an error: ${u.text ?? 'unknown'}`);
    }
  }

  /**
   * A member's turn is over and nothing more is coming for it. If it still
   * owes the next move, it gets one reminder, then the human is told. A turn
   * that answered the HUMAN is a conversation, not a stall: no nag is ever
   * injected into your own chat — but "working" with nobody working is a
   * hang, so the panel says plainly who is waiting on whom.
   */
  private judgeTurnEnd(state: TeamState, member: Member) {
    const l = this.liveOf(state, member.role);
    const spoke = l.spoke;
    l.spoke = false;
    if (state.team.state !== 'working' || !this.teams.has(state.team.id)) return;
    const task = this.taskOf(state, member.role);
    if (member.kind !== 'lead') {
      if (task?.awaitingFrom !== member.role) return;
      if (spoke) {
        this.holdForHuman(
          state,
          `${member.label} answered you but has not reported on its assignment yet. Continue sends it back to the task — or keep talking to it.`,
        );
        this.changed(state);
      } else if (!member.nudged) {
        member.nudged = true;
        this.sendToMember(
          state,
          member.role,
          frame('airoom', `Your turn ended without a report. Call the ${reportTool(member.kind)} tool now — the team is waiting on it.`),
        );
      } else {
        this.memberTrouble(state, member.role, `${member.label} went quiet without reporting. Step into its chat, or Continue to nudge the lead.`);
      }
      return;
    }
    // The lead's turn ended with nothing in flight and nothing parked: every
    // path through assign/ask_human/finish changes what this checks, so the
    // ball is sitting with the lead and nobody is moving.
    if (this.owing(state).length || state.parked.length) return;
    // …unless the work is simply finished: every task on the board is closed
    // and the lead stopped talking. Nudging it for the formal `finish` cost a
    // whole turn to learn what the board already says, so airoom closes the
    // team itself, with the last delivery as its report.
    const tasks = state.team.tasks;
    const open = tasks.some((t) => t.state === 'working' || t.state === 'queued' || t.state === 'blocked');
    const delivered = [...tasks].reverse().find((t) => t.state === 'merged' || t.state === 'done');
    if (!open && delivered) {
      const summary = delivered.summary?.trim() || `${delivered.title} — delivered.`;
      state.team.state = 'done';
      state.team.doneSummary = summary;
      state.team.parkedReason = undefined;
      this.emit(state, {
        from: 'lead',
        to: 'human',
        kind: 'finish',
        summary: `Every task is closed — ${firstLine(summary)}`,
        detail: summary,
      });
      this.changed(state);
      return;
    }
    if (spoke) {
      this.holdForHuman(state, 'The lead answered you. Continue when you want it to carry on with the task.');
      this.changed(state);
    } else if (!member.nudged) {
      member.nudged = true;
      this.sendToMember(
        state,
        'lead',
        frame(
          'airoom',
          'Your turn ended without moving the team: no assign, no ask_human, no finish. The task only advances through those tools — check team_status if unsure, then act.',
        ),
      );
    } else {
      this.memberTrouble(state, 'lead', 'The lead stalled twice without using a team tool. Continue to nudge it, or step into its chat.');
    }
  }

  /** Put a member whose conversation no longer exists into a new one, with
   *  whatever it needs to carry on: the lead its briefing, a member its
   *  assignment. */
  private startFresh(state: TeamState, m: Member) {
    m.sessionId = null;
    const pub = state.team.members.find((x) => x.role === m.role);
    if (pub) pub.sessionId = null;
    this.emit(state, {
      from: 'server',
      to: 'human',
      kind: 'note',
      summary: `${m.label}'s conversation could not be found, so it was started fresh.`,
    });
    const task = this.taskOf(state, m.role);
    if (m.kind === 'lead') this.sendToMember(state, 'lead', rejoinText(state));
    else if (task && task.awaitingFrom === m.role) this.rebrief(state, m.role, task);
    this.changed(state);
  }

  private memberTrouble(state: TeamState, role: TeamRole, reason: string) {
    state.team.state = 'awaiting_human';
    state.team.parkedReason = reason;
    // Stop expecting a report from a member that just died, and remember WHO
    // died. Without this the team parked, the human pressed Continue, the lead
    // checked team_status, saw "working, no report yet" and settled in to wait
    // for a session that was never coming back — a deadlock that looked from
    // the outside like the whole feature had hung.
    const task = this.taskOf(state, role);
    if (task?.awaitingFrom === role) task.awaitingFrom = undefined;
    if (role !== 'lead') state.failed = role;
    this.emit(state, { from: 'server', to: 'human', kind: 'note', summary: reason });
    this.changed(state);
  }

  // ------------------------------------------------------------------- tools

  /**
   * Plain handlers for one member's tools — the MCP layer wraps these, and the
   * test harness calls them directly, so the referee's every rule is provable
   * without a model or an MCP client in the loop.
   */
  handlersFor(teamId: string, role: TeamRole): Record<string, (args: Record<string, unknown>) => Promise<string>> {
    const state = this.teams.get(teamId);
    if (!state) return {};
    const member = this.member(state, role);
    if (!member) return {};
    if (member.kind === 'lead') {
      return {
        assign: async (a) =>
          this.routeAssign(state, String(a.member ?? a.role ?? ''), String(a.instructions ?? ''), String(a.context ?? '')),
        team_status: async () => JSON.stringify(this.statusFor(state), null, 2),
        add_task: async (a) => {
          const brief = String(a.brief ?? '');
          const r = this.addTask(state.team.id, brief, 'lead', String(a.title ?? '') || undefined);
          if (!r.ok) return `Not added: ${r.error}`;
          const task = state.team.tasks.find((t) => t.id === r.taskId);
          if (!task) return 'Not added.';
          return task.state === 'queued'
            ? `Queued "${task.title}" — every lane is busy. It starts by itself when one frees.`
            : `"${task.title}" started in lane ${task.lane}. Its crew: ${this.crew(state, task.lane ?? 1)
                .map((m) => `"${m.role}"`)
                .join(', ')}.`;
        },
        finish_task: async (a) => {
          const task = this.resolveTask(state, String(a.task ?? ''));
          if (!task) return `No live task matches "${String(a.task ?? '')}". Call team_status for the board.`;
          return this.closeTask(state, task, String(a.summary ?? '')).note;
        },
        merge_task: async (a) => {
          const task = this.resolveTask(state, String(a.task ?? ''), true);
          if (!task) return `No task matches "${String(a.task ?? '')}". Call team_status for the board.`;
          // The gate guards every route a branch can travel, not just the one
          // finish_task takes — merging IS the thing review exists to protect.
          const refusal = this.reviewGate(state, task, 'merged');
          if (refusal) {
            this.changed(state);
            return refusal;
          }
          const r = this.doMerge(state, task);
          this.changed(state);
          return r.message;
        },
        ask_human: async (a) => {
          const question = String(a.question ?? '');
          this.emit(state, { from: 'lead', to: 'human', kind: 'question', summary: firstLine(question), detail: question });
          state.team.state = 'awaiting_human';
          state.team.parkedReason = question;
          this.changed(state);
          return 'The human has been asked. Stop here — the answer arrives as a message in this chat.';
        },
        finish: async (a) => {
          const summary = String(a.summary ?? '');
          const live = state.team.tasks.filter(
            (t) => t.state === 'working' || t.state === 'queued' || t.state === 'blocked',
          );
          // One task in flight is the ordinary case, and finish has always been
          // how a lead ends it — closing it here keeps that true. Two or more,
          // and finish is ambiguous enough to be dangerous: it would silently
          // declare lanes done that nobody reviewed.
          if (live.length > 1)
            return `Not yet — ${live
              .map((t) => `"${t.title}"`)
              .join(', ')} are still on the board. Close each with finish_task first, so each lane is merged on its own.`;
          if (live.length === 1) {
            const r = this.closeTask(state, live[0], summary, true);
            // The review gate said no: the task is still open, and so is the team.
            if (!r.closed) return `Not finished: ${r.note}`;
            // The close tried to merge and could not. The team is parked on
            // that, and saying "done" over it would clear the one hold that
            // tells the human their work is sitting unmerged on a branch.
            if (live[0].state === 'blocked') return `Not finished: ${r.note}`;
          }
          state.team.state = 'done';
          state.team.doneSummary = summary;
          // Whatever the team was last held on is over — leaving the reason set
          // put a stale "you stopped the lead" under a finished team's report.
          state.team.parkedReason = undefined;
          state.parked = [];
          this.emit(state, { from: 'lead', to: 'human', kind: 'finish', summary: firstLine(summary), detail: summary });
          this.changed(state);
          return 'Recorded. The team is done — thank the members if you like, then stop.';
        },
      };
    }
    if (member.kind === 'worker') {
      return {
        report_result: async (a) => {
          const summary = String(a.summary ?? '');
          const status = a.status === 'blocked' ? 'blocked' : 'done';
          // A writer reporting after an approval may have moved the code. Say
          // so on the board now rather than only when the lead tries to close.
          if (member.writes) {
            const lane = state.lanes.find((l) => l.n === member.lane);
            const task = lane?.taskId ? state.team.tasks.find((t) => t.id === lane.taskId) : undefined;
            if (lane && task?.review) task.review.stale = this.rev(lane.cwd) !== task.review.rev;
          }
          return this.routeToLead(
            state,
            role,
            { from: role, to: 'lead', kind: 'result', summary: firstLine(summary), detail: summary },
            frame(member.label, `${status === 'blocked' ? '[BLOCKED] ' : ''}${summary}`),
          );
        },
      };
    }
    return {
      give_verdict: async (a) => {
        const verdict = a.verdict === 'approve' ? 'approve' : 'request_changes';
        const notes = String(a.notes ?? '');
        // Written on the task with a fingerprint of the lane's folder as the
        // reviewer saw it. Closing compares against it, so an approval covers
        // exactly these changes and nothing that comes after.
        const lane = state.lanes.find((l) => l.n === member.lane);
        const task = lane?.taskId ? state.team.tasks.find((t) => t.id === lane.taskId) : undefined;
        if (lane && task) task.review = { verdict, by: role, at: new Date().toISOString(), rev: this.rev(lane.cwd) };
        return this.routeToLead(
          state,
          role,
          {
            from: role,
            to: 'lead',
            kind: 'verdict',
            verdict,
            summary: `${verdict === 'approve' ? 'approved' : 'changes requested'} — ${firstLine(notes)}`,
            detail: notes,
          },
          frame(member.label, `Verdict: ${verdict}\n\n${notes}`),
        );
      },
    };
  }

  /** What the lead sees when it checks in: the board, and who owes what. */
  private statusFor(state: TeamState) {
    return {
      state: state.team.state,
      autonomy: state.team.autonomy,
      fixRoundCap: state.team.roundCap,
      costUsd: Number(state.team.costUsd.toFixed(4)),
      lanes: state.team.lanes,
      ...(state.baseBranch ? { mergesInto: state.baseBranch } : {}),
      // Answers the question the lead actually has when it checks in. Kept at
      // the top level as well as per task, because a lead that skims will read
      // one line and act on it.
      waitingOn:
        state.team.tasks.find((t) => (t.state === 'working' || t.state === 'blocked') && t.awaitingFrom)?.awaitingFrom ??
        'nobody — it is your move',
      board: state.team.tasks
        .filter((t) => t.state !== 'cancelled')
        .map((t) => ({
          id: t.id,
          title: t.title,
          state: t.state,
          lane: t.lane,
          branch: t.branch,
          fixRounds: `${t.roundsUsed}/${state.team.roundCap}`,
          waitingOn: t.awaitingFrom ?? (t.state === 'working' ? 'nobody — it is your move' : undefined),
          note: t.note,
        })),
      members: state.members.map((m) => ({
        id: m.role,
        label: m.label,
        kind: m.kind,
        edits: m.writes,
        lane: m.lane || undefined,
        workingOn: m.taskId ? state.team.tasks.find((t) => t.id === m.taskId)?.title : undefined,
        owesReport: !!m.taskId && state.team.tasks.find((t) => t.id === m.taskId)?.awaitingFrom === m.role,
      })),
    };
  }

  /** Match a task by id, title, lane, or a loose contains — models quote titles. */
  private resolveTask(state: TeamState, needle: string, includeClosed = false): TeamTask | undefined {
    const live = (t: TeamTask) =>
      includeClosed || t.state === 'working' || t.state === 'blocked' || t.state === 'queued';
    const pool = state.team.tasks.filter(live);
    if (!needle.trim()) return pool.length === 1 ? pool[0] : undefined;
    const n = needle.trim().toLowerCase();
    return (
      pool.find((t) => t.id === needle) ??
      pool.find((t) => t.title.toLowerCase() === n) ??
      pool.find((t) => String(t.lane) === n || `lane ${t.lane}` === n) ??
      pool.find((t) => t.title.toLowerCase().includes(n) || n.includes(t.title.toLowerCase())) ??
      // One task on the board cannot be mistaken for another. Models paraphrase
      // titles ("Add --version flag" for "Add a --version flag…"), and refusing
      // cost a team_status round-trip for an answer that was never in doubt.
      (pool.length === 1 ? pool[0] : undefined)
    );
  }

  /**
   * The `airoom-team` MCP server for one member: the handlers above, wrapped.
   * Built per team+role so each handler closes over exactly who is calling —
   * a member can never speak as someone else, because its toolset physically
   * cannot.
   */
  private toolsFor(state: TeamState, role: TeamRole) {
    const h = this.handlersFor(state.team.id, role);
    const wrap = (name: string) => async (args: Record<string, unknown>) => text(await h[name](args));
    const member = this.member(state, role);
    const tools = [];
    if (member?.kind === 'lead') {
      const crew = state.members.filter((m) => m.kind !== 'lead');
      const ids = crew.map((m) => m.role);
      tools.push(
        tool(
          'assign',
          `Hand a work item to a team member. Assignments must be self-contained: the goal, the constraints, and the files involved. Your team: ${
            crew
              .map(
                (m) =>
                  `"${m.role}" — ${m.label}, ${
                    m.kind === 'reviewer' ? 'reviews, cannot edit' : m.writes ? 'edits files' : 'reads only'
                  }${m.lane > 1 ? `, lane ${m.lane}` : ''}`,
              )
              .join('; ') || 'nobody yet'
          }. The work lands on whatever task that member's lane is holding.`,
          {
            member: ids.length ? z.enum(ids as [string, ...string[]]) : z.string(),
            instructions: z.string().min(1),
            context: z
              .string()
              .optional()
              .describe(
                'What you already worked out, so they do not repeat your exploration: exact file paths, how the relevant code is structured, the conventions to follow, how to run the tests. Every fact you leave out here is one they pay to rediscover.',
              ),
          },
          wrap('assign'),
        ),
        tool(
          'team_status',
          'The board and the roster: every task, which lane it is in, who owes a report, cost so far.',
          {},
          wrap('team_status'),
        ),
        tool(
          'add_task',
          'Put another job on the board. It starts immediately if a lane is free, otherwise it queues. Use this to split a large brief into pieces that can run side by side — NOT for a fix to work already in a lane, which is an ordinary assign.',
          { title: z.string().optional().describe('Two or three words, for the board.'), brief: z.string().min(1) },
          wrap('add_task'),
        ),
        tool(
          'finish_task',
          'Close one task out: its lane frees, the next queued task starts, and (when the lane is a worktree) its branch is merged into the project. Refused until the lane\'s reviewer has approved the changes as they now stand — a fix after an approval needs a fresh verdict. Only the human can close a task without one, from the panel.',
          { task: z.string().describe('The task title, its id, or its lane number.'), summary: z.string().min(1) },
          wrap('finish_task'),
        ),
        tool(
          'ask_human',
          'Stop and put a question to the human. Use when blocked, when the round cap is reached, or when a decision is not yours to make.',
          { question: z.string().min(1) },
          wrap('ask_human'),
        ),
        tool(
          'finish',
          'Close the WHOLE job out, once every task on the board is closed. The summary is shown to the human.',
          { summary: z.string().min(1) },
          wrap('finish'),
        ),
      );
      if (state.team.worktrees)
        tools.push(
          tool(
            'merge_task',
            "Merge a lane's branch into the project. finish_task already does this — use it only to retry after the human resolved a conflict or committed their own work. It is refused on the same terms as finish_task: the reviewer's approval must still match the changes.",
            { task: z.string().describe('The task title, its id, or its lane number.') },
            wrap('merge_task'),
          ),
        );
    }
    if (member?.kind === 'worker') {
      tools.push(
        tool(
          'report_result',
          'Report your assignment back to the lead. Summarise what changed and name the files — never paste whole files.',
          { summary: z.string().min(1), status: z.enum(['done', 'blocked']) },
          wrap('report_result'),
        ),
      );
    }
    if (member?.kind === 'reviewer') {
      tools.push(
        tool(
          'give_verdict',
          'Deliver your review to the lead. Approve only what you verified yourself; requested changes must cite file:line.',
          { verdict: z.enum(['approve', 'request_changes']), notes: z.string().min(1) },
          wrap('give_verdict'),
        ),
      );
    }
    // Always in the prompt, never deferred behind tool search. Deferred, every
    // team move cost the member a ToolSearch round-trip first — and a model
    // that forgets a deferred tool exists stalls a team that "only advances
    // through those tools". There are a handful of them; they are cheap.
    return createSdkMcpServer({ name: TEAM_MCP, version: '1.0.0', tools, alwaysLoad: true });
  }

  /**
   * A DIRECT human message is about to go to this session (the gateway says
   * so just before sending). The turn it produces is a conversation, not team
   * work: when it ends without a tool call, that is an answer to the human —
   * never a stall to nag about.
   */
  noteDirectSend(sessionId: string) {
    for (const state of this.teams.values())
      for (const m of state.members) if (m.sessionId === sessionId) this.noteSend(state, m.role, 'direct');
  }

  /**
   * The human explicitly changed a member's permission mode (the picker in
   * that member's own panel). Remember it, or the next team assignment
   * quietly reverts the run to the hire-time mode while the picker still
   * shows the human's choice.
   */
  noteMemberMode(sessionId: string, mode: PermissionMode) {
    for (const state of this.teams.values()) {
      for (const m of state.members) {
        if (m.sessionId !== sessionId) continue;
        state.memberModes[m.role] = mode;
        this.publishSettings(state);
        this.persist();
        return;
      }
    }
  }

  /**
   * The human picked a model in a member's own panel (it rides every direct
   * send). Remember it, or team assignments quietly snap the member back to
   * the team-wide model — measured in the wild as a lead running 83 turns on
   * the default model against 20 on the one the human had chosen.
   */
  noteMemberModel(sessionId: string, model: string) {
    if (!model.trim()) return; // no choice made — never wipe a hire-time role model
    for (const state of this.teams.values()) {
      for (const m of state.members) {
        if (m.sessionId !== sessionId) continue;
        if (state.memberModels[m.role] === model) return;
        state.memberModels[m.role] = model;
        this.publishSettings(state);
        this.persist();
        return;
      }
    }
  }

  /**
   * The team half of a DIRECT chat with a member.
   *
   * Members are ordinary sessions, and the human talks to them through the
   * ordinary send path — which knows nothing about teams. Left bare, that
   * resume replaces the member's equipped run with one that has NO team
   * tools, no role preamble and no write-blocks: the reviewer loses
   * give_verdict, the lead loses finish, and the first thing anyone hears
   * after a restart is "the team MCP server just dropped". The gateway calls
   * this before every send; a member session gets its equipment back, and
   * everything else gets null.
   */
  directSendEquipment(sessionId: string): {
    mcpServers: Record<string, unknown>;
    systemPromptAppend: string;
    extraDisallowedTools: string[];
    autoAllowToolPrefixes: string[];
    observe: (u: RunUpdate) => void;
  } | null {
    for (const state of this.teams.values()) {
      for (const m of state.members) {
        if (m.sessionId !== sessionId) continue;
        return {
          mcpServers: { [TEAM_MCP]: this.toolsFor(state, m.role) },
          systemPromptAppend: preambleFor(state, m),
          extraDisallowedTools: m.writes ? [] : WRITE_TOOLS,
          autoAllowToolPrefixes: [TOOL_PREFIX],
          observe: (u) => this.observeRun(state, m.role, u),
        };
      }
    }
    return null;
  }

  // --------------------------------------------------------------- plumbing

  private mkHandoff(state: TeamState, patch: Omit<Handoff, 'id' | 'teamId' | 'ts'>): Handoff {
    return { id: `h${++this.seq}-${Date.now().toString(36)}`, teamId: state.team.id, ts: new Date().toISOString(), ...patch };
  }

  /** record + broadcast a handoff that needs no delivery (notes, questions) */
  private emit(state: TeamState, patch: Omit<Handoff, 'id' | 'teamId' | 'ts'>) {
    const h = this.mkHandoff(state, patch);
    state.handoffs.push(h);
    if (state.handoffs.length > MAX_LOG) state.handoffs.shift();
    this.deps.onHandoff(h);
  }

  private changed(state: TeamState) {
    // The panel's meter reads "fix rounds on the work in front of you", not a
    // lifetime total — a standing team would otherwise look permanently capped.
    const live = state.team.tasks.filter((t) => t.state === 'working' || t.state === 'blocked');
    state.team.roundsUsed = live.length
      ? live.reduce((n, t) => n + t.roundsUsed, 0)
      : (state.team.tasks[state.team.tasks.length - 1]?.roundsUsed ?? 0);
    state.team.updatedAt = new Date().toISOString();
    this.persist();
    this.deps.onTeamsChanged();
  }

  /**
   * Save every team — atomically. The file is written beside the real one and
   * renamed over it, so a crash mid-save leaves the old version whole instead
   * of half a JSON document. The version it replaces is kept as `.bak`, one
   * change behind, for when something else damages the file.
   */
  private persist() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const dump = [...this.teams.values()].map((s) => ({
        team: s.team,
        roster: s.roster,
        members: s.members,
        lanes: s.lanes,
        handoffs: s.handoffs,
        parked: s.parked,
        failed: s.failed,
        interrupted: s.interrupted,
        mode: s.mode,
        model: s.model,
        memberModes: s.memberModes,
        memberModels: s.memberModels,
        repo: s.repo,
        baseBranch: s.baseBranch,
      }));
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 2, teams: dump }, null, 2));
      try {
        renameSync(this.file, `${this.file}.bak`);
      } catch {
        /* first save — nothing to keep */
      }
      renameSync(tmp, this.file);
    } catch {
      /* a read-only disk should not take the feature down */
    }
  }

  /**
   * Read the save file, or its backup when the file is damaged. A file that
   * does not parse is moved aside and kept, never overwritten: before this, a
   * save torn by a crash read as "first run", and the very next save replaced
   * every team the human had with an empty list.
   */
  private readSaved(): { raw: { v: number; teams: unknown[] }; recovered: boolean } | null {
    const read = (f: string): { v: number; teams: unknown[] } | 'missing' | 'damaged' => {
      let text: string;
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        return 'missing';
      }
      try {
        const raw = JSON.parse(text) as { v: number; teams: unknown[] };
        return raw && Array.isArray(raw.teams) ? raw : 'damaged';
      } catch {
        return 'damaged';
      }
    };
    const quarantine = (f: string, tag: string) => {
      try {
        renameSync(f, `${this.file}${tag}.corrupt-${Date.now()}`);
      } catch {
        /* nothing more to do */
      }
    };
    const main = read(this.file);
    if (typeof main === 'object') return { raw: main, recovered: false };
    if (main === 'damaged') {
      console.error(`[teams] ${this.file} is damaged — kept aside, loading the backup`);
      quarantine(this.file, '');
    }
    // Damaged, or missing because a crash landed between the two renames of a
    // save: the backup is at most one change behind.
    const bak = read(`${this.file}.bak`);
    if (typeof bak === 'object') return { raw: bak, recovered: true };
    if (bak === 'damaged') quarantine(`${this.file}.bak`, '.bak');
    return null; // first run, or nothing recoverable
  }

  private load() {
    const saved = this.readSaved();
    if (!saved) return;
    const { raw } = saved;
    let normalised = saved.recovered;
    for (const entry of raw.teams ?? []) {
      const s = entry as Partial<{
        team: Team;
        roster: RosterMember[];
        members: Member[];
        lanes: LaneState[];
        handoffs: Handoff[];
        parked: Parked[] | { to: TeamRole; text: string; handoff: Handoff };
        failed: TeamRole | null;
        interrupted: boolean;
        awaitingReportFrom: TeamRole | null;
        mode: PermissionMode;
        model: string;
        memberModes: Partial<Record<TeamRole, PermissionMode>>;
        memberModels: Partial<Record<TeamRole, string>>;
        repo: string | null;
        baseBranch: string | null;
      }>;
      if (!s?.team?.id) continue;
      const team = migrateTeam(s.team, s.awaitingReportFrom ?? null);
      const roster = s.roster ?? rosterFromTeam(team);
      const members: Member[] =
        s.members?.map((m) => ({ ...m, taskId: m.taskId ?? null, assigns: m.assigns ?? 0, nudged: false })) ??
        team.members.map((m) => ({
          role: m.role,
          rosterId: m.role.split('@')[0],
          kind: m.kind,
          label: m.label,
          writes: !!m.writes,
          lane: m.lane ?? (m.kind === 'lead' ? 0 : 1),
          cwd: team.roomId,
          sessionId: m.sessionId,
          nudged: false,
          taskId: team.tasks.find((t) => t.awaitingFrom === m.role)?.id ?? null,
          assigns: 0,
        }));
      const lanes: LaneState[] = s.lanes?.length
        ? s.lanes
        : [
            {
              n: 1,
              worktree: null,
              cwd: team.roomId,
              taskId: team.tasks.find((t) => t.state === 'working' || t.state === 'blocked')?.id ?? null,
              staffed: true,
            },
          ];
      const state: TeamState = {
        team,
        roster,
        members,
        lanes,
        handoffs: s.handoffs ?? [],
        parked: Array.isArray(s.parked) ? s.parked : s.parked ? [{ ...s.parked, taskId: null }] : [],
        // Who died and why must outlive a restart, or Continue tells the lead
        // "pick up where you left off" about a member that is not coming back.
        failed: s.failed ?? null,
        interrupted: !!s.interrupted,
        mode: s.mode ?? 'default',
        model: s.model,
        memberModes: s.memberModes ?? {},
        memberModels: s.memberModels ?? {},
        repo: s.repo ?? null,
        // A team saved before the base was pinned merges to wherever the
        // project is when it is resumed — the old behaviour, once, rather than
        // refusing every merge of a team that has already done work.
        baseBranch: s.baseBranch ?? (s.repo && !this.deps.noGit ? currentBranch(s.repo) : s.repo ? 'main' : null),
      };
      // A team that was mid-flight when the server died cannot silently keep
      // "working" — its runs are gone. Say so, and let Continue resume it.
      if (state.team.state === 'working') {
        // Killed hard, before shutDown could run. Same truth, said on the way in.
        state.team.state = 'awaiting_human';
        state.team.parkedReason = SHUTDOWN_REASON;
        state.interrupted = true;
        normalised = true;
      }
      this.publishSettings(state);
      this.teams.set(state.team.id, state);
    }
    // Write the corrected truth back straight away, so the file never says
    // "working" about a team the app is showing as waiting on you.
    if (normalised) this.persist();
  }
}

// ------------------------------------------------------------------ wording

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

const firstLine = (s: string) => {
  const line = s.trim().split('\n')[0];
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
};

const frame = (from: string, body: string) => `[airoom team — from ${from}]\n${body}`;

const reportTool = (kind: MemberKind) => (kind === 'reviewer' ? 'give_verdict' : 'report_result');

/**
 * A name for a task, from whatever the human typed.
 *
 * Cut on a WORD boundary, never mid-word: a title is read on the board, on a
 * room's sign and in the lead's own tools, and "…what to fix in cod" is worse
 * than a short phrase in every one of those places.
 */
function shorten(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[,;:.\-–—]+$/, '')}…`;
}

function mkTask(brief: string, title?: string): TeamTask {
  const clean = brief.trim();
  const first = clean.split('\n')[0].trim();
  return {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    title: shorten(title?.trim() || first, 48) || 'Task',
    brief: clean,
    state: 'queued',
    lane: null,
    roundsUsed: 0,
    createdAt: new Date().toISOString(),
  };
}

/** Force the shape every roster must have: exactly one lead, first, unique
 *  ids, and a size a lead can actually keep track of. */
function normaliseRoster(input: RosterMember[]): RosterMember[] {
  const lead = input.find((m) => m.kind === 'lead');
  const rest = input.filter((m) => m.kind !== 'lead').slice(0, MAX_MEMBERS - 1);
  const seen = new Set<string>(['lead']);
  const out: RosterMember[] = [{ ...(lead ?? { kind: 'lead', label: 'Lead' }), kind: 'lead', label: lead?.label || 'Lead' }];
  for (const m of rest) {
    let label = (m.label || m.kind).trim();
    let id = slugify(label, m.kind);
    for (let n = 2; seen.has(id) && n < 20; n++) {
      label = `${(m.label || m.kind).trim()} ${n}`;
      id = slugify(label, m.kind);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...m, label, writes: m.kind === 'worker' ? m.writes !== false : false });
  }
  return out;
}

/** A team persisted before the board existed: one task, one lane, no worktrees. */
function migrateTeam(team: Team, awaiting: TeamRole | null): Team {
  team.tasksDone ??= 0;
  team.lanes ??= 1;
  team.worktrees ??= false;
  team.members = (team.members ?? []).map((m) => {
    const kind: MemberKind = m.kind ?? (m.role === 'lead' ? 'lead' : m.role === 'reviewer' ? 'reviewer' : 'worker');
    return {
      ...m,
      kind,
      label: m.label ?? m.role.charAt(0).toUpperCase() + m.role.slice(1),
      writes: m.writes ?? kind === 'worker',
      lane: m.lane ?? (kind === 'lead' ? 0 : 1),
    };
  });
  if (!team.tasks?.length) {
    const t = mkTask(team.task);
    t.state =
      team.state === 'done'
        ? 'merged'
        : team.state === 'stopped'
          ? 'cancelled'
          : team.state === 'awaiting_human'
            ? 'blocked'
            : 'working';
    t.lane = t.state === 'working' || t.state === 'blocked' ? 1 : null;
    t.roundsUsed = team.roundsUsed ?? 0;
    if (awaiting) {
      t.awaitingFrom = awaiting;
      t.holder = awaiting;
    }
    team.tasks = [t];
  }
  return team;
}

function rosterFromTeam(team: Team): RosterMember[] {
  const seen = new Set<string>();
  const out: RosterMember[] = [];
  for (const m of team.members) {
    if ((m.lane ?? 0) > 1) continue;
    const id = m.role.split('@')[0];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: m.kind, label: m.label, writes: m.writes });
  }
  if (!out.some((m) => m.kind === 'lead')) out.unshift({ kind: 'lead', label: 'Lead' });
  return out;
}

/**
 * Role preambles. Kept short on purpose: every token here is paid on every
 * turn of every member. The protocol details live in tool descriptions, which
 * the model reads exactly when it needs them.
 */
function preambleFor(state: TeamState, m: Member): string {
  const { team } = state;
  const shared = [
    `You are ${m.label.toUpperCase()} on an airoom team working in this repository.`,
    `The team's brief: ${team.task}`,
    `Messages framed "[airoom team — from …]" come from teammates via airoom's routing. The human can also chat with you directly at any time — answer them normally.`,
  ];
  if (m.kind === 'lead') {
    const roster = state.members
      .filter((x) => x.kind !== 'lead')
      .map((x) => `"${x.role}" (${x.label}, ${x.kind === 'reviewer' ? 'reviews only' : x.writes ? 'edits files' : 'reads only'})`)
      .join(', ');
    shared.push(
      `You orchestrate; you do not build. Your team: ${roster || 'nobody yet'}. Read the repo enough to write good assignments, then use the assign tool — assignments must be self-contained: goal, constraints, the files involved.`,
      // The lead is the only member that explores freely. Everything it learns
      // and does not pass on gets rediscovered by other agents, on more bills.
      "ALWAYS fill in the assign tool's `context`: exact file paths, how the relevant code is laid out, the conventions in use, how to run the tests. Whatever you leave out, they pay to work out again from scratch.",
      'Never edit files yourself, and never paste whole files between members — give paths and findings, let them read what they need.',
      'Flow per task: assign a worker → on its report, assign a reviewer → on approval, call finish_task. On request_changes, send ONE consolidated fix pass. finish_task is refused until the reviewer has approved what is there NOW: any fix after an approval needs a fresh verdict before the task can close.',
      'If a tool answers PARKED or REFUSED, stop and do what it says — the human or another member holds the next move. If you are blocked or out of rounds, ask_human. Check team_status when unsure who owes what.',
      // Both learned the hard way: a lead tried Claude Code's own SendMessage to
      // reach "builder" (no such address), and another treated finish as a
      // locked door when the human brought back more work.
      'The assign tool is the ONLY way to reach your team — they are not addressable by any other messaging tool. If more work arrives after you called finish, just assign again: that reopens the team.',
    );
    if (team.lanes > 1)
      shared.push(
        `This team has ${team.lanes} LANES, so up to ${team.lanes} tasks run at once. Each lane is a separate git worktree with its own crew; assigning to a member works on that member's lane's task. Split big work with add_task, close each with finish_task (which merges its branch), and never ask one lane's crew about another lane's files.`,
      );
  }
  if (m.kind === 'worker' && m.writes) {
    shared.push(
      'You edit files. Work the assignment, run what you changed, then call report_result — a short summary naming the files, status done or blocked. Your turn is not finished until you call it.',
      'The lead has already read this project. Trust what it tells you and go straight to the files it names — re-surveying the repository from scratch is duplicated work you are being billed for. Read more only where its notes actually run out.',
      'Stay inside the assignment. Questions go in your report as blocked, not into guesswork.',
    );
  }
  if (m.kind === 'worker' && !m.writes) {
    shared.push(
      'You research; you CANNOT edit files, and the edit tools are not available to you. Read, search and run read-only commands, then call report_result with what you found — cite file:line, and never guess where you could look instead.',
      "Stay inside the assignment, and trust the lead's notes rather than re-surveying the whole repository.",
    );
  }
  if (m.kind === 'reviewer') {
    shared.push(
      "You review ONE CHANGE; you cannot edit files. Start from `git diff` (and `git status` for new files) — that, plus the lead's notes, is your scope.",
      'Do not audit the wider project, re-read files the change never touched, or re-derive what the lead already told you. Read a surrounding file only when the diff cannot be judged without it.',
      'RUN the tests or the build before any verdict. Then call give_verdict. Approve only what you verified yourself; requested changes must be concrete and cite file:line — a review without evidence is worthless. Your turn is not finished until you call it.',
    );
  }
  // Token saver. The bill is context size times turns, plus what gets written,
  // so this asks for less of all three. It is deliberately about HOW to work,
  // never about how much care to take: nothing here says to skip a test,
  // shorten a review, or accept less.
  if (team.thrift) {
    shared.push(
      'TOKEN SAVER is on for this team. Reach the same answer in fewer turns and fewer words.',
      'Search before you read: grep for what you need and read the range around it rather than opening whole files. Never re-read a file you have already seen, and never print a file back into the conversation.',
      'Write only what the next person needs. Reports, verdicts and assignments run to a few lines: what you did or found, which files, what is left. No preamble, no restating the assignment back, no narrating a plan before doing it.',
      'Do not create files nobody asked for — extra test files, notes, scratch scripts — unless the assignment asks for them.',
      'Economical, not hasty: run the tests exactly as you would otherwise and hold the same bar for correctness.',
    );
  }

  const lane = state.lanes.find((l) => l.n === m.lane);
  if (lane?.worktree)
    shared.push(
      `You work in LANE ${m.lane}: this folder is a git worktree of the project, on branch ${lane.worktree.branch}. Everything you do stays here — never touch another lane's folder, and never switch branches.`,
    );
  // The human's own standing instructions for this member go LAST, so they are
  // the most recent thing in the prompt and read as overriding the generic role
  // description above. They live here rather than in a message because a
  // message scrolls out of context; this holds for every turn, and survives the
  // team being given a new task.
  const note = team.roleNotes?.[m.rosterId]?.trim() ?? team.roleNotes?.[m.role]?.trim();
  if (note) shared.push('', `The human's standing instructions for you — these take precedence over the general guidance above:`, note);
  return shared.join('\n');
}

/**
 * What a crew is told while the lead reads the project.
 *
 * Deliberately forceful about waiting: these are hired before there is any
 * work for them, and an agent that "helpfully" starts early would edit files
 * nobody has agreed on yet.
 */
function standbyText(state: TeamState, m: Member, again = false): string {
  const lane = state.lanes.find((l) => l.n === m.lane);
  const task = lane?.taskId ? state.team.tasks.find((t) => t.id === lane.taskId) : undefined;
  return [
    '[airoom team — from airoom]',
    again
      ? 'Your lane has been given a NEW task. Anything from the last one is finished and closed. The new task:'
      : `You have joined a team as ${m.label.toUpperCase()}. The task in front of your lane:`,
    '',
    task?.brief ?? state.team.task,
    '',
    lane?.worktree
      ? `You are working in lane ${m.lane}: a git worktree on branch ${lane.worktree.branch}. Stay inside this folder.`
      : '',
    'The lead is reading the project now and will send you an assignment.',
    'DO NOT START YET. Do not read the codebase, do not run anything, and do not',
    'change any files. Reply with one short line confirming you are ready, then',
    'wait — your work arrives as a message from the lead.',
  ]
    .filter((l, i) => l !== '' || i < 4)
    .join('\n');
}

/** The brief for a one-lane team that already knows this project. */
function nextTaskText(state: TeamState, task: TeamTask): string {
  const { team } = state;
  return [
    '[airoom team — from the human]',
    'Your team has a new job on the board:',
    '',
    task.brief,
    '',
    'You already know this project — do not survey it again from scratch. Re-read',
    'only what this task actually touches, then assign as usual, and pass on what',
    'you know in the assignment context.',
    `Team policy is unchanged: autonomy "${team.autonomy}", fix-round cap ${team.roundCap} (reset for this task).`,
  ].join('\n');
}

/** The briefing for a lead that has to start a new conversation mid-flight:
 *  the task, the team, and — unlike the kickoff — that work may be under way. */
function rejoinText(state: TeamState): string {
  const { team } = state;
  const task =
    team.tasks.find((t) => t.state === 'working' || t.state === 'blocked') ?? team.tasks[team.tasks.length - 1];
  return [
    '[airoom team — from airoom]',
    'You are the LEAD of this team. Your earlier conversation could not be resumed, so here is your briefing again:',
    '',
    task?.brief ?? team.task,
    '',
    `Your team: ${state.members
      .filter((m) => m.kind !== 'lead')
      .map((m) => `"${m.role}" (${m.label})`)
      .join(', ')}.`,
    `Team policy (enforced by airoom, not by you): autonomy "${team.autonomy}", fix-round cap ${team.roundCap}${
      team.lanes > 1 ? `, ${team.lanes} parallel lanes` : ''
    }.`,
    'The work may already be under way. Call team_status FIRST to see the board and who owes what, then carry on from there.',
  ].join('\n');
}

function kickoffText(state: TeamState, task: TeamTask): string {
  const { team } = state;
  return [
    `[airoom team — from the human]`,
    `You are the lead. Staff and run this to completion:`,
    '',
    task.brief,
    '',
    `Your team: ${state.members
      .filter((m) => m.kind !== 'lead')
      .map((m) => `"${m.role}" (${m.label})`)
      .join(', ')}.`,
    `Team policy (enforced by airoom, not by you): autonomy "${team.autonomy}", fix-round cap ${team.roundCap}${
      team.lanes > 1 ? `, ${team.lanes} parallel lanes` : ''
    }.`,
    'Start by looking at the repository, then assign the work.',
  ].join('\n');
}
