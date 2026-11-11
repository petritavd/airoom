import { useEffect, useMemo, useRef, useState } from 'react';
import type { FleetSnapshot, Playbook } from '@shared/types';
import { basename } from '../pathish';
import { ago } from './Queue';

/** Where the project lives, for the two rows that leave the app. */
const REPO_URL = 'https://github.com/petritavd/airoom';
const SPONSOR_URL = 'https://github.com/sponsors/petritavd';

export interface PaletteRow {
  key: string;
  group: 'Needs you' | 'Actions' | 'Rooms' | 'Agents' | 'Teams' | 'Playbooks';
  label: string;
  hint?: string;
  tone?: 'warn' | 'ok' | 'err' | 'idle';
  keys?: string[];
  run: () => void;
}

/**
 * Jump to anything: ⌘K (Ctrl+K on Windows). Rooms, agents, teams and the
 * handful of actions worth a shortcut, with whatever needs you pinned to the
 * top. Typing filters; ↑ ↓ move; Enter runs; Esc closes. The office keeps its
 * arrow keys, but this is where the keyboard lives for everything else.
 */
export function Palette({ rows, onClose }: { rows: PaletteRow[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => `${r.label} ${r.hint ?? ''} ${r.group}`.toLowerCase().includes(needle));
  }, [rows, q]);

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    setCursor(0);
  }, [q]);
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('[data-on="1"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, shown]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(shown.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = shown[cursor];
      if (row) {
        onClose();
        row.run();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  // Rows come pre-grouped in display order; the subhead is printed when the
  // group changes, so a filtered list keeps only the groups it still has.
  let lastGroup: string | null = null;
  return (
    <>
      <div className="pal__scrim" onClick={onClose} />
      <div className="pal" role="dialog" aria-modal="true" aria-label="Jump to anything" onKeyDown={onKey}>
        <div className="pal__in">
          <span className="pal__glass" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={input}
            id="pal-q"
            className="pal__q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to a room, an agent, a team, or an action…"
            aria-label="Search"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="pal__list" ref={list}>
          {shown.length === 0 && <div className="pal__empty">Nothing matches “{q}”.</div>}
          {shown.map((row, i) => {
            const head = row.group !== lastGroup ? row.group : null;
            lastGroup = row.group;
            return (
              <div key={row.key}>
                {head && <div className="pal__sub">{head}</div>}
                <button
                  type="button"
                  className={`prow ${i === cursor ? 'prow--on' : ''}`}
                  data-on={i === cursor ? '1' : '0'}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => {
                    onClose();
                    row.run();
                  }}
                >
                  {row.tone && <span className={`prow__dot prow__dot--${row.tone}`} />}
                  <span className="prow__label">{row.label}</span>
                  {row.hint && <span className="prow__hint">{row.hint}</span>}
                  {row.keys && (
                    <span className="prow__keys">
                      {row.keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <div className="pal__foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </>
  );
}

/** The rows the app offers. Kept out of App.tsx so the list reads as one thing. */
export function paletteRows(args: {
  snapshot: FleetSnapshot;
  needs: { sessionId?: string; teamId?: string; title: string; project: string; since: string | null }[];
  focusMode: boolean;
  soundOn: boolean;
  isMac: boolean;
  openAgent: (sessionId: string) => void;
  openTeam: (teamId: string) => void;
  newTask: (roomId: string) => void;
  openQueue: () => void;
  openProjects: () => void;
  toggleFocus: () => void;
  toggleSound: () => void;
  playbooks?: Playbook[];
  openPlaybook?: (id: string | null) => void;
}): PaletteRow[] {
  const { snapshot, needs } = args;
  const mod = args.isMac ? '⌘' : 'Ctrl';
  const rows: PaletteRow[] = [];
  for (const n of needs) {
    rows.push({
      key: `needs:${n.sessionId ?? n.teamId}`,
      group: 'Needs you',
      label: n.title,
      hint: `${n.project}${n.since ? ` · waiting ${ago(n.since)}` : ''}`,
      tone: 'warn',
      run: () => (n.sessionId ? args.openAgent(n.sessionId) : n.teamId ? args.openTeam(n.teamId) : undefined),
    });
  }
  rows.push({ key: 'a:queue', group: 'Actions', label: 'Open the Needs-you list', keys: [mod, 'J'], run: args.openQueue });
  rows.push({ key: 'a:projects', group: 'Actions', label: 'Choose which projects appear', run: args.openProjects });
  rows.push({ key: 'a:focus', group: 'Actions', label: args.focusMode ? 'Focus mode off' : 'Focus mode on', hint: 'monochrome office, colour for the agents', run: args.toggleFocus });
  rows.push({ key: 'a:sound', group: 'Actions', label: args.soundOn ? 'Sound off' : 'Sound on', run: args.toggleSound });
  rows.push({
    key: 'a:issue',
    group: 'Actions',
    label: 'Report a problem',
    hint: 'opens the issue tracker on GitHub',
    run: () => window.open(`${REPO_URL}/issues/new`, '_blank', 'noopener'),
  });
  rows.push({
    key: 'a:sponsor',
    group: 'Actions',
    label: 'Sponsor airoom',
    hint: 'free and open source; if it earns its place',
    run: () => window.open(SPONSOR_URL, '_blank', 'noopener'),
  });
  if (args.openPlaybook) {
    const open = args.openPlaybook;
    rows.push({ key: 'a:playbooks', group: 'Actions', label: 'Open the playbooks', hint: 'tasks that worked once, written down', run: () => open(null) });
    for (const p of args.playbooks ?? []) {
      const waiting = p.runs.some((r) => r.state === 'waiting');
      rows.push({
        key: `pb:${p.id}`,
        group: 'Playbooks',
        label: `Run ${p.name}`,
        hint: `${basename(p.roomId)} · ${p.runs.length} ${p.runs.length === 1 ? 'run' : 'runs'}${waiting ? ' · needs you' : ''}`,
        tone: waiting ? 'warn' : 'idle',
        run: () => open(p.id),
      });
    }
  }
  const rooms = snapshot.rooms.filter((r) => !r.lane).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  for (const r of rooms) {
    rows.push({
      key: `room:${r.id}`,
      group: 'Rooms',
      label: `New task in ${r.name || basename(r.id)}`,
      hint: `${r.robotCount} ${r.robotCount === 1 ? 'agent' : 'agents'}${r.needsAttention ? ' · needs you' : ''}`,
      tone: r.needsAttention ? 'warn' : r.robotCount ? 'ok' : 'idle',
      run: () => args.newTask(r.id),
    });
  }
  for (const t of snapshot.teams) {
    if (t.state === 'done' || t.state === 'stopped') continue;
    rows.push({
      key: `team:${t.id}`,
      group: 'Teams',
      label: t.name || t.task.split('\n')[0].slice(0, 80),
      hint: `${basename(t.roomId)} · ${t.members.length} members · ${t.state.replace('_', ' ')}`,
      tone: t.state === 'awaiting_human' ? 'warn' : t.state === 'error' ? 'err' : 'ok',
      run: () => args.openTeam(t.id),
    });
  }
  for (const r of snapshot.robots) {
    rows.push({
      key: `agent:${r.sessionId}`,
      group: 'Agents',
      label: r.title,
      hint: `${basename(r.roomId)}${r.name ? ` · ${r.name}` : ''} · ${r.status.replace('_', ' ')}`,
      tone: r.status === 'error' ? 'err' : r.status === 'waiting_input' || r.needsApproval ? 'warn' : r.status === 'working' ? 'ok' : 'idle',
      run: () => args.openAgent(r.sessionId),
    });
  }
  return rows;
}
