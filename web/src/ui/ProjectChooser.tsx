import { useEffect, useMemo, useState } from 'react';
import { useFocusTrap } from './useFocusTrap';
import type { Room } from '@shared/types';

import { basename } from '../pathish';
import { thisMachine } from '../platform';
interface Props {
  /** Rooms currently on the floor (lanes excluded — they are not projects). */
  rooms: Room[];
  /** Paths the user has put away. Offered back, unticked. */
  hidden: string[];
  /** Display names the user gave rooms, by id. */
  names: Record<string, string>;
  /** First run: found-on-this-Mac wording, and Skip means "keep it all". */
  firstRun: boolean;
  /** The answer: exactly these paths are put away. */
  onDone: (hidden: string[]) => void;
  onClose: () => void;
}


/**
 * Which projects appear in the office.
 *
 * Every folder Claude Code has ever been run in becomes a room, which on a
 * machine with a few years of history is thirty rooms of experiments, clones
 * and forgotten scratch dirs before the first thing you actually work on. So
 * the first time airoom opens with rooms to show, it asks — once — and the
 * same card is one click away afterwards, which is also where a room you put
 * away comes back from.
 *
 * Everything found is ticked by default. Unticking hides; nothing on disk is
 * touched, ever.
 */
export function ProjectChooser({ rooms, hidden, names, firstRun, onDone, onClose }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>();
  const items = useMemo(() => {
    const seen = new Set<string>();
    const list: { id: string; name: string; path: string; count: number; away: boolean }[] = [];
    for (const r of rooms) {
      seen.add(r.id);
      list.push({ id: r.id, name: names[r.id] || r.name, path: r.path, count: r.robotCount, away: false });
    }
    for (const p of hidden) if (!seen.has(p)) list.push({ id: p, name: names[p] || basename(p), path: p, count: -1, away: true });
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [rooms, hidden, names]);

  const [on, setOn] = useState<Set<string>>(() => new Set(rooms.map((r) => r.id)));
  const toggle = (id: string) =>
    setOn((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const shown = items.filter((i) => on.has(i.id)).length;
  const found = items.length;

  return (
    <div className="connect chooser" ref={trapRef} role="dialog" aria-modal="true" aria-label="Which projects appear in airoom">
      <div className="connect__head">
        <span className="connect__title">
          {firstRun ? `Found ${found} ${found === 1 ? 'project' : 'projects'} on ${thisMachine}` : `Projects on ${thisMachine}`}
        </span>
        <button className="panel__close" onClick={onClose} aria-label={firstRun ? 'Keep them all' : 'Close'}>
          ×
        </button>
      </div>
      <p className="connect__body">
        Claude Code has been used in each of these folders. Tick the ones you want as rooms in airoom. The rest are
        put away, out of sight, and can come back from here any time — nothing on disk is touched.
      </p>

      <div className="chooser__list">
        {items.map((it) => {
          const checked = on.has(it.id);
          return (
            <button
              key={it.id}
              type="button"
              role="checkbox"
              aria-checked={checked}
              className={`chooser__row ${checked ? 'chooser__row--on' : 'chooser__row--off'}`}
              onClick={() => toggle(it.id)}
            >
              <span className="chooser__box" aria-hidden="true">
                {checked ? '✓' : ''}
              </span>
              <span className="chooser__main">
                <span className="chooser__name">{it.name}</span>
                <span className="chooser__path" title={it.path}>
                  {it.path}
                </span>
              </span>
              <span className="chooser__count">
                {it.away ? 'put away' : it.count === 0 ? 'no sessions' : `${it.count} ${it.count === 1 ? 'session' : 'sessions'}`}
              </span>
            </button>
          );
        })}
      </div>

      <div className="chooser__foot">
        <span className="chooser__bulk">
          <button type="button" onClick={() => setOn(new Set(items.map((i) => i.id)))}>
            all
          </button>
          ·
          <button type="button" onClick={() => setOn(new Set())}>
            none
          </button>
        </span>
        {firstRun && (
          <button type="button" className="chooser__skip" onClick={onClose} title="Every project found stays on the floor">
            Keep them all
          </button>
        )}
        <button
          className="connect__copy"
          disabled={shown === 0}
          title={shown === 0 ? 'An office needs at least one room' : undefined}
          onClick={() => onDone(items.filter((i) => !on.has(i.id)).map((i) => i.path))}
        >
          {shown === 0 ? 'Pick at least one' : `Show ${shown} ${shown === 1 ? 'room' : 'rooms'}`}
        </button>
      </div>
    </div>
  );
}
