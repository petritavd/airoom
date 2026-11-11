import { useEffect, useMemo, useRef, useState } from 'react';
import { PERMISSION_MODES, type ModelChoice, type PermissionMode, type Playbook, type PlaybookInput, type PlaybookRule, type PlaybookStep } from '@shared/types';
import { PickerMenu } from './PickerMenu';
import { useFocusTrap } from './useFocusTrap';
import { useAutoGrow } from './useAutoGrow';

/**
 * The card, editable.
 *
 * Opened on a proposal ("Make this a playbook" just read the session) or on
 * a saved playbook. Every line the model proposed is a suggestion the human
 * can strike, reword or add to — a rule that only applied to the first task
 * is unticked here, not carried for ever. Nothing is saved until Save.
 */

interface Props {
  /** The proposal or the saved card. `id` empty = not saved yet. */
  draft: Playbook;
  /** Where it came from, for the header. */
  sourceTitle?: string;
  models: ModelChoice[];
  onSave: (playbook: Playbook) => void;
  onClose: () => void;
}

type Line<T> = T & { keep: boolean; k: string };
let seq = 0;
const key = () => `k${++seq}`;

function Rows<T>({
  rows,
  onChange,
  render,
  add,
  addLabel,
}: {
  rows: Line<T>[];
  onChange: (rows: Line<T>[]) => void;
  render: (row: Line<T>, patch: (p: Partial<T>) => void) => React.ReactNode;
  add: () => T;
  addLabel: string;
}) {
  return (
    <div className="pbe__rows">
      {rows.map((row, i) => (
        <div key={row.k} className={`pbe__row ${row.keep ? '' : 'pbe__row--off'}`}>
          <input
            type="checkbox"
            className="pbe__keep"
            checked={row.keep}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, keep: e.target.checked } : r)))}
            title={row.keep ? 'Kept on the card' : 'Left off the card'}
            aria-label="Keep this line"
          />
          <div className="pbe__rowBody">{render(row, (p) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r))))}</div>
          <button
            type="button"
            className="pbe__x"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            aria-label="Remove this line"
            title="Remove"
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="pbe__add" onClick={() => onChange([...rows, { ...add(), keep: true, k: key() }])}>
        + {addLabel}
      </button>
    </div>
  );
}

function Grow({ value, onChange, placeholder, rows = 1, className = '' }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; className?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, value, 0.3);
  return <textarea ref={ref} className={`pbe__ta ${className}`} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function PlaybookEditor({ draft, sourceTitle, models, onSave, onClose }: Props) {
  const trapRef = useFocusTrap<HTMLElement>(true);
  const fresh = !draft.id;
  const [name, setName] = useState(draft.name);
  const [goal, setGoal] = useState(draft.goal);
  const [output, setOutput] = useState(draft.output);
  const [inputs, setInputs] = useState<Line<PlaybookInput>[]>(() => draft.inputs.map((i) => ({ ...i, keep: true, k: key() })));
  const [rules, setRules] = useState<Line<PlaybookRule>[]>(() => draft.rules.map((r) => ({ ...r, keep: true, k: key() })));
  const [steps, setSteps] = useState<Line<PlaybookStep>[]>(() => draft.steps.map((s) => ({ ...s, keep: true, k: key() })));
  const [checks, setChecks] = useState<Line<{ text: string }>[]>(() => draft.checks.map((c) => ({ text: c, keep: true, k: key() })));
  const [allow, setAllow] = useState<Line<{ rule: string }>[]>(() => draft.allow.map((a) => ({ rule: a, keep: true, k: key() })));
  const [mode, setMode] = useState<PermissionMode>(draft.mode ?? 'default');
  const [model, setModel] = useState(draft.model ?? '');
  const [showAllow, setShowAllow] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const modelOptions = useMemo(
    () => [{ value: '', label: 'Default', hint: 'Whatever your Claude Code is set to' }, ...models.filter((m) => m.quality !== 'unfit').map((m) => ({ value: m.value, label: m.displayName, hint: m.description }))],
    [models],
  );

  const ready = name.trim().length > 0 && goal.trim().length > 0;
  const submit = () => {
    if (!ready) return;
    onSave({
      ...draft,
      name: name.trim(),
      goal: goal.trim(),
      output: output.trim(),
      inputs: inputs.filter((i) => i.keep && i.key.trim()).map(({ keep: _k, k: _kk, ...i }) => ({ ...i, key: i.key.trim(), label: i.label.trim() || i.key.trim() })),
      rules: rules.filter((r) => r.keep && r.text.trim()).map(({ keep: _k, k: _kk, ...r }) => ({ ...r, text: r.text.trim() })),
      steps: steps.filter((s) => s.keep && s.text.trim()).map(({ keep: _k, k: _kk, ...s }) => ({ text: s.text.trim(), ...(s.pause ? { pause: true } : {}) })),
      checks: checks.filter((c) => c.keep && c.text.trim()).map((c) => c.text.trim()),
      allow: allow.filter((a) => a.keep && a.rule.trim()).map((a) => a.rule.trim()),
      ...(mode !== 'default' ? { mode } : { mode: undefined }),
      ...(model ? { model } : { model: undefined }),
    });
  };

  const src = draft.source;
  return (
    <section className="pbe" ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="pbe-title">
      <header className="pbe__head">
        <div>
          <h2 className="pbe__title" id="pbe-title">
            {fresh ? 'New playbook' : 'Edit playbook'}
          </h2>
          <p className="pbe__sub">
            {fresh
              ? `Read from ${sourceTitle ? `“${sourceTitle}”` : 'the session'}. Untick what only applied that time; everything ticked is the process from now on.`
              : 'Every line here is what a run is told. Change it and the next run follows the change.'}
          </p>
        </div>
        <button className="panel__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <div className="pbe__scroll">
        {(src.messages > 0 || src.approvals > 0) && (
          <p className="pbe__baseline">
            The first time took <b>{src.messages}</b> {src.messages === 1 ? 'message' : 'messages'} from you
            {src.corrections > 0 ? ` (${src.corrections} ${src.corrections === 1 ? 'correction' : 'corrections'})` : ''} and{' '}
            <b>{src.approvals}</b> {src.approvals === 1 ? 'approval' : 'approvals'}. The next run is measured against that.
          </p>
        )}

        <label className="pbe__label" htmlFor="pbe-name">
          Name
        </label>
        <input id="pbe-name" ref={nameRef} className="pbe__in" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="What you would call this job" />

        <label className="pbe__label">Goal</label>
        <Grow value={goal} onChange={setGoal} rows={2} placeholder="The outcome, as an instruction for next time" />

        <label className="pbe__label">
          Inputs <span className="pbe__hint">what changes each run — referred to as {'{key}'} in the steps</span>
        </label>
        <Rows
          rows={inputs}
          onChange={setInputs}
          add={(): PlaybookInput => ({ key: '', label: '' })}
          addLabel="input"
          render={(row, patch) => (
            <div className="pbe__inputRow">
              <input className="pbe__in pbe__in--label" value={row.label} placeholder="What to ask for" onChange={(e) => patch({ label: e.target.value })} />
              <input
                className="pbe__in pbe__in--key"
                value={row.key}
                placeholder="key"
                onChange={(e) => patch({ key: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-') })}
                title="How the steps refer to it: {key}"
              />
              <input className="pbe__in pbe__in--ex" value={row.example ?? ''} placeholder="this time it was…" onChange={(e) => patch({ example: e.target.value })} />
            </div>
          )}
        />

        <label className="pbe__label">
          Rules <span className="pbe__hint">standing instructions, from your corrections and preferences</span>
        </label>
        <Rows
          rows={rules}
          onChange={setRules}
          add={() => ({ id: `r${Date.now().toString(36)}`, text: '', from: 'session' as const, at: new Date().toISOString() })}
          addLabel="rule"
          render={(row, patch) => (
            <div className="pbe__ruleRow">
              <Grow value={row.text} onChange={(v) => patch({ text: v })} placeholder="Always… / Never… / Use X instead of Y" />
              {row.from === 'run' && <span className="pbe__tag">added during a run</span>}
            </div>
          )}
        />

        <label className="pbe__label">
          Steps <span className="pbe__hint">mark a review point where you want to look before it goes on</span>
        </label>
        <Rows
          rows={steps}
          onChange={setSteps}
          add={(): PlaybookStep => ({ text: '' })}
          addLabel="step"
          render={(row, patch) => (
            <div className="pbe__stepRow">
              <Grow value={row.text} onChange={(v) => patch({ text: v })} placeholder="One step of the process" />
              <label className={`pbe__pause ${row.pause ? 'pbe__pause--on' : ''}`} title="The run stops after this step and waits for you">
                <input type="checkbox" checked={!!row.pause} onChange={(e) => patch({ pause: e.target.checked })} />
                review point
              </label>
            </div>
          )}
        />

        <label className="pbe__label">
          Checks <span className="pbe__hint">what proves it worked</span>
        </label>
        <Rows rows={checks} onChange={setChecks} add={() => ({ text: '' })} addLabel="check" render={(row, patch) => <Grow value={row.text} onChange={(v) => patch({ text: v })} placeholder="e.g. npm test passes" />} />

        <label className="pbe__label">Deliver</label>
        <Grow value={output} onChange={setOutput} placeholder="What the run hands back at the end" />

        <button type="button" className="pbe__disclose" onClick={() => setShowAllow((v) => !v)} aria-expanded={showAllow}>
          <span className={`pbe__arrow ${showAllow ? 'pbe__arrow--open' : ''}`}>▸</span>
          Runs without asking · {allow.filter((a) => a.keep).length} {allow.filter((a) => a.keep).length === 1 ? 'rule' : 'rules'}
          <span className="pbe__discloseSum">{allow.filter((a) => a.keep).length ? 'earned in the first session' : 'every tool asks'}</span>
        </button>
        {showAllow && (
          <div className="pbe__allow">
            <p className="pbe__hint">
              What you approved the first time, as Claude Code permission rules. A run never raises a card for these; anything outside
              the list still asks. Untick a line to make it ask again.
            </p>
            <Rows
              rows={allow}
              onChange={setAllow}
              add={() => ({ rule: '' })}
              addLabel="rule"
              render={(row, patch) => <input className="pbe__in pbe__in--mono" value={row.rule} placeholder="Bash(npm test:*)" onChange={(e) => patch({ rule: e.target.value })} spellCheck={false} />}
            />
          </div>
        )}

        <div className="pbe__settings">
          <span className="pbe__label">Runs as</span>
          <PickerMenu
            className="pbe__pick"
            value={mode}
            options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, hint: m.hint }))}
            onPick={(v) => setMode(v as PermissionMode)}
            placement="up"
            ariaLabel="Permission mode for runs"
          />
          <PickerMenu className="pbe__pick" value={model} options={modelOptions} onPick={setModel} placement="up" ariaLabel="Model for runs" />
        </div>
      </div>

      <footer className="pbe__foot">
        <button type="button" className="pbe__cancel" onClick={onClose}>
          Cancel
        </button>
        <span className="pbe__gap" />
        {!ready && <span className="pbe__why">A name and a goal are the minimum.</span>}
        <button type="button" className="pbe__save" disabled={!ready} onClick={submit}>
          {fresh ? 'Save playbook' : 'Save changes'}
        </button>
      </footer>
    </section>
  );
}
