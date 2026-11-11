import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_TEAM_LANES,
  MAX_TEAM_MEMBERS,
  PERMISSION_MODES,
  TEAM_AUTONOMY_CHOICES,
  TEAM_PRESETS,
  type MemberKind,
  type ModelChoice,
  type PermissionMode,
  type RosterMember,
  type TeamAutonomy,
  type TeamPreset,
} from '@shared/types';
import { PickerMenu } from './PickerMenu';
import { useAutoGrow } from './useAutoGrow';
import { API_BASE } from '../net/base';

import { clearDraft, draftWorthKeeping, loadDraft, saveDraft, type HireDraft } from './hireDraft';
const QUALITY_LABEL = {
  strong: 'works well',
  fair: 'works for small tasks',
  weak: 'struggles with agents',
  unfit: "can't drive agents",
} as const;

/** What each member DOES, in the two words the chip has room for. */
function does(m: RosterMember): string {
  if (m.kind === 'lead') return 'orchestrates';
  if (m.kind === 'reviewer') return 'reviews';
  return m.writes === false ? 'reads only' : 'edits files';
}

/** Rosters the user saved. Kept in the browser: a roster is a preference, not
 *  project data, and putting it on disk would need a settings file nobody
 *  asked for. */
const SAVED_KEY = 'airoom.teamRosters';

function loadSaved(): TeamPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]');
    return Array.isArray(raw) ? (raw as TeamPreset[]).filter((p) => p?.id && Array.isArray(p.members)) : [];
  } catch {
    return [];
  }
}

function saveSaved(list: TeamPreset[]) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 12)));
  } catch {
    /* private mode, quota — a preset is not worth an error */
  }
}

/** Same rule the server uses, so a clash can be caught before it happens. */
const idOf = (label: string, kind: MemberKind) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || kind;

/** The three check-in rules, named by when a person hears from the team. */
const CHECKIN_TITLE: Record<TeamAutonomy, string> = {
  auto_capped: 'After a few fix rounds',
  gated: 'At every handoff',
  auto: 'When a reviewer approves',
};

/** "a, b and c" — a list a person would read aloud. */
function sentenceList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

interface GitFacts {
  repo: boolean;
  branch: string | null;
  dirty: number;
  commits: boolean;
}

export interface HirePayload {
  task: string;
  roster: RosterMember[];
  lanes: number;
  ownRoom: boolean;
  thrift: boolean;
}

/**
 * The team brief — what you fill in at an empty desk after choosing "Team".
 *
 * ONE THING IS REQUIRED AND EVERYTHING ELSE IS A DEFAULT.
 * The brief is the only field anyone has to type; the crew, the place and the
 * autonomy are remembered or presets. So they are laid out as three short
 * rows of choices rather than as sections of prose — an earlier version had
 * nine stacked blocks of equal weight and three separate paragraphs
 * explaining the same idea, and the honest verdict on it was that you could
 * not tell what was about to happen.
 *
 * WHAT WILL HAPPEN IS STATED, NOT HINTED AT.
 * Each choice carries one line saying what it means for THIS folder — the
 * branch a room would fork from, the files it would not see, how many agents
 * you are about to start — and the footer says the whole thing back as a
 * sentence before you commit to it. Facts beat caveats: a warning about
 * uncommitted work is ignored, "your 3 uncommitted files stay here" is not.
 */
export function HireTeam({
  roomId,
  roomName,
  autonomy,
  roundCap,
  mode,
  model,
  models,
  busy,
  visible,
  hired,
  onDefaults,
  onHire,
}: {
  roomId: string;
  roomName: string;
  autonomy: TeamAutonomy;
  roundCap: number;
  /** Applies to every member's runs unless that member has its own choice. */
  mode: PermissionMode;
  model: string;
  models: ModelChoice[];
  /** false while the socket is down */
  busy: boolean;
  /** Bumped when a team this form asked for has actually been seated. */
  hired: number;
  /** Rendered but hidden while the desk shows the Agent side. It stays MOUNTED
   *  on purpose: unmounting threw away a half-written brief every time someone
   *  tapped Agent to check something. */
  visible: boolean;
  onDefaults: (patch: {
    teamAutonomy?: TeamAutonomy;
    teamRoundCap?: number;
    teamMode?: PermissionMode;
    teamModel?: string;
  }) => void;
  onHire: (payload: HirePayload) => void;
}) {
  // A half-written brief survives closing the desk: the draft lives in
  // localStorage under this room, crew and placement included (hireDraft.ts).
  const draft = useMemo(() => loadDraft(roomId), [roomId]);
  const [task, setTask] = useState(draft?.task ?? '');
  const [presetId, setPresetId] = useState(draft?.presetId ?? 'standard');
  const [roster, setRoster] = useState<RosterMember[]>(
    () => draft?.roster ?? TEAM_PRESETS[0].members.map((m) => ({ ...m })),
  );
  const [editing, setEditing] = useState<number | null>(null);
  const [place, setPlace] = useState<'here' | 'room' | 'rooms'>(draft?.place ?? 'here');
  const [lanes, setLanes] = useState(draft?.lanes ?? 2);
  const [thrift, setThrift] = useState(false);
  /** Crew, model, permissions and the token saver live under Customize. It
   *  opens by itself when a draft already departs from the standard crew. */
  const [custom, setCustom] = useState<boolean>(() => (draft?.presetId ?? 'standard') !== 'standard');
  const [restored, setRestored] = useState(Boolean(draft?.task.trim()));
  const [saved, setSaved] = useState<TeamPreset[]>(loadSaved);
  const [savingName, setSavingName] = useState<string | null>(null);
  const [git, setGit] = useState<GitFacts | null>(null);

  // Keep the draft current, or clear it once nothing is worth keeping.
  useEffect(() => {
    const d: HireDraft = { task, presetId, roster, place, lanes };
    if (draftWorthKeeping(d)) saveDraft(roomId, d);
    else clearDraft(roomId);
  }, [roomId, task, presetId, roster, place, lanes]);
  const discardDraft = () => {
    clearDraft(roomId);
    setTask('');
    setPresetId('standard');
    setRoster(TEAM_PRESETS[0].members.map((m) => ({ ...m })));
    setEditing(null);
    setPlace('here');
    setLanes(2);
    setRestored(false);
  };

  const presets = useMemo(() => [...TEAM_PRESETS, ...saved], [saved]);
  const crew = roster.filter((m) => m.kind !== 'lead');
  const hasReviewer = roster.some((m) => m.kind === 'reviewer');

  // What this folder's git actually looks like, so the choices below can say
  // what they would do here instead of what they do in general.
  useEffect(() => {
    if (!visible || !roomId) return;
    let live = true;
    fetch(`${API_BASE}/room-git?room=${encodeURIComponent(roomId)}`)
      .then((r) => r.json())
      .then((g: GitFacts) => live && setGit(g))
      .catch(() => live && setGit(null));
    return () => {
      live = false;
    };
  }, [visible, roomId]);

  const canBranch = !!git?.repo && !!git.commits;
  // A place that needs a branch falls back the moment we learn there is none.
  const effectivePlace = place !== 'here' && git && !canBranch ? 'here' : place;
  const roomCount = effectivePlace === 'rooms' ? lanes : effectivePlace === 'room' ? 1 : 0;
  const agentCount = 1 + crew.length * Math.max(1, roomCount || 1);

  /** Model rows for every picker here: local models carry their grade. */
  const modelOptions = (lead: { value: string; label: string; hint?: string }) => [
    lead,
    ...models.map((m) => ({
      value: m.value,
      label: m.displayName,
      hint: m.provider === 'ollama' ? `${QUALITY_LABEL[m.quality ?? 'fair']} — ${m.qualityNote ?? ''}` : m.description,
      disabled: m.quality === 'unfit',
      tone: m.provider === 'ollama' ? (m.quality ?? 'fair') : undefined,
    })),
  ];
  const shaky = (value: string | undefined) => {
    const m = models.find((x) => x.value === value);
    return m?.provider === 'ollama' && m.quality !== 'strong' ? m : null;
  };
  const teamShaky = shaky(model) ?? roster.map((m) => shaky(m.model)).find(Boolean) ?? null;
  /** What Customize holds, said in one line while it is closed. */
  const modelName = models.find((m) => m.value === model)?.displayName ?? 'default model';
  const modeLabel = PERMISSION_MODES.find((m) => m.value === mode)?.label ?? mode;
  const customSummary = `${sentenceList(roster.map((m) => m.label || '—'))} · ${modelName} · ${modeLabel}${thrift ? ' · token saver' : ''}`;
  const teamModelOptions = models.length
    ? modelOptions({ value: '', label: 'Default', hint: 'Whatever your Claude Code is set to' }).filter(
        (o, i, all) => all.findIndex((x) => x.value === o.value) === i,
      )
    : [{ value: '', label: 'Default' }];

  const setMember = (i: number, patch: Partial<RosterMember>) => {
    setRoster((r) => r.map((m, k) => (k === i ? { ...m, ...patch } : m)));
    setPresetId('custom');
  };
  const removeMember = (i: number) => {
    setRoster((r) => r.filter((_, k) => k !== i));
    setEditing(null);
    setPresetId('custom');
  };
  const addMember = (kind: MemberKind) => {
    setRoster((r) => {
      const n = r.filter((m) => m.kind === kind).length + 1;
      const base = kind === 'reviewer' ? 'Reviewer' : 'Worker';
      const label = n > 1 ? `${base} ${n}` : base;
      setEditing(r.length);
      return [...r, kind === 'reviewer' ? { kind, label } : { kind, label, writes: true }];
    });
    setPresetId('custom');
  };
  const applyPreset = (p: TeamPreset) => {
    setPresetId(p.id);
    setRoster(p.members.map((m) => ({ ...m })));
    setEditing(null);
    // A preset is the whole arrangement, placement included. Leaving the old
    // placement behind meant Standard after Full stack quietly kept two rooms
    // — five agents where the chips showed three.
    if ((p.lanes ?? 1) > 1) {
      setPlace('rooms');
      setLanes(Math.max(2, Math.min(MAX_TEAM_LANES, p.lanes ?? 2)));
    } else {
      setPlace(p.members.length > 3 ? 'room' : 'here');
      setLanes(2);
    }
  };

  // Two members that slugify to the same id would be one member on the server.
  const clash = useMemo(() => {
    const seen = new Set<string>(['lead']);
    for (const m of crew) {
      const id = idOf(m.label, m.kind);
      if (seen.has(id)) return m.label;
      seen.add(id);
    }
    return null;
  }, [crew]);

  const ready = task.trim().length >= 8 && !busy && crew.length >= 1 && !clash && roster.every((m) => m.label.trim());
  /** Why the button is off, said plainly beside it. "Describe the job first"
   *  used to greet a seven-character brief as if the field were empty. */
  const whyNot = busy
    ? 'Not available right now.'
    : !task.trim()
      ? 'Describe the job first.'
      : task.trim().length < 8
        ? 'Say a little more about the job — a sentence is enough.'
        : clash
          ? `Two members would both be called "${clash}". Give one another name.`
          : roster.some((m) => !m.label.trim())
            ? 'Every member needs a name.'
            : crew.length < 1
              ? 'Add at least one worker or reviewer.'
              : null;
  const taskRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(taskRef, task);

  // Focus on reveal rather than on mount — autoFocus on a permanently mounted
  // form would steal the caret from the agent composer whenever a desk opens.
  useEffect(() => {
    if (visible) taskRef.current?.focus();
  }, [visible]);

  // "Until approved" means nothing without someone who can approve.
  useEffect(() => {
    if (!hasReviewer && autonomy === 'auto') onDefaults({ teamAutonomy: 'auto_capped' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasReviewer]);

  const submit = () => {
    if (!ready) return;
    onHire({
      task: task.trim(),
      roster: roster.map((m) => ({ ...m, label: m.label.trim() })),
      lanes: effectivePlace === 'rooms' ? lanes : 1,
      ownRoom: effectivePlace !== 'here',
      thrift,
    });
    // The draft stays put until the server actually seats a team: a hire that
    // is refused — no SDK engine, a bad roster — must leave the
    // person their brief, not an empty box and a red notice. App clears it
    // when the team arrives, and says so through `hired`.
  };

  // The hire landed: the brief has become a team, so the form starts over.
  const firstHired = useRef(hired);
  useEffect(() => {
    if (hired === firstHired.current) return;
    firstHired.current = hired;
    discardDraft();
  }, [hired]);

  const branch = git?.branch ?? 'the current branch';
  const untracked = git?.dirty
    ? ` Your ${git.dirty} uncommitted ${git.dirty === 1 ? 'file' : 'files'} stay here — they will not see them.`
    : '';
  /**
   * What the chosen place means, as a sentence — with the number of rooms set
   * inside it rather than in a row of its own. A control that appears when you
   * pick an option pushes everything below it down; the same number written
   * into the line that explains it does not, and it reads better besides.
   */
  const placeFact =
    effectivePlace === 'here' ? (
      `They work in ${roomName} itself, at a bench beside your own agents. One job at a time — anything else you send waits its turn.`
    ) : effectivePlace === 'room' ? (
      `A folder of their own, branched off ${branch} and merged back each time a task is closed.${untracked}`
    ) : (
      <>
        <input
          className="ht__num"
          type="number"
          min={2}
          max={MAX_TEAM_LANES}
          value={lanes}
          aria-label="How many rooms at once"
          onChange={(e) => setLanes(Math.max(2, Math.min(MAX_TEAM_LANES, Number(e.target.value) || 2)))}
        />{' '}
        folders, each branched off {branch} with its own copy of the crew — {crew.length} each, {1 + crew.length * lanes} agents
        counting the lead — merged back as tasks close.
        {untracked}
      </>
    );
  const noBranchReason = git && !git.repo ? `${roomName} is not a git repository` : git && !git.commits ? `${roomName} has no commits yet` : null;

  const autonomyFact =
    autonomy === 'gated'
      ? 'Nothing reaches a member until you press Continue.'
      : autonomy === 'auto'
        ? 'They loop until a reviewer approves. Nothing stops them but you, so watch the cost meter.'
        : null;

  return (
    <form
      className="ht"
      hidden={!visible}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="ht__scroll">
        <div className="ht__col">
        <section className="ht__q ht__q--goal">
        <label className="ht__label" htmlFor="ht-task">
          What should they build?
        </label>
        {restored && task.trim() && (
          <p className="ht__restored" role="status">
            Picked up where you left off.
            <button type="button" className="ht__discard" onClick={discardDraft}>
              Discard draft
            </button>
          </p>
        )}
        <textarea
          id="ht-task"
          ref={taskRef}
          className="ht__task"
          rows={5}
          // Not a worked example. The old one was a plausible-looking ticket in
          // grey, which reads as content someone already wrote rather than as a
          // prompt — and it referred to "the table", which is nothing here.
          placeholder={'What do you want at the end? Add anything they must not break, and how you would know it worked.'}
          value={task}
          // A brief can be a whole ticket, spec or transcript; the lead reads it all.
          maxLength={500_000}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <p className="ht__hint">The lead reads the project itself, so it needs the goal — not a file-by-file plan.</p>

        </section>

        {/* ---- customize: crew, model, permissions, token saver ------------
            Three questions are enough to start a team; everything below this
            line is a default that can be changed, and is said back in one
            line while it stays closed. */}
        <section className="ht__q ht__q--custom">
          <button type="button" className="ht__disclose" aria-expanded={custom} onClick={() => setCustom((v) => !v)}>
            <span className={`ht__discloseArrow ${custom ? 'ht__discloseArrow--open' : ''}`} aria-hidden="true">
              ▸
            </span>
            <span className="ht__discloseLabel">Customize</span>
            <span className="ht__discloseSum">{customSummary}</span>
          </button>
        </section>

        {/* ---- the crew ---------------------------------------------------- */}
        <section className="ht__q ht__q--crew" hidden={!custom}>
        <div className="ht__head">
          <span className="ht__label">The crew</span>
          <PickerMenu
            className="ht__preset"
            value={presetId}
            options={[
              ...presets.map((p) => ({ value: p.id, label: p.name, hint: p.hint })),
              ...(presetId === 'custom' ? [{ value: 'custom', label: 'Custom', hint: 'Your own arrangement' }] : []),
            ]}
            onPick={(v) => {
              const p = presets.find((x) => x.id === v);
              if (p) applyPreset(p);
            }}
            placement="down"
            ariaLabel="Start from a ready-made crew"
          />
          {presetId === 'custom' && savingName === null && (
            <button type="button" className="ht__save" onClick={() => setSavingName('')}>
              Save this crew
            </button>
          )}
        </div>
        <div className="ht__crew">
          {roster.map((m, i) => (
            <button
              key={i}
              type="button"
              className={`ht__who ht__who--${m.kind} ${editing === i ? 'ht__who--on' : ''}`}
              aria-expanded={editing === i}
              aria-label={`${m.label || 'unnamed'} — ${does(m)}. Open settings.`}
              onClick={() => setEditing(editing === i ? null : i)}
            >
              <span className="ht__whoName">{m.label || '—'}</span>
              <span className="ht__whoDoes">{does(m)}</span>
            </button>
          ))}
          {roster.length < MAX_TEAM_MEMBERS && (
            <PickerMenu
              className="ht__add"
              value=""
              options={[
                { value: 'worker', label: 'Worker', hint: 'Does the work. Choose whether it may edit files.' },
                { value: 'reviewer', label: 'Reviewer', hint: 'Judges one change. Can never edit.' },
              ]}
              onPick={(v) => addMember(v as MemberKind)}
              placement="down"
              label={
                <>
                  <span className="ht__whoName">+ Add</span>
                  <span className="ht__whoDoes">worker or reviewer</span>
                </>
              }
              ariaLabel="Add someone to the crew"
            />
          )}
        </div>

        {editing !== null && roster[editing] && (
          <div className="ht__edit">
            <div className="ht__editRow">
              <input
                className="ht__name"
                value={roster[editing].label}
                maxLength={32}
                spellCheck={false}
                aria-label="Name"
                disabled={roster[editing].kind === 'lead'}
                onChange={(e) => setMember(editing, { label: e.target.value })}
              />
              {roster[editing].kind === 'worker' && (
                <div className="ht__seg" role="radiogroup" aria-label="What this member may do">
                  {[
                    [true, 'edits files'],
                    [false, 'reads only'],
                  ].map(([on, text]) => (
                    <button
                      key={String(on)}
                      type="button"
                      role="radio"
                      aria-checked={(roster[editing].writes !== false) === on}
                      className={`ht__segBtn ${(roster[editing].writes !== false) === on ? 'ht__segBtn--on' : ''}`}
                      onClick={() => setMember(editing, { writes: on as boolean })}
                    >
                      {text as string}
                    </button>
                  ))}
                </div>
              )}
              {roster[editing].kind !== 'lead' && (
                <button type="button" className="ht__drop" onClick={() => removeMember(editing)}>
                  Remove
                </button>
              )}
            </div>
            <textarea
              className="ht__note"
              rows={2}
              placeholder={
                roster[editing].kind === 'lead'
                  ? 'Standing instructions — e.g. check with me before anything schema-related'
                  : roster[editing].kind === 'reviewer'
                    ? 'Standing instructions — e.g. be strict about error handling and test coverage'
                    : 'Standing instructions — e.g. match the existing helpers, no new dependencies'
              }
              value={roster[editing].note ?? ''}
              maxLength={50_000}
              onChange={(e) => setMember(editing, { note: e.target.value })}
            />
            <div className="ht__editRow">
              <PickerMenu
                className={`cx__mode ht__rolePick ${roster[editing].mode ? 'cx__mode--on' : ''} ${roster[editing].mode === 'bypassPermissions' ? 'cx__mode--hot' : ''}`}
                value={roster[editing].mode ?? ''}
                options={[
                  { value: '', label: 'Team permissions', hint: 'Use the setting everyone else has' },
                  ...PERMISSION_MODES.map((p) => ({ value: p.value, label: p.label, hint: p.hint })),
                ]}
                onPick={(v) => setMember(editing, { mode: (v as PermissionMode) || undefined })}
                placement="down"
                label={roster[editing].mode ? undefined : 'team permissions'}
                ariaLabel="Permissions for this member only"
              />
              <PickerMenu
                className={`cx__model ht__rolePick ${roster[editing].model ? 'cx__mode--on' : ''}`}
                value={roster[editing].model ?? ''}
                options={modelOptions({ value: '', label: 'Team model', hint: 'Use the model everyone else has' })}
                onPick={(v) => setMember(editing, { model: v || undefined })}
                placement="down"
                label={models.find((x) => x.value === roster[editing].model)?.displayName ?? 'team model'}
                ariaLabel="Model for this member only"
              />
            </div>
          </div>
        )}
        {savingName !== null && (
          <div className="ht__saveRow">
            <input
              className="ht__name"
              autoFocus
              placeholder="Name this crew"
              maxLength={24}
              value={savingName}
              onChange={(e) => setSavingName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSavingName(null);
                if (e.key !== 'Enter' || !savingName.trim()) return;
                e.preventDefault();
                const p: TeamPreset = {
                  id: `saved-${Date.now().toString(36)}`,
                  name: savingName.trim(),
                  hint: 'Your own crew',
                  members: roster.map((m) => ({ ...m })),
                  lanes: effectivePlace === 'rooms' ? lanes : 1,
                };
                const next = [...saved, p];
                setSaved(next);
                saveSaved(next);
                setPresetId(p.id);
                setSavingName(null);
              }}
            />
            <button type="button" className="ht__drop" onClick={() => setSavingName(null)}>
              Cancel
            </button>
          </div>
        )}
        {clash && (
          <p className="ht__warn" role="alert">
            Two members would answer to the same name (<b>{clash}</b>). Give one of them a different one.
          </p>
        )}

        </section>

        {/* ---- where ------------------------------------------------------- */}
        <section className="ht__q ht__q--where">
        <div className="ht__head">
          <span className="ht__label">Where they work</span>
        </div>
        <div className="ht__opts" role="radiogroup" aria-label="Where they work">
          {(
            [
              ['here', 'In this folder', 'one job at a time'],
              ['room', 'A room of their own', 'their own branch'],
              ['rooms', 'Several rooms', 'jobs in parallel'],
            ] as const
          ).map(([id, title, sub]) => {
            const blocked = id !== 'here' && !!noBranchReason;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={effectivePlace === id}
                disabled={blocked}
                title={blocked ? `Not possible here: ${noBranchReason}.` : undefined}
                className={`ht__opt ${effectivePlace === id ? 'ht__opt--on' : ''}`}
                aria-label={`${title} — ${sub}`}
                onClick={() => setPlace(id)}
              >
                <span className="ht__optName">{title}</span>
                <span className="ht__optSub">{sub}</span>
              </button>
            );
          })}
        </div>
        <p className="ht__fact ht__after ht__after--place">
          {placeFact}
          {noBranchReason && place !== 'here' && <> A room of their own is not possible here: {noBranchReason}.</>}
        </p>

        </section>

        {/* ---- check-in ---------------------------------------------------- */}
        <section className="ht__q ht__q--auto">
        <div className="ht__head">
          <span className="ht__label">When they check in with you</span>
        </div>
        <div className="ht__opts" role="radiogroup" aria-label="When they check in with you">
          {TEAM_AUTONOMY_CHOICES.map((c) => {
            const blocked = c.value === 'auto' && !hasReviewer;
            return (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={autonomy === c.value}
                disabled={blocked}
                title={blocked ? 'This crew has no reviewer, so there is nobody to approve.' : c.hint}
                className={`ht__opt ${autonomy === c.value ? 'ht__opt--on' : ''}`}
                onClick={() => onDefaults({ teamAutonomy: c.value })}
              >
                <span className="ht__optName">{CHECKIN_TITLE[c.value]}</span>
                <span className="ht__optSub">
                  {blocked
                    ? 'needs a reviewer'
                    : c.value === 'auto_capped'
                      ? `${roundCap} fix ${roundCap === 1 ? 'round' : 'rounds'}`
                      : c.value === 'gated'
                        ? 'you allow each step'
                        : 'no limit'}
                </span>
              </button>
            );
          })}
        </div>
        <p className="ht__fact ht__after ht__after--autonomy">
          {autonomy === 'auto_capped' ? (
            <>
              They run by themselves, then stop and ask you after{' '}
              <input
                className="ht__num"
                type="number"
                min={0}
                max={10}
                value={roundCap}
                aria-label="Fix rounds before they check in"
                onChange={(e) => onDefaults({ teamRoundCap: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })}
              />{' '}
              {roundCap === 1 ? 'fix round' : 'fix rounds'} on a task.
            </>
          ) : (
            autonomyFact
          )}
        </p>

        </section>

        {/* ---- model ------------------------------------------------------- */}
        <section className="ht__q ht__q--model" hidden={!custom}>
        <div className="ht__head">
          <span className="ht__label">Everyone runs on</span>
        </div>
        <div className="ht__row">
            <PickerMenu
              className="cx__model"
              value={model}
              options={teamModelOptions}
              onPick={(v) => onDefaults({ teamModel: v })}
              placement="down"
              label={models.find((m) => m.value === model)?.displayName ?? 'Default'}
              ariaLabel="Model for every member of the team"
            />
            <PickerMenu
              className={`cx__mode ${mode !== 'default' ? 'cx__mode--on' : ''} ${mode === 'bypassPermissions' ? 'cx__mode--hot' : ''}`}
              value={mode}
              options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, hint: m.hint }))}
              onPick={(v) => onDefaults({ teamMode: v as PermissionMode })}
              placement="down"
              ariaLabel="How much the team may do without asking"
            />
        </div>
        {teamShaky && (
          <p className={`ht__localwarn ht__localwarn--${teamShaky.quality ?? 'fair'}`} role="note">
            <span className={`mm__q mm__q--${teamShaky.quality ?? 'fair'}`} aria-hidden="true" />
            <b>{teamShaky.displayName}</b> is a local model that {QUALITY_LABEL[teamShaky.quality ?? 'fair']}. Teams need a
            lead that reliably calls its tools to assign, review and finish — below the strong tier, expect stalls and
            re-briefs. You can still hire; airoom will nudge and park as usual.
          </p>
        )}
        <label className="ht__thrift">
          <input type="checkbox" checked={thrift} onChange={(e) => setThrift(e.target.checked)} />
          <span>
            <b>Token saver</b> — fewer turns, shorter reports, search before reading. Same tests, same
            standard for the work; less spent getting there.
          </span>
        </label>
        <p className="ht__fact">
          Every member runs on this model, and{' '}
          {mode === 'bypassPermissions'
            ? 'may use any tool without asking you — including writing files and running commands.'
            : mode === 'plan'
              ? 'may only read and plan; nothing is written until you say so.'
              : mode === 'acceptEdits'
                ? 'may edit files on its own, but still asks before running commands.'
                : 'asks you before anything it is not already allowed to do.'}{' '}
          Separate from the check-in rule above: that decides when they pause for you, this decides what they may touch.
        </p>
        </section>
        </div>
      </div>

      {/* The whole thing said back before you commit to it. */}
      <div className="ht__foot">
        <div className="ht__col">
        <p className="ht__summary">
          <b>{agentCount} agents</b>
          {effectivePlace === 'rooms'
            ? ` — ${roster[0].label}, plus ${lanes} crews of ${sentenceList(crew.map((m) => m.label))}.`
            : ` — ${sentenceList(roster.map((m) => m.label))}.`}{' '}
          {effectivePlace === 'here'
            ? `Working in ${roomName}.`
            : effectivePlace === 'room'
              ? `In a room of their own off ${roomName}.`
              : `In ${lanes} rooms off ${roomName}.`}{' '}
          {autonomy === 'gated'
            ? 'Every handoff waits for you.'
            : autonomy === 'auto'
              ? 'Running until a reviewer approves.'
              : `Checking in after ${roundCap} fix ${roundCap === 1 ? 'round' : 'rounds'}.`}{' '}
          {hasReviewer ? 'A reviewer reads every change before a task closes.' : 'No reviewer, so nothing is checked before a task closes.'}{' '}
          {mode === 'bypassPermissions'
            ? 'Tools run without asking you.'
            : mode === 'plan'
              ? 'They only read and plan.'
              : mode === 'acceptEdits'
                ? 'Edits go through on their own; commands ask first.'
                : 'Every tool asks you first.'}
          {thrift ? ' Token saver on.' : ''}
        </p>
        <button className="ht__go" type="submit" disabled={!ready}>
          Hire the team
        </button>
        {whyNot && (
          <p className="ht__why" role="status">
            {whyNot}
          </p>
        )}
        </div>
      </div>
    </form>
  );
}
