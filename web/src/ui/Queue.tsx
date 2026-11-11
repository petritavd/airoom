import { useMemo } from 'react';
import type { FleetSnapshot, Robot } from '@shared/types';
import type { RunState } from '../net/useFleet';
import { basename } from '../pathish';

export type QueueKind = 'needs' | 'working' | 'blocked' | 'done';

export const QUEUE_TITLES: Record<QueueKind, string> = {
  needs: 'Needs you',
  working: 'Working',
  blocked: 'Blocked',
  done: 'Finished',
};

type Tone = 'warn' | 'ok' | 'err' | 'idle';

interface Row {
  key: string;
  tone: Tone;
  project: string;
  title: string;
  why: string;
  /** what the "why" quotes, shown in a code chip when present */
  code?: string;
  since: string | null;
  /** How this row is resolved. A permission carries its own Allow/Deny; the
   *  rest open something. */
  action:
    | { kind: 'permission'; runKey: string; requestId: string; sessionId: string }
    | { kind: 'open'; sessionId: string }
    | { kind: 'team'; teamId: string }
    | { kind: 'merge'; teamId: string; taskId: string };
}

/** "4 min", "1 h 12 min", "3 d" — the age of a wait, coarse on purpose. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d`;
}

/**
 * The lists behind the strip's buttons. Every row says which project, what the
 * task is, why it is in this list and how long it has been there, and carries
 * the one action that resolves it. "Needs you" is the list the app exists for:
 * robots waiting on an answer or an approval, and teams parked on a decision.
 */
export function Queue({
  kind,
  snapshot,
  runs,
  onOpen,
  onOpenTeam,
  onPermission,
  onMergeTask,
  onClose,
}: {
  kind: QueueKind;
  snapshot: FleetSnapshot;
  runs: Record<string, RunState>;
  onOpen: (sessionId: string) => void;
  onOpenTeam: (teamId: string) => void;
  onPermission: (runKey: string, requestId: string, allow: boolean) => void;
  onMergeTask: (teamId: string, taskId: string) => void;
  onClose: () => void;
}) {
  const roomName = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of snapshot.rooms) m.set(r.id, r.lane ? `${basename(r.lane.homeRoomId)} · lane ${r.lane.lane}` : r.name || basename(r.id));
    return (id: string) => m.get(id) ?? basename(id);
  }, [snapshot.rooms]);

  const pendingFor = (r: Robot) => {
    for (const run of Object.values(runs)) {
      if (run.sessionId === r.sessionId && run.pendingPermission) return { runKey: run.runKey, ...run.pendingPermission };
    }
    return null;
  };

  const { rows, review } = useMemo(() => {
    const now = Date.now();
    const rows: Row[] = [];
    const review: Row[] = [];
    const robots = snapshot.robots.filter((r) => {
      if (kind === 'needs') return r.status === 'waiting_input' || !!r.needsApproval;
      if (kind === 'blocked') return r.status === 'error';
      if (kind === 'working') return r.status === 'working' && !r.needsApproval;
      return r.status === 'done';
    });
    for (const r of robots) {
      const pending = pendingFor(r);
      let why = r.currentAction || '';
      let code: string | undefined;
      let action: Row['action'] = { kind: 'open', sessionId: r.sessionId };
      if (pending) {
        why = 'wants to run';
        code = pending.label;
        action = { kind: 'permission', runKey: pending.runKey, requestId: pending.requestId, sessionId: r.sessionId };
      } else if (r.needsApproval) {
        why = r.pendingTool ? `waiting for approval to use ${r.pendingTool}` : 'waiting for approval';
      } else if (r.status === 'waiting_input') {
        why = r.currentAction && r.currentAction !== 'Idle' ? r.currentAction : 'finished a turn and is waiting for you';
      } else if (r.status === 'error') {
        why = r.currentAction ? `stopped: ${r.currentAction}` : 'the run stopped';
      } else if (r.status === 'done') {
        why = r.currentAction || 'done';
      }
      rows.push({
        key: r.sessionId,
        tone: r.status === 'error' ? 'err' : r.status === 'working' || r.status === 'done' ? 'ok' : 'warn',
        project: roomName(r.roomId),
        title: r.title,
        why,
        code,
        since: r.lastActivity,
        action,
      });
    }
    if (kind === 'needs') {
      for (const t of snapshot.teams) {
        if (t.state !== 'awaiting_human') continue;
        rows.push({
          key: `team:${t.id}`,
          tone: 'warn',
          project: `${roomName(t.roomId)} · team`,
          title: t.name || t.task.split('\n')[0].slice(0, 80),
          why: t.parkedReason || 'the team is waiting on you',
          since: t.updatedAt,
          action: { kind: 'team', teamId: t.id },
        });
      }
      for (const t of snapshot.teams) {
        for (const task of t.tasks) {
          if (task.state !== 'done') continue;
          review.push({
            key: `task:${t.id}:${task.id}`,
            tone: 'ok',
            project: `${roomName(t.roomId)} · team`,
            title: task.title,
            why: task.summary || task.note || 'reviewed and ready to merge',
            since: t.updatedAt,
            action: { kind: 'merge', teamId: t.id, taskId: task.id },
          });
        }
      }
    }
    // Longest wait first: the person who has waited most is the person to serve.
    const age = (x: Row) => (x.since ? Date.parse(x.since) : now);
    rows.sort((a, b) => age(a) - age(b));
    return { rows, review };
  }, [kind, snapshot, runs, roomName]);

  const tone: Tone = kind === 'needs' ? 'warn' : kind === 'blocked' ? 'err' : 'ok';
  const first = rows[0];
  const play = () => {
    if (!first) return;
    if (first.action.kind === 'team') onOpenTeam(first.action.teamId);
    else if (first.action.kind === 'merge') onOpenTeam(first.action.teamId);
    else onOpen(first.action.sessionId);
  };

  const render = (row: Row) => (
    <div className="qrow" key={row.key}>
      <span className={`qrow__dot qrow__dot--${row.tone}`} />
      <div className="qrow__top">
        <span className="qrow__proj">{row.project}</span>
        <span className="qrow__age">{ago(row.since)}</span>
      </div>
      <button
        className="qrow__title"
        onClick={() => {
          if (row.action.kind === 'team' || row.action.kind === 'merge') onOpenTeam(row.action.teamId);
          else onOpen(row.action.sessionId);
        }}
      >
        {row.title}
      </button>
      <div className="qrow__why">
        {row.why}
        {row.code ? (
          <>
            {' '}
            <code>{row.code}</code>
          </>
        ) : null}
      </div>
      <div className="qrow__act">
        {row.action.kind === 'permission' && (
          <>
            <button className="qa qa--ok" onClick={() => row.action.kind === 'permission' && onPermission(row.action.runKey, row.action.requestId, true)}>
              Allow
            </button>
            <button className="qa" onClick={() => row.action.kind === 'permission' && onPermission(row.action.runKey, row.action.requestId, false)}>
              Deny
            </button>
            <button className="qa" onClick={() => onOpen(row.action.kind === 'permission' ? row.action.sessionId : '')}>
              Open
            </button>
          </>
        )}
        {row.action.kind === 'open' && (
          <button className="qa qa--accent" onClick={() => row.action.kind === 'open' && onOpen(row.action.sessionId)}>
            {kind === 'needs' ? 'Answer' : 'Open'}
          </button>
        )}
        {row.action.kind === 'team' && (
          <button className="qa qa--accent" onClick={() => row.action.kind === 'team' && onOpenTeam(row.action.teamId)}>
            Open team
          </button>
        )}
        {row.action.kind === 'merge' && (
          <>
            <button className="qa qa--accent" onClick={() => row.action.kind === 'merge' && onMergeTask(row.action.teamId, row.action.taskId)}>
              Merge
            </button>
            <button className="qa" onClick={() => row.action.kind === 'merge' && onOpenTeam(row.action.teamId)}>
              Open team
            </button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <section className="qp" aria-label={QUEUE_TITLES[kind]}>
      <div className="qp__head">
        <span className="qp__title">{QUEUE_TITLES[kind]}</span>
        <span className={`qp__count qp__count--${tone}`}>{rows.length}</span>
        <div className="qp__right">
          {kind === 'needs' && rows.length > 0 && (
            <button className="qa qa--accent" onClick={play} title="Open the item that has waited longest">
              ▶ Play queue
            </button>
          )}
          <button className="panel__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
      </div>
      <div className="qp__list">
        {rows.length === 0 && (
          <div className="qp__empty">
            {kind === 'needs' && 'Nothing needs you. Every agent is working, idle or done.'}
            {kind === 'working' && 'No agent is working right now.'}
            {kind === 'blocked' && 'Nothing is blocked.'}
            {kind === 'done' && 'Nothing has finished recently.'}
          </div>
        )}
        {rows.map(render)}
        {review.length > 0 && (
          <>
            <div className="qp__sub">Ready to merge · {review.length}</div>
            {review.map(render)}
          </>
        )}
      </div>
    </section>
  );
}
