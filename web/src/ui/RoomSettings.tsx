import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from './useFocusTrap';
import type { Connector, Team, Room } from '@shared/types';
import { paintFloorSample, THEMES, type Theme } from '../render/draw';
import { fileToLogo, type FloorMat, type RoomConfig } from '../roomConfig';

interface Props {
  room: Room;
  config: RoomConfig;
  onChange: (patch: RoomConfig) => string | null; // returns an error, or null
  onDecorate: () => void; // switch to the room editor
  onHide: () => void; // put this room away (reversible; never touches transcripts)
  onClose: () => void;
  /** the active team in this room, if any — the section flips to status */
  team: Team | null;
  /** sessions in this room, and how many were let go */
  sessionCount: number;
  awayCount: number;
  onOpenRoster: () => void;
  /** the room's connectors (MCP servers), and their health */
  onOpenConnectors?: () => void;
  connectorsSummary?: string;
  /** every connector the room could have, with its per-room switch */
  connectors?: Connector[];
  onToggleConnector?: (name: string, on: boolean) => void;
}

const SCOPE_HINT: Record<Connector['scope'], string> = {
  project: 'this project',
  local: 'this project',
  user: 'user-wide',
  claudeai: 'claude.ai',
  plugin: 'plugin',
  managed: 'managed',
  unknown: '',
};

/** The materials a floor can be laid in, in the order they read as "harder". */
const MATERIALS: { id: FloorMat; label: string }[] = [
  { id: 'wood', label: 'Boards' },
  { id: 'carpet', label: 'Carpet' },
  { id: 'tile', label: 'Tile' },
  { id: 'stone', label: 'Stone' },
  { id: 'checker', label: 'Chequer' },
  { id: 'grass', label: 'Grass' },
];

/**
 * A floor swatch that shows the floor.
 *
 * A flat colour chip can tell you a room is brown; it can't tell you whether
 * that's oak boards or terracotta tile. This paints the real material with the
 * same code the world uses, so what you pick is what you get.
 */
function FloorSwatch({ theme, mat }: { theme: Theme; mat?: FloorMat }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = 84;
    const h = 42;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    paintFloorSample(ctx, 0, 0, w, h, theme, mat);
  }, [theme, mat]);
  return <canvas ref={ref} className="rs__swatchArt" style={{ width: 84, height: 42 }} aria-hidden="true" />;
}

/** Per-room settings: what the room is called, what it's made of, what's on it. */
export function RoomSettings({ room, config, team, sessionCount, awayCount, onOpenRoster, onOpenConnectors, connectorsSummary, connectors, onToggleConnector, onChange, onDecorate, onHide, onClose }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Escape closes the dialog from anywhere inside it, not only from the fields
  // that happened to have their own handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (confirmRemove) setConfirmRemove(false);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirmRemove, onClose]);

  const theme = THEMES.find((t) => t.id === config.theme) ?? THEMES[0];

  const pickLogo = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const logo = await fileToLogo(file);
      const err = onChange({ logo });
      if (err) setError(err);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load that image');
    }
  };

  return (
    <div className="rs" ref={trapRef} role="dialog" aria-modal="true" aria-label={`${room.name} settings`}>
      <header className="rs__head">
        <div className="rs__ident">
          <h2 className="rs__title">{config.name?.trim() || room.name}</h2>
          <div className="rs__path" title={room.path}>
            {room.path}
          </div>
        </div>
        <button className="rs__x" onClick={onClose} aria-label="Close settings">
          ✕
        </button>
      </header>

      <div className="rs__body">
        <section className="rs__group">
          <div className="rs__label" id="rs-floor">
            Floor
          </div>
          <div className="rs__swatches" role="radiogroup" aria-labelledby="rs-floor">
            {THEMES.map((t) => {
              const on = (config.theme ?? THEMES[0].id) === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`rs__swatch ${on ? 'rs__swatch--on' : ''}`}
                  onClick={() => onChange({ theme: t.id })}
                >
                  <FloorSwatch theme={t} mat={config.floor} />
                  <span className="rs__swatchName">{t.name}</span>
                </button>
              );
            })}
          </div>

          <div className="rs__label rs__label--sub">Laid as</div>
          <div className="rs__chips" role="radiogroup" aria-label="Floor material">
            {MATERIALS.map((m) => {
              const on = (config.floor ?? theme.mat) === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`rs__chip ${on ? 'rs__chip--on' : ''}`}
                  onClick={() => onChange({ floor: m.id })}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          <button className="rs__btn rs__btn--wide" onClick={onDecorate}>
            Decorate room…
            <span className="rs__btnNote">place furniture, move things around</span>
          </button>
        </section>

        <section className="rs__group">
          <label className="rs__label" htmlFor="rs-name">
            Display name
          </label>
          <input
            id="rs-name"
            className="rs__input"
            placeholder={room.name}
            defaultValue={config.name ?? ''}
            maxLength={40}
            onChange={(e) => onChange({ name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
          <p className="rs__hint">
            Shown on the room instead of the folder name. Leave blank to use <code>{room.name}</code>.
          </p>
        </section>

        <section className="rs__group">
          <div className="rs__label">Project logo</div>
          <div className="rs__logo">
            <div className="rs__well">
              {config.logo ? <img src={config.logo} alt="" /> : <span>none</span>}
            </div>
            <div className="rs__logoActions">
              <button className="rs__btn" onClick={() => fileRef.current?.click()}>
                {config.logo ? 'Replace…' : 'Choose image…'}
              </button>
              {config.logo && (
                <button
                  className="rs__btn rs__btn--quiet"
                  onClick={() => {
                    setError(null);
                    onChange({ logo: undefined });
                  }}
                >
                  Remove
                </button>
              )}
              <p className="rs__hint">Printed faintly on the floor, so you know the room at a glance.</p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                void pickLogo(e.target.files?.[0]);
                e.target.value = ''; // allow re-picking the same file
              }}
            />
          </div>
          {error && <div className="rs__error">{error}</div>}
        </section>

        <section className="rs__group">
          <div className="rs__label">Sessions</div>
          <button className="rs__btn rs__sessions" onClick={onOpenRoster}>
            {sessionCount} in the room
            {awayCount > 0 ? ` · ${awayCount} let go` : ''}
          </button>
          <p className="rs__hint">
            {awayCount > 0
              ? 'Open the list to bring an agent back, or to let another one go.'
              : 'Open the list to see every session here, or to let one go. Letting go frees the desk and keeps the conversation.'}
          </p>
        </section>

        {onOpenConnectors && (
          <section className="rs__group">
            <div className="rs__label">Connections</div>
            {/* One switch per connector, right here: nothing goes on this
                room's wall unless it is turned on for the room. */}
            {connectors && connectors.length > 0 && (
              <ul className="rs__conns">
                {connectors.map((c) => {
                  const local = c.scope === 'local';
                  return (
                    <li key={`${c.scope}:${c.name}`} className="rs__conn">
                      <span className={`rs__connLed rs__connLed--${c.status}`} aria-hidden="true" />
                      <span className="rs__connName">{c.name}</span>
                      <span className="rs__connHint">
                        {SCOPE_HINT[c.scope]}
                        {c.status === 'failed' ? ' · down' : c.status === 'needs-auth' ? ' · needs sign-in' : c.status === 'disabled' ? ' · disabled here' : ''}
                      </span>
                      <label className="cn__switch" title={local ? 'Added with claude mcp add for this folder; always on here' : c.onWall ? `Turn off for ${room.name}` : `Turn on for ${room.name}`}>
                        <input type="checkbox" checked={c.onWall} disabled={local || !onToggleConnector} onChange={(e) => onToggleConnector?.(c.name, e.target.checked)} />
                        <span className={`cn__sw ${c.onWall ? 'cn__sw--on' : ''} ${local ? 'cn__sw--fixed' : ''}`} />
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <button className="rs__btn rs__sessions" onClick={onOpenConnectors}>
              {connectorsSummary ?? 'see what agents here can reach'}
            </button>
            <p className="rs__hint">
              Which of your connectors (MCP servers) this room shows and uses. Project connectors come from its .mcp.json;
              shared ones are yours and claude.ai’s, off the wall until you turn them on here. Open the list for their
              tools, errors and to add one.
            </p>
          </section>
        )}

        {team && (
          <section className="rs__group">
            <div className="rs__label">Team</div>
            <p className="rs__hint">
              A team is on the job here{team.state === 'awaiting_human' ? ' — and waiting on you' : ''}. Click its rug in
              the room to open the panel. New teams are hired from an empty desk.
            </p>
          </section>
        )}

        <section className="rs__group">
          <label className="rs__label" htmlFor="rs-notes">
            Whiteboard notes
          </label>
          <textarea
            id="rs-notes"
            className="rs__input rs__notes"
            rows={3}
            placeholder={'ship v1\nfix login bug\ndemo friday'}
            defaultValue={config.notes ?? ''}
            maxLength={240}
            onChange={(e) => onChange({ notes: e.target.value })}
          />
          <p className="rs__hint">
            One note per line. They appear on a whiteboard once you place one in the room.
          </p>
        </section>
      </div>

      <footer className="rs__foot">
        {confirmRemove ? (
          <>
            <span className="rs__confirmText">
              Take {config.name?.trim() || room.name} out of the office? Nothing on disk is touched.
            </span>
            <div className="rs__confirmBtns">
              <button className="rs__btn rs__btn--quiet" onClick={() => setConfirmRemove(false)}>
                Cancel
              </button>
              <button className="rs__btn rs__btn--danger" onClick={onHide}>
                Remove
              </button>
            </div>
          </>
        ) : (
          <button className="rs__remove" onClick={() => setConfirmRemove(true)}>
            Remove this room
          </button>
        )}
      </footer>
    </div>
  );
}
