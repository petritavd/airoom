import { useEffect, useMemo, useState } from 'react';
import type { Connector, RoomConnectors } from '@shared/types';
import { useFocusTrap } from './useFocusTrap';
import { ago } from './Queue';

/**
 * The Connections sheet: what this room's agents can reach, and whether it
 * is up. The wall shows presence and health at a glance; this is where the
 * detail lives — the tools behind each connector, what to do when one needs
 * signing in, and the two things the office can change: a project connector
 * on or off for this room, and adding or removing one in the project's own
 * .mcp.json. User-wide connectors are shown, not edited: they belong to
 * every room, and `claude mcp` is the place for them.
 */

const STATUS_LABEL: Record<Connector['status'], string> = {
  connected: 'connected',
  failed: 'down',
  'needs-auth': 'needs sign-in',
  pending: 'connecting',
  disabled: 'off',
};

const SCOPE_LABEL: Record<Connector['scope'], string> = {
  project: 'this project',
  local: 'this project · only you',
  user: 'every room',
  claudeai: 'claude.ai',
  plugin: 'plugin',
  managed: 'managed by your org',
  unknown: '',
};

const TRANSPORT_LABEL: Record<Connector['transport'], string> = {
  stdio: 'local process',
  http: 'http',
  sse: 'sse',
  claudeai: 'claude.ai connector',
  unknown: '',
};

function Row({
  c,
  roomShort,
  onToggle,
  onLoaded,
  onRemove,
}: {
  c: Connector;
  roomShort: string;
  /** the per-room switch: project approval, or on/off the wall for a shared one */
  onToggle?: (enabled: boolean) => void;
  /** shared only: stop or resume Claude Code loading it for this project */
  onLoaded?: (loaded: boolean) => void;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ro = c.tools.filter((t) => t.readOnly).length;
  const danger = c.tools.filter((t) => t.destructive).length;
  return (
    <div className={`cn__row cn__row--${c.status}`}>
      <div className="cn__main">
        <span className={`cn__led cn__led--${c.status}`} aria-hidden="true" />
        <button className="cn__name" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={c.target}>
          {c.name}
          <span className="cn__caret">{open ? '▾' : '▸'}</span>
        </button>
        <span className={`cn__status cn__status--${c.status}`}>{STATUS_LABEL[c.status]}</span>
        <span className="cn__meta">
          {[c.tools.length ? `${c.tools.length} ${c.tools.length === 1 ? 'tool' : 'tools'}` : '', TRANSPORT_LABEL[c.transport], c.scope === 'local' ? 'local scope' : '']
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className="cn__gap" />
        {onToggle && (
          <label className="cn__switch" title={c.onWall ? `Turn off for ${roomShort}` : `Turn on for ${roomShort}`}>
            <input type="checkbox" checked={c.onWall} onChange={(e) => onToggle(e.target.checked)} />
            <span className={`cn__sw ${c.onWall ? 'cn__sw--on' : ''}`} />
          </label>
        )}
      </div>
      {onLoaded && !c.onWall && c.loaded && (
        <div className="cn__fix">
          Off the wall here, but Claude Code still loads it for this project.{' '}
          <button className="cn__link cn__link--danger cn__loadedLink" onClick={() => onLoaded(false)}>
            Disable it for {roomShort}
          </button>
        </div>
      )}
      {onLoaded && !c.loaded && (
        <div className="cn__fix">
          Disabled for this project in Claude Code — agents here do not get it.{' '}
          <button className="cn__link cn__loadedLink" onClick={() => onLoaded(true)}>
            Load it again
          </button>
        </div>
      )}
      {c.error && <div className={`cn__err ${c.status === 'disabled' ? 'cn__err--soft' : ''}`}>{c.error}</div>}
      {c.status === 'needs-auth' && (
        <div className="cn__fix">
          Sign in from a terminal in this folder: run <code>claude</code>, then <code>/mcp</code>, pick <b>{c.name}</b>. airoom cannot open the sign-in for you.
        </div>
      )}
      {open && (
        <div className="cn__detail">
          {c.target && <div className="cn__target">{c.target}</div>}
          {c.tools.length > 0 ? (
            <>
              <div className="cn__toolsHead">
                Tools{ro ? ` · ${ro} read-only` : ''}
                {danger ? ` · ${danger} destructive` : ''}
              </div>
              <ul className="cn__tools">
                {c.tools.map((t) => (
                  <li key={t.name} className="cn__tool" title={t.description}>
                    <code>{t.name}</code>
                    {t.readOnly && <span className="cn__tag cn__tag--ro">read-only</span>}
                    {t.destructive && <span className="cn__tag cn__tag--danger">destructive</span>}
                    {t.description && <span className="cn__toolDesc">{t.description}</span>}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="cn__toolsHead">{c.status === 'connected' ? 'No tools reported.' : 'Tools appear once it connects.'}</div>
          )}
          {onRemove && (
            <div className="cn__rowActions">
              {!confirm ? (
                <button className="cn__link cn__link--danger" onClick={() => setConfirm(true)}>
                  Remove from this project
                </button>
              ) : (
                <>
                  <span className="cn__confirmText">Removes it from the project’s .mcp.json.</span>
                  <button className="cn__link" onClick={() => setConfirm(false)}>
                    Keep
                  </button>
                  <button className="cn__link cn__link--danger" onClick={onRemove}>
                    Remove
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Connectors({
  roomName,
  roomShort,
  room,
  onRefresh,
  onToggle,
  onLoaded,
  onAdd,
  onRemove,
  onClose,
}: {
  roomName: string;
  /** the folder's own name, for sentences */
  roomShort: string;
  room: RoomConnectors | null;
  onRefresh: () => void;
  onToggle: (name: string, enabled: boolean) => void;
  onLoaded: (name: string, loaded: boolean) => void;
  onAdd: (opts: { name: string; transport: 'stdio' | 'http' | 'sse'; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string> }) => void;
  onRemove: (name: string) => void;
  onClose: () => void;
}) {
  const trapRef = useFocusTrap<HTMLDivElement>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const list = room?.connectors ?? [];
  const mine = useMemo(() => list.filter((c) => c.scope === 'project' || c.scope === 'local'), [list]);
  const shared = useMemo(() => list.filter((c) => c.scope !== 'project' && c.scope !== 'local'), [list]);

  // ---- add form ----
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [envText, setEnvText] = useState('');
  const parseKv = (text: string): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Za-z_][\w-]*)\s*[=:]\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim();
    }
    return Object.keys(out).length ? out : undefined;
  };
  const ready = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name.trim()) && (transport === 'stdio' ? command.trim().length > 0 : /^https?:\/\//.test(url.trim()));
  const submit = () => {
    if (!ready) return;
    if (transport === 'stdio') {
      // "npx -y @scope/server --flag" → command + args, the way .mcp.json wants it
      const parts = command.trim().split(/\s+/);
      onAdd({ name: name.trim(), transport, command: parts[0], args: parts.slice(1), env: parseKv(envText) });
    } else onAdd({ name: name.trim(), transport, url: url.trim(), headers: parseKv(envText) });
    setAdding(false);
    setName('');
    setCommand('');
    setUrl('');
    setEnvText('');
  };

  const up = list.filter((c) => c.status === 'connected').length;
  return (
    <div className="cn" ref={trapRef} role="dialog" aria-modal="true" aria-label={`${roomName} connections`}>
      <header className="cn__head">
        <div>
          <h2 className="cn__title">Connections</h2>
          <div className="cn__sub">
            {roomName} · {list.length ? `${up} of ${list.length} connected` : room?.checking ? 'checking…' : 'none found'}
            {room?.checkedAt ? ` · checked ${ago(room.checkedAt)} ago` : ''}
          </div>
        </div>
        <button className="cn__refresh" onClick={onRefresh} disabled={!!room?.checking} title="Ask the runtime again">
          {room?.checking ? 'checking…' : 'refresh'}
        </button>
        <button className="panel__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="cn__body">
        {room?.error && <div className="cn__err">{room.error}</div>}
        {!room?.checkedAt && room?.checking && <div className="cn__empty">Starting a runtime in this folder to see what it connects to. A couple of seconds.</div>}

        <div className="cn__group">
          <div className="cn__groupHead">
            In {roomShort}
            <span className="cn__groupHint">from the project’s .mcp.json — on or off per room</span>
          </div>
          {mine.length === 0 && room?.checkedAt && <div className="cn__empty">No project connectors. Add one below, or put a .mcp.json in the folder.</div>}
          {mine.map((c) => (
            // Only .mcp.json servers have a per-room switch Claude Code
            // understands; a local-scope one was added with `claude mcp add`
            // for this folder and is managed there.
            <Row
              key={c.name}
              c={c}
              roomShort={roomShort}
              onToggle={c.scope === 'project' ? (en) => onToggle(c.name, en) : undefined}
              onRemove={c.scope === 'project' ? () => onRemove(c.name) : undefined}
            />
          ))}
          {!adding ? (
            <button className="cn__add" onClick={() => setAdding(true)}>
              + Add a connector to this project
            </button>
          ) : (
            <form
              className="cn__form"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <div className="cn__formRow">
                <input className="cn__in" value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. github)" autoFocus />
                <div className="cn__seg" role="radiogroup" aria-label="Transport">
                  {(['stdio', 'http', 'sse'] as const).map((t) => (
                    <button key={t} type="button" role="radio" aria-checked={transport === t} className={`cn__segBtn ${transport === t ? 'cn__segBtn--on' : ''}`} onClick={() => setTransport(t)}>
                      {t === 'stdio' ? 'command' : t}
                    </button>
                  ))}
                </div>
              </div>
              {transport === 'stdio' ? (
                <input className="cn__in cn__in--mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-github" spellCheck={false} />
              ) : (
                <input className="cn__in cn__in--mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
              )}
              <textarea
                className="cn__in cn__in--mono"
                rows={2}
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                placeholder={transport === 'stdio' ? 'environment, one per line: GITHUB_TOKEN=…' : 'headers, one per line: Authorization: Bearer …'}
                spellCheck={false}
              />
              <p className="cn__hint">Written to {roomShort}/.mcp.json, the file Claude Code reads in the terminal too. Secrets in it are your call — it is a file in the project.</p>
              <div className="cn__formActions">
                <button type="button" className="cn__link" onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button type="submit" className="cn__save" disabled={!ready}>
                  Add
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="cn__group">
          <div className="cn__groupHead">
            Shared
            <span className="cn__groupHint">your user-wide and claude.ai connectors — on this room’s wall only when you turn them on</span>
          </div>
          {shared.length === 0 && room?.checkedAt && <div className="cn__empty">None. Add one with <code>claude mcp add</code> and it becomes available to every room.</div>}
          {shared.map((c) => (
            <Row
              key={`${c.scope}:${c.name}`}
              c={c}
              roomShort={roomShort}
              onToggle={c.status === 'disabled' ? undefined : (en) => onToggle(c.name, en)}
              onLoaded={c.scope === 'user' || c.scope === 'claudeai' ? (l) => onLoaded(c.name, l) : undefined}
            />
          ))}
          {shared.length > 0 && (
            <div className="cn__scopeNote">
              {[...new Set(shared.map((c) => SCOPE_LABEL[c.scope]))].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
