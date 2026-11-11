import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from './useFocusTrap';
import type { AwayAgent, Handoff, Robot, Team, TeamMember, TeamTask } from '@shared/types';
import { Markdown } from './Markdown';
import { useAutoGrow } from './useAutoGrow';
import { thisMachine } from '../platform';

/**
 * The team panel: what the office animates, told as a record.
 *
 * The room shows that work is moving; this panel is where you see WHAT moved —
 * the board and the handoff timeline — and where the controls that belong to
 * the human live: Continue (release what the referee parked), Stop, adding and
 * cancelling tasks, and stepping into any member's own chat. It deliberately
 * has no composer: you talk to people, not to the team, and each member is an
 * ordinary robot one click away.
 */

const KIND_ICON: Record<Handoff['kind'], string> = {
  assign: '→',
  result: '✓',
  verdict: '§',
  question: '?',
  finish: '★',
  note: '·',
};

const STATE_LABEL: Record<Team['state'], string> = {
  working: 'working',
  awaiting_human: 'needs you',
  done: 'done',
  stopped: 'stopped',
  error: 'error',
};

const TASK_LABEL: Record<TeamTask['state'], string> = {
  queued: 'queued',
  working: 'in progress',
  blocked: 'needs you',
  done: 'closed',
  merged: 'merged',
  cancelled: 'cancelled',
};

function who(x: Handoff['from'] | Handoff['to'], members: TeamMember[]): string {
  if (x === 'human') return 'you';
  if (x === 'server') return 'airoom';
  return members.find((m) => m.role === x)?.label ?? x;
}

/**
 * Where a task stands with its reviewer, in one line. The wording tracks what
 * the server enforces: a fresh approval closes; anything else needs a verdict
 * or the human's say-so, and a task closed that way says so for good.
 */
function reviewOf(
  t: TeamTask,
  hasReviewer: boolean,
  members: TeamMember[],
): { text: string; tone: 'ok' | 'warn' | 'dim'; fresh: boolean } {
  if (t.waived) return { text: 'Closed without review, by you', tone: 'warn', fresh: false };
  const r = t.review;
  const closed = t.state === 'done' || t.state === 'merged';
  if (!r) {
    if (!hasReviewer) return { text: 'No reviewer on this crew', tone: 'dim', fresh: false };
    return { text: closed ? 'Never reviewed' : 'Not reviewed yet', tone: 'dim', fresh: false };
  }
  const by = who(r.by, members);
  if (r.verdict === 'request_changes') return { text: `${by} requested changes`, tone: 'warn', fresh: false };
  if (r.stale) return { text: `${by} approved, but the changes moved since — needs a fresh verdict`, tone: 'warn', fresh: false };
  return { text: `Approved by ${by}`, tone: 'ok', fresh: true };
}

function clock(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function TeamPanel({
  team,
  log,
  robots,
  away,
  onBringBack,
  onOpenMember,
  onContinue,
  onStop,
  onNewTask,
  onRename,
  onCancelTask,
  onMergeTask,
  onCloseTask,
  onDismiss,
  onClose,
  onSubscribe,
  docked = false,
}: {
  team: Team;
  log: Handoff[];
  robots: Robot[];
  /** Sessions put away from the office — a member may be one of them. */
  away: AwayAgent[];
  onBringBack: (sessionId: string) => void;
  onOpenMember: (sessionId: string) => void;
  onContinue: () => void;
  onStop: () => void;
  onNewTask: (task: string) => void;
  /** Rename the team; '' goes back to calling it by its job. */
  onRename: (name: string) => void;
  onCancelTask: (taskId: string) => void;
  onMergeTask: (taskId: string) => void;
  onCloseTask: (taskId: string) => void;
  onDismiss: () => void;
  onClose: () => void;
  onSubscribe: () => void;
  /** Rendered inside the dock beside the office: no focus trap, not modal. */
  docked?: boolean;
}) {
  const trapRef = useFocusTrap<HTMLElement>(!docked);
  // The live feed only carries handoffs broadcast while this client was
  // connected; ask once for the full story.
  useEffect(() => {
    onSubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.id]);

  const active = team.state === 'working' || team.state === 'awaiting_human';
  // The title is the team's name, or its job until it has one. Click to rename,
  // the way an agent is renamed in its own header.
  const [editingName, setEditingName] = useState(false);
  const named = !!team.name?.trim();
  const [next, setNext] = useState('');
  // The job's short title — what the board calls it — never the brief itself.
  // The brief can be a whole ticket; as a headline it filled the panel.
  const current =
    (team.tasks ?? []).find((t) => t.state === 'working' || t.state === 'blocked') ??
    (team.tasks ?? []).find((t) => t.state === 'queued') ??
    (team.tasks ?? [])[(team.tasks ?? []).length - 1];
  const jobTitle = current?.title ?? team.task.split('\n')[0].trim().slice(0, 60);
  const nextRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(nextRef, next);
  const byId = new Map(robots.map((r) => [r.sessionId, r]));
  const tasks = team.tasks ?? [];
  const open = tasks.filter((t) => t.state !== 'merged' && t.state !== 'cancelled');
  const closed = tasks.filter((t) => t.state === 'merged' || t.state === 'cancelled');
  const lanes = Math.max(1, team.lanes ?? 1);
  const hasReviewer = team.members.some((m) => m.kind === 'reviewer');

  const submitTask = () => {
    if (next.trim().length < 4) return;
    onNewTask(next.trim());
    setNext('');
  };

  /** One member button — the way into that agent's own chat. A member whose
   *  session was put away comes back on click; one whose transcript is gone
   *  says so, instead of closing the panel onto an empty office. */
  const live = team.state !== 'done' && team.state !== 'stopped' && team.state !== 'error';
  const memberButton = (m: TeamMember) => {
    const robot = m.sessionId ? byId.get(m.sessionId) : undefined;
    const parked = !robot && m.sessionId ? away.find((a) => a.sessionId === m.sessionId) : undefined;
    const starting = !robot && !parked && !!m.sessionId && live;
    const gone = !robot && !parked && !!m.sessionId && !live;
    const title = !m.sessionId || starting
      ? 'Starting up — its session appears in a moment'
      : robot
        ? 'Open this member’s chat'
        : parked
          ? 'Put away — click to bring it back into the office and open it'
          : `Its transcript is no longer on ${thisMachine}, so there is nothing to open`;
    return (
      <button
        key={m.role}
        className={`tp__member tp__role--${m.kind} ${gone ? 'tp__member--gone' : ''}`}
        disabled={!robot && !parked}
        onClick={() => {
          if (!m.sessionId) return;
          if (parked) onBringBack(m.sessionId);
          onOpenMember(m.sessionId);
        }}
        title={title}
      >
        <span className="tp__role">{m.label}</span>
        <span className="tp__memberState">
          {robot ? robot.currentAction || robot.status : parked ? 'put away' : gone ? `not on ${thisMachine}` : m.sessionId ? '…' : 'not hired yet'}
        </span>
      </button>
    );
  };

  return (
    <aside className="tp" ref={trapRef} role={docked ? 'region' : 'dialog'} aria-modal={docked ? undefined : 'true'} aria-label="Team">
      <header className="tp__head">
        <div className="tp__title">
          <span className={`tp__state tp__state--${team.state}`}>{STATE_LABEL[team.state]}</span>
          {editingName ? (
            <input
              className="tp__nameIn"
              defaultValue={team.name ?? ''}
              placeholder="Name this team"
              maxLength={40}
              autoFocus
              aria-label="Team name"
              onKeyDown={(e) => {
                e.stopPropagation(); // Escape here means "stop renaming", not "close the panel"
                if (e.key === 'Enter') {
                  onRename(e.currentTarget.value.trim());
                  setEditingName(false);
                } else if (e.key === 'Escape') setEditingName(false);
              }}
              onBlur={(e) => {
                onRename(e.currentTarget.value.trim());
                setEditingName(false);
              }}
            />
          ) : (
            <h2 className="tp__task" title={named ? 'Rename this team' : 'Name this team'}>
              <button type="button" className="tp__name" onClick={() => setEditingName(true)}>
                {named ? team.name : jobTitle}
              </button>
            </h2>
          )}
          {named && (
            <div className="tp__sub" title={jobTitle}>
              {jobTitle}
            </div>
          )}
        </div>
        <button className="tp__x" onClick={onClose} aria-label="Close team panel">
          ✕
        </button>
      </header>

      {/* Everything between the header and the footer scrolls as one: a long
          summary used to push the log — and itself — past the panel's edge,
          with nothing to scroll. */}
      <div className="tp__body">
        <div className="tp__meters">
          <span className="tp__meter" title="Autonomy — fixed when the team was hired">
            {team.autonomy === 'gated'
              ? 'step by step'
              : team.autonomy === 'auto'
                ? 'until approved'
                : `capped · ${team.roundsUsed}/${team.roundCap} fix rounds`}
          </span>
          {lanes > 1 && (
            <span className="tp__meter" title="Tasks this team can work at once, each in its own git worktree">
              {lanes} lanes
            </span>
          )}
          <span className="tp__meter" title="Total spend across every member's turns, all tasks">
            ${team.costUsd.toFixed(2)}
          </span>
          {team.tasksDone > 0 && (
            <span className="tp__meter" title="Tasks this team has closed">
              {team.tasksDone} done
            </span>
          )}
        </div>

        {/* The board. One row per job: where it is, who holds it, what it left
            behind. This is the thing you scan when you come back to the desk. */}
        <div className="tp__board">
          {open.map((t) => {
            const holder = t.awaitingFrom ? team.members.find((m) => m.role === t.awaitingFrom) : undefined;
            const review = reviewOf(t, hasReviewer, team.members);
            return (
              <details key={t.id} className={`tp__job tp__job--${t.state}`}>
                <summary>
                  <span className={`tp__jobDot tp__jobDot--${t.state}`} aria-hidden="true" />
                  <span className="tp__jobTitle">{t.title}</span>
                  {t.lane !== null && lanes > 1 && <span className="tp__jobLane">lane {t.lane}</span>}
                  <span className="tp__jobState">{TASK_LABEL[t.state]}</span>
                </summary>
                <div className="tp__jobBody">
                  {holder && <p className="tp__jobLine">Waiting on {holder.label}.</p>}
                  {t.branch && <p className="tp__jobLine tp__jobBranch">{t.branch}</p>}
                  {t.note && <p className="tp__jobLine tp__jobNote">{t.note}</p>}
                  {t.state !== 'queued' && (
                    <p className={`tp__jobLine tp__jobReview tp__jobReview--${review.tone}`}>{review.text}</p>
                  )}
                  <pre className="tp__jobBrief">{t.brief}</pre>
                  <div className="tp__jobActions">
                    {t.branch && t.state === 'blocked' && (
                      <button className="tp__jobBtn" onClick={() => onMergeTask(t.id)}>
                        Try the merge again
                      </button>
                    )}
                    {hasReviewer && t.state !== 'queued' && !review.fresh && (
                      <button
                        className="tp__jobBtn"
                        title="The lead cannot close this without an approval. You can."
                        onClick={() => onCloseTask(t.id)}
                      >
                        {t.branch ? 'Close and merge without review' : 'Close without review'}
                      </button>
                    )}
                    <button className="tp__jobBtn tp__jobBtn--drop" onClick={() => onCancelTask(t.id)}>
                      Cancel this task
                    </button>
                  </div>
                </div>
              </details>
            );
          })}
          {closed.length > 0 && (
            <details className="tp__closed">
              <summary>
                {closed.length} closed {closed.length === 1 ? 'task' : 'tasks'}
              </summary>
              {closed.map((t) => {
                const review = reviewOf(t, hasReviewer, team.members);
                return (
                  <div key={t.id} className="tp__closedRow">
                    <span className={`tp__jobDot tp__jobDot--${t.state}`} aria-hidden="true" />
                    <span className="tp__jobTitle">{t.title}</span>
                    <span className={`tp__jobReview tp__jobReview--${review.tone}`}>{review.text}</span>
                    <span className="tp__jobState">{TASK_LABEL[t.state]}</span>
                  </div>
                );
              })}
            </details>
          )}
        </div>

        {/* The bench. Split by lane once there is more than one, because a flat
            list of "Builder, Builder · lane 2" tells you nothing about who is
            working on what. */}
        {lanes > 1 ? (
          <div className="tp__crews">
            {[0, ...Array.from({ length: lanes }, (_, i) => i + 1)].map((lane) => {
              const crew = team.members.filter((m) => (m.lane ?? 0) === lane);
              if (!crew.length) return null;
              const task = tasks.find((t) => t.lane === lane && (t.state === 'working' || t.state === 'blocked'));
              return (
                <div key={lane} className="tp__crew">
                  <div className="tp__crewHead">
                    {lane === 0 ? 'Orchestration' : `Lane ${lane}`}
                    {task && <span className="tp__crewTask">{task.title}</span>}
                  </div>
                  <div className="tp__members">{crew.map(memberButton)}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="tp__members">{team.members.map(memberButton)}</div>
        )}

        {team.state === 'awaiting_human' && (
          <div className="tp__parked">
            <Markdown text={team.parkedReason ?? 'The team is waiting on you.'} />
            <button className="tp__continue" onClick={onContinue}>
              Continue
            </button>
          </div>
        )}
        {team.state === 'done' && team.doneSummary && (
          <div className="tp__done">
            <Markdown text={team.doneSummary} />
          </div>
        )}

        {/* A team is a standing thing, not a one-shot: give it the next job
            here, whether it is idle or already busy. Sessions that already know
            this project are much cheaper than hiring afresh. */}
        <form
          className="tp__next"
          onSubmit={(e) => {
            e.preventDefault();
            submitTask();
          }}
        >
          <label className="tp__nextLabel" htmlFor="tp-next">
            {team.state === 'stopped' ? 'Give them something else' : 'Add a task'}
          </label>
          <textarea
            id="tp-next"
            ref={nextRef}
            className="tp__nextTask"
            rows={3}
            placeholder="They already know this project — just say what you want next."
            value={next}
            maxLength={500_000}
            onChange={(e) => setNext(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitTask();
              }
            }}
          />
          <button className="tp__nextGo" type="submit" disabled={next.trim().length < 4}>
            {lanes > 1 ? 'Put it on the board' : 'Give them this task'}
          </button>
          {lanes > 1 && active && (
            <p className="tp__nextHint">
              It starts straight away if a lane is free, otherwise it waits for one.
            </p>
          )}
        </form>

        <div className="tp__log">
          {[...log].reverse().map((h) => (
            <details key={h.id} className={`tp__h tp__h--${h.kind}`}>
              <summary>
                <span className="tp__hIcon" aria-hidden="true">
                  {KIND_ICON[h.kind]}
                </span>
                <span className="tp__hWho">
                  {who(h.from, team.members)} → {who(h.to, team.members)}
                </span>
                <span className="tp__hSum">{h.summary}</span>
                <span className="tp__hTs">{clock(h.ts)}</span>
              </summary>
              {h.detail && h.detail !== h.summary && <pre className="tp__hDetail">{h.detail}</pre>}
            </details>
          ))}
          {log.length === 0 && <div className="tp__empty">No handoffs yet — the lead is reading the repository.</div>}
        </div>
      </div>

      <footer className="tp__foot">
        {active ? (
          <button className="tp__stop" onClick={onStop}>
            Stop team
          </button>
        ) : (
          <button
            className="tp__stop"
            onClick={onDismiss}
            title={
              team.worktrees
                ? 'Removes the team and its lane folders; unmerged branches are kept'
                : 'Remove the team; its sessions stay as ordinary robots'
            }
          >
            Dismiss team
          </button>
        )}
      </footer>
    </aside>
  );
}
