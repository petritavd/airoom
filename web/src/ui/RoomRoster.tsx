import { useEffect, useState } from 'react';
import { useFocusTrap } from './useFocusTrap';
import type { AwayAgent, Robot, RobotStatus } from '@shared/types';
import { STATUS_COLOR } from '../render/draw';

interface Props {
  roomName: string;
  robots: Robot[];
  /** Agents let go from THIS room — offered back at the bottom of the list. */
  away: AwayAgent[];
  onOpen: (robot: Robot) => void;
  onLetGo: (sessionId: string) => void;
  onBringBack: (sessionId: string) => void;
  onClose: () => void;
}

const STATE_LABEL: Record<RobotStatus, string> = {
  working: 'working',
  waiting_input: 'your move',
  idle: 'idle',
  error: 'error',
  done: 'done',
};

function relTime(iso: string | null): string {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(s)) return '';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/**
 * Every session in a room, including the ones with no desk.
 *
 * A room only has six desks, so a busy project hides the rest behind a "+N"
 * badge — and a robot without a desk cannot be clicked. This is how those
 * sessions stay reachable: the same order the desks are handed out in, so
 * anything waiting on you is at the top.
 */
export function RoomRoster({ roomName, robots, away, onOpen, onLetGo, onBringBack, onClose }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>();
  // Confirm inline, per row: this list is where you tidy up, and a stray click
  // in a tidying mood should not silently empty a desk.
  const [confirming, setConfirming] = useState<string | null>(null);
  const rank = (r: Robot) =>
    r.needsApproval || r.status === 'waiting_input' || r.status === 'error' ? 0 : r.status === 'working' ? 1 : 2;
  const ordered = [...robots].sort(
    (a, b) => rank(a) - rank(b) || (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''),
  );

  // Escape closes the list from anywhere in it, like every other dialog here.
  // A pending "let go?" is cancelled first — the same key should not confirm
  // by accident what it was meant to back out of.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (confirming) setConfirming(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirming, onClose]);

  return (
    <div className="connect roster" ref={trapRef} role="dialog" aria-modal="true" aria-label={`${roomName} sessions`}>
      <div className="connect__head">
        <span className="connect__title">{roomName} — {robots.length} sessions</span>
        <button className="panel__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {/* One scroll region for the whole list, under a head that stays put.
          The live rows used to scroll on their own while the let-go section
          stacked below them, so a room with many agents let go grew the card
          straight off the bottom of the window with no way to reach them. */}
      <div className="roster__body">
      <div className="roster__list">
        {ordered.map((r) => (
          <div key={r.sessionId} className="roster__rowWrap">
            <button className="roster__row" onClick={() => onOpen(r)}>
              <span className="roster__led" style={{ background: STATUS_COLOR[r.status] }} />
              <span className="roster__main">
                <span className="roster__title">{r.title}</span>
                <span className="roster__sub">
                  {STATE_LABEL[r.status]}
                  {r.needsApproval ? ' · needs approval' : ''} · {r.messageCount} turns ·{' '}
                  {relTime(r.lastActivity)}
                </span>
              </span>
            </button>
            {confirming === r.sessionId ? (
              <span className="roster__confirm">
                <button className="roster__no" onClick={() => setConfirming(null)}>
                  cancel
                </button>
                <button
                  className="roster__yes"
                  onClick={() => {
                    setConfirming(null);
                    onLetGo(r.sessionId);
                  }}
                >
                  let go
                </button>
              </span>
            ) : (
              <button
                className="roster__act"
                onClick={() => setConfirming(r.sessionId)}
                title="Let this agent go — frees the desk, keeps the conversation"
                aria-label={`Let ${r.title} go`}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      {away.length > 0 && (
        <div className="roster__away">
          <div className="roster__awayHead">{away.length} let go — still on disk</div>
          {away.map((a) => (
            <div key={a.sessionId} className="roster__rowWrap">
              <span className="roster__row roster__row--away">
                <span className="roster__main">
                  <span className="roster__title">{a.title}</span>
                  <span className="roster__sub">
                    {a.messageCount} turns · {relTime(a.lastActivity)}
                  </span>
                </span>
              </span>
              <button className="roster__back" onClick={() => onBringBack(a.sessionId)}>
                bring back
              </button>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
