import { useEffect, useMemo, useState } from 'react';
import { PERMISSION_MODES, type ModelChoice, type PermissionMode, type Playbook, type PlaybookRun, type Robot, type Room } from '@shared/types';
import { Markdown } from './Markdown';
import { PickerMenu } from './PickerMenu';
import { ago } from './Queue';
import { basename } from '../pathish';

/**
 * The playbooks panel: the library, and one card open with its Run form.
 *
 * The number this panel exists to show is the score: what the first time
 * cost in messages and approvals, against what the last run cost. A playbook
 * that still needs as much of you as the original session is not doing its
 * job, and the panel says so rather than hiding it.
 */

const RUN_LABEL: Record<PlaybookRun['state'], string> = {
  working: 'running',
  waiting: 'needs you',
  done: 'done',
  error: 'failed',
  stopped: 'stopped',
};

function Score({ pb }: { pb: Playbook }) {
  const last = [...pb.runs].reverse().find((r) => r.state === 'done') ?? pb.runs[pb.runs.length - 1];
  const s = pb.source;
  return (
    <div className="pbp__score" title="Messages you had to send, and approval cards raised — the supervision a run cost">
      <div className="pbp__scoreCol">
        <span className="pbp__scoreLabel">first time</span>
        <span className="pbp__scoreN">
          {s.messages} <small>msg</small> · {s.approvals} <small>approvals</small>
        </span>
      </div>
      <span className="pbp__scoreArrow">→</span>
      <div className="pbp__scoreCol">
        <span className="pbp__scoreLabel">{last ? (last.state === 'done' ? 'last run' : `last run · ${RUN_LABEL[last.state]}`) : 'next run'}</span>
        <span className={`pbp__scoreN ${last ? 'pbp__scoreN--live' : ''}`}>
          {last ? (
            <>
              {last.messages} <small>msg</small> · {last.approvals} <small>approvals</small>
            </>
          ) : (
            <em>not run yet</em>
          )}
        </span>
      </div>
    </div>
  );
}

export function PlaybookPanel({
  playbooks,
  rooms,
  robots,
  models,
  selectedId,
  canRun,
  onSelect,
  onRun,
  onEdit,
  onDelete,
  onStop,
  onDropRule,
  onOpenAgent,
  onClose,
}: {
  playbooks: Playbook[];
  rooms: Room[];
  robots: Robot[];
  models: ModelChoice[];
  selectedId: string | null;
  canRun: boolean;
  onSelect: (id: string | null) => void;
  onRun: (id: string, inputs: Record<string, string>, mode?: PermissionMode, model?: string) => void;
  onEdit: (pb: Playbook) => void;
  onDelete: (id: string) => void;
  onStop: (id: string, runId: string) => void;
  onDropRule: (id: string, ruleId: string) => void;
  onOpenAgent: (sessionId: string) => void;
  onClose: () => void;
}) {
  const roomName = useMemo(() => {
    const m = new Map(rooms.map((r) => [r.id, r.name || basename(r.id)]));
    return (id: string) => m.get(id) ?? basename(id);
  }, [rooms]);
  const selected = playbooks.find((p) => p.id === selectedId) ?? null;

  // The Run form: one field per input, remembered while the card stays open.
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<PermissionMode | ''>('');
  const [model, setModel] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showCard, setShowCard] = useState(true);
  useEffect(() => {
    setInputs({});
    setMode('');
    setModel('');
    setConfirmDelete(false);
  }, [selectedId]);

  const live = (pb: Playbook) => pb.runs.filter((r) => r.state === 'working' || r.state === 'waiting');
  const robotOf = (r: PlaybookRun) => (r.sessionId ? robots.find((x) => x.sessionId === r.sessionId) : undefined);

  if (!selected) {
    const byRoom = new Map<string, Playbook[]>();
    for (const pb of playbooks) byRoom.set(pb.roomId, [...(byRoom.get(pb.roomId) ?? []), pb]);
    return (
      <section className="pbp" aria-label="Playbooks">
        <div className="pbp__head">
          <span className="pbp__title">Playbooks</span>
          <span className="pbp__count">{playbooks.length}</span>
          <div className="pbp__right">
            <button className="panel__close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </div>
        <div className="pbp__list">
          {playbooks.length === 0 && (
            <div className="pbp__empty">
              <p>
                <b>A playbook is a task that worked once, written down.</b>
              </p>
              <p>
                Finish a job with an agent the way you want it, then open its desk and choose <b>Make this a playbook</b> from the ⋯
                menu. airoom reads the session — your brief, your corrections, what ran, what was checked — and proposes the card.
              </p>
              <p>The next time, you fill in the inputs and press Run. The corrections hold and the approvals are already given.</p>
            </div>
          )}
          {[...byRoom.entries()].map(([roomId, list]) => (
            <div key={roomId} className="pbp__group">
              <div className="pbp__groupHead">{roomName(roomId)}</div>
              {list.map((pb) => {
                const running = live(pb);
                const last = pb.runs[pb.runs.length - 1];
                return (
                  <div key={pb.id} className="pbp__row">
                    <button className="pbp__rowMain" onClick={() => onSelect(pb.id)}>
                      <span className="pbp__rowName">{pb.name}</span>
                      <span className="pbp__rowSub">
                        {running.length
                          ? `${running.length === 1 ? 'a run' : `${running.length} runs`} ${running.some((r) => r.state === 'waiting') ? 'needs you' : 'in progress'}`
                          : last
                            ? `${pb.runs.length} ${pb.runs.length === 1 ? 'run' : 'runs'} · last ${ago(last.startedAt)} ago · ${last.messages} msg, ${last.approvals} approvals`
                            : `not run yet · first time: ${pb.source.messages} msg, ${pb.source.approvals} approvals`}
                      </span>
                    </button>
                    <button className="qa qa--accent" onClick={() => onSelect(pb.id)} title="Open the card and run it">
                      Run
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>
    );
  }

  const pb = selected;
  const running = live(pb);
  const missing = pb.inputs.filter((i) => !inputs[i.key]?.trim());
  const modelOptions = [{ value: '', label: pb.model ? (models.find((m) => m.value === pb.model)?.displayName ?? pb.model) : 'Default', hint: 'What the card says' }, ...models.filter((m) => m.quality !== 'unfit').map((m) => ({ value: m.value, label: m.displayName, hint: m.description }))];
  const cardMode = PERMISSION_MODES.find((m) => m.value === (pb.mode ?? 'default'));
  const runIt = () => {
    onRun(pb.id, inputs, mode || undefined, model || undefined);
  };

  return (
    <section className="pbp" aria-label={`Playbook: ${pb.name}`}>
      <div className="pbp__head">
        <button className="pbp__back" onClick={() => onSelect(null)} title="All playbooks">
          ‹
        </button>
        <span className="pbp__title pbp__title--name" title={pb.goal}>
          {pb.name}
        </span>
        <span className="pbp__room">{roomName(pb.roomId)}</span>
        <div className="pbp__right">
          <button className="pbp__ico" onClick={() => onEdit(pb)} title="Edit the card">
            edit
          </button>
          <button className="panel__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
      </div>

      <div className="pbp__body">
        <Score pb={pb} />

        <form
          className="pbp__run"
          onSubmit={(e) => {
            e.preventDefault();
            runIt();
          }}
        >
          {pb.inputs.map((i) => (
            <label key={i.key} className="pbp__field">
              <span className="pbp__fieldLabel">{i.label}</span>
              <input
                className="pbp__in"
                value={inputs[i.key] ?? ''}
                placeholder={i.example ? `last time: ${i.example}` : ''}
                onChange={(e) => setInputs((prev) => ({ ...prev, [i.key]: e.target.value }))}
              />
            </label>
          ))}
          {pb.inputs.length === 0 && <p className="pbp__hint">This playbook takes no inputs — it runs the same way every time.</p>}
          <div className="pbp__runRow">
            <PickerMenu
              className="pbp__pick"
              value={mode}
              options={[{ value: '', label: cardMode?.label ?? 'asks first', hint: 'What the card says' }, ...PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, hint: m.hint }))]}
              onPick={(v) => setMode(v as PermissionMode | '')}
              placement="down"
              ariaLabel="Permission mode for this run"
            />
            <PickerMenu className="pbp__pick" value={model} options={modelOptions} onPick={setModel} placement="down" ariaLabel="Model for this run" />
            <span className="pbp__gap" />
            <button type="submit" className="pbp__go" disabled={!canRun}>
              {running.length ? 'Run again' : 'Run'}
            </button>
          </div>
          {missing.length > 0 && <p className="pbp__hint">Left blank, the agent asks for {missing.map((m) => m.label).join(', ')} before it starts.</p>}
          {pb.allow.length > 0 && (
            <p className="pbp__hint">
              Runs without asking for {pb.allow.length} {pb.allow.length === 1 ? 'kind of call' : 'kinds of call'} it was allowed the first time. Everything else still asks.
            </p>
          )}
        </form>

        {pb.runs.length > 0 && (
          <div className="pbp__runs">
            <div className="pbp__secHead">Runs</div>
            {[...pb.runs].reverse().map((r, idx) => {
              const n = pb.runs.length - idx;
              const robot = robotOf(r);
              return (
                <details key={r.id} className={`pbp__runItem pbp__runItem--${r.state}`} open={r.state === 'working' || r.state === 'waiting'}>
                  <summary>
                    <span className={`pbp__dot pbp__dot--${r.state}`} aria-hidden="true" />
                    <span className="pbp__runN">run {n}</span>
                    <span className="pbp__runState">{RUN_LABEL[r.state]}</span>
                    <span className="pbp__runScore" title="messages you sent · approval cards raised · rules you added">
                      {r.messages} msg · {r.approvals} appr{r.rulesAdded ? ` · +${r.rulesAdded} rule${r.rulesAdded === 1 ? '' : 's'}` : ''}
                    </span>
                    <span className="pbp__runAge">{ago(r.startedAt)} ago</span>
                  </summary>
                  <div className="pbp__runBody">
                    {Object.entries(r.inputs).filter(([, v]) => v).length > 0 && (
                      <dl className="pbp__runInputs">
                        {Object.entries(r.inputs)
                          .filter(([, v]) => v)
                          .map(([k, v]) => (
                            <div key={k}>
                              <dt>{pb.inputs.find((i) => i.key === k)?.label ?? k}</dt>
                              <dd>{v}</dd>
                            </div>
                          ))}
                      </dl>
                    )}
                    {r.summary && (
                      <div className="pbp__runSummary">
                        <Markdown text={r.summary} />
                      </div>
                    )}
                    {r.costUsd > 0 && <div className="pbp__runCost">${r.costUsd.toFixed(3)}</div>}
                    <div className="pbp__runActions">
                      {r.sessionId && (
                        <button className="qa qa--accent" onClick={() => r.sessionId && onOpenAgent(r.sessionId)} disabled={!robot} title={robot ? 'Open this run’s desk' : 'Its session is not in the office'}>
                          {r.state === 'waiting' ? 'Answer' : 'Open'}
                        </button>
                      )}
                      {(r.state === 'working' || r.state === 'waiting') && (
                        <button className="qa" onClick={() => onStop(pb.id, r.id)}>
                          Stop
                        </button>
                      )}
                    </div>
                  </div>
                </details>
              );
            })}
          </div>
        )}

        <button type="button" className="pbp__disclose" onClick={() => setShowCard((v) => !v)} aria-expanded={showCard}>
          <span className={`pbp__arrow ${showCard ? 'pbp__arrow--open' : ''}`}>▸</span>
          The card
          <span className="pbp__discloseSum">
            {pb.rules.length} {pb.rules.length === 1 ? 'rule' : 'rules'} · {pb.steps.length} steps · {pb.checks.length} checks
          </span>
        </button>
        {showCard && (
          <div className="pbp__card">
            <div className="pbp__secHead">Goal</div>
            <p className="pbp__text">{pb.goal}</p>
            {pb.rules.length > 0 && (
              <>
                <div className="pbp__secHead">Rules</div>
                <ul className="pbp__rules">
                  {pb.rules.map((r) => (
                    <li key={r.id} className="pbp__rule">
                      <span className="pbp__ruleText">{r.text}</span>
                      {r.from === 'run' && <span className="pbp__tag" title={`Added during a run, ${ago(r.at)} ago`}>learned</span>}
                      <button className="pbp__ruleX" onClick={() => onDropRule(pb.id, r.id)} title="Drop this rule" aria-label="Drop this rule">
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {pb.steps.length > 0 && (
              <>
                <div className="pbp__secHead">Steps</div>
                <ol className="pbp__steps">
                  {pb.steps.map((s, i) => (
                    <li key={i} className={s.pause ? 'pbp__step--pause' : ''}>
                      {s.text}
                      {s.pause && <span className="pbp__tag pbp__tag--pause">waits for you</span>}
                    </li>
                  ))}
                </ol>
              </>
            )}
            {pb.checks.length > 0 && (
              <>
                <div className="pbp__secHead">Checks</div>
                <ul className="pbp__checks">
                  {pb.checks.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </>
            )}
            {pb.output && (
              <>
                <div className="pbp__secHead">Deliver</div>
                <p className="pbp__text">{pb.output}</p>
              </>
            )}
            {pb.allow.length > 0 && (
              <>
                <div className="pbp__secHead">Runs without asking</div>
                <ul className="pbp__allow">
                  {pb.allow.map((a) => (
                    <li key={a}>
                      <code>{a}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        <div className="pbp__danger">
          {!confirmDelete ? (
            <button className="pbp__del" onClick={() => setConfirmDelete(true)}>
              Delete this playbook
            </button>
          ) : (
            <>
              <span className="pbp__dangerText">Deletes the card and its run history. The sessions it ran stay in the office.</span>
              <button className="qa" onClick={() => setConfirmDelete(false)}>
                Keep it
              </button>
              <button className="pbp__del pbp__del--go" onClick={() => onDelete(pb.id)}>
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
