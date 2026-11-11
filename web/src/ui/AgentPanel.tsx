import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from './useFocusTrap';
import { createPortal } from 'react-dom';
import type { RoleNotes, TeamAutonomy, TeamRole, ImageAttachment, Robot, RobotStatus, RunUpdate, Step } from '@shared/types';
import {
  PERMISSION_MODES,
  type AgentSkills,
  type CommandChoice,
  type ModelChoice,
  type PermissionMode,
  type SkillChoice,
} from '@shared/types';
import { STATUS_COLOR } from '../render/draw';
import type { RunState } from '../net/useFleet';
import { Blk, Markdown } from './Markdown';
import { HireTeam, type HirePayload } from './HireTeam';
import { PickerMenu } from './PickerMenu';
import { API_BASE } from '../net/base';
import { defaultAgentName } from '../names';
import { splitToolLabel, toolMeta } from './toolMeta';

interface Props {
  robot: Robot | null; // null = "+ new" mode for roomId — pick an agent or a team
  roomId: string;
  /** "+ new" mode only: which kind of hire the panel is showing. */
  hireMode: 'agent' | 'team';
  /** For a team member: what the team actually runs this member with. The
   *  composer starts here rather than at the app's defaults. */
  memberMode?: PermissionMode;
  memberModel?: string;
  /** Bumped when a team hired from this panel has been seated. */
  teamHired: number;
  onHireMode: (mode: 'agent' | 'team') => void;
  /** "+ new" + team: the room's remembered autonomy defaults, and the hire. */
  teamAutonomy: TeamAutonomy;
  teamRoundCap: number;
  teamMode: PermissionMode;
  teamModel: string;
  canHire: boolean;
  /** "+ new" + agent: what a hire here could carry (answer to onListSkills). */
  skillChoices: SkillChoice[];
  onListSkills: () => void;
  /** Write a new user-level skill from the hire form. Returns delivery. */
  onCreateSkill: (name: string, description: string, body: string) => boolean;
  onTeamDefaults: (patch: {
    teamAutonomy?: TeamAutonomy;
    teamRoundCap?: number;
    teamMode?: PermissionMode;
    teamModel?: string;
  }) => void;
  onHireTeam: (payload: HirePayload) => void;
  /** This agent is on a team: what it is called there, and the team's state.
   *  The chip in the header is the way from a member's chat to the team. */
  team?: { label: string; state: string } | null;
  onOpenTeam?: () => void;
  /** This agent is a playbook run: which card, and the way to it. */
  playbook?: { id: string; runId: string; name: string } | null;
  onOpenPlaybook?: () => void;
  /** "Make this a playbook" — read this session into a card. */
  onMakePlaybook?: () => void;
  /** A correction the human chose to keep for future runs of the playbook. */
  onRemember?: (text: string) => void;
  /** Let this agent go (desk freed, transcript kept) or delete it for real. */
  onLetGo: () => void;
  onDelete: () => void;
  /** Rename this agent ('' goes back to the default callsign). */
  onNameAgent: (name: string) => void;
  roomName: string;
  accent: string; // the room's own accent — the panel wears the room it opened from
  transcript: { sessionId: string; steps: Step[]; hasMore: boolean } | null;
  loadingMore?: boolean;
  run?: RunState;
  onSubscribe: (sessionId: string) => void;
  onLoadMore: () => void;
  onNotice: (text: string, isError?: boolean) => void;
  /** Returns whether the message actually reached the server. */
  models: ModelChoice[];
  commands: CommandChoice[];
  /** A local model was picked — load it now, check its runtime window. */
  onWarmLocal?: (model: string) => void;
  onSend: (
    text: string,
    mode: PermissionMode,
    model: string,
    images: ImageAttachment[],
    fast: boolean,
    budgetUsd: number,
    skills?: AgentSkills,
    agentName?: string,
  ) => boolean;
  onInterrupt: () => void;
  onPermission: (requestId: string, allow: boolean, always?: boolean) => void;
  /** Change the live run's mode without interrupting its turn. */
  onSetMode: (mode: PermissionMode) => void;
  onSetFastMode: (fast: boolean) => void;
  /** Ask what a rewind would change (dryRun), or carry it out. */
  onRewind: (userMessageId: string, dryRun: boolean) => void;
  rewind: {
    userMessageId: string;
    dryRun: boolean;
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  } | null;
  onClearRewind: () => void;
  onClearRun: () => void;
  onClose: () => void;
  /** Rendered inside the dock beside the office: no focus trap, not modal. */
  docked?: boolean;
}

interface ChatItem {
  id: string; // stable — never an array index, or open code blocks jump around
  kind: 'user' | 'agent' | 'tool' | 'error' | 'marker';
  text: string;
  ts?: string | null;
  /** marker items: the numbers under the divider ("977k → 8k tokens"). */
  detail?: string;
  /** user items: attached images. With srcs they render as thumbnails; with
   *  only a count they fall back to a chip. */
  images?: number;
  imageDims?: string;
  imageSrcs?: string[];
  toolUseId?: string; // shared by a live tool call and its transcript twin
  tool?: { name: string; target: string };
  truncated?: boolean;
  /** tool items: what the tool actually printed, folded under the call. */
  output?: { text: string; isError?: boolean; truncated?: boolean };
  /** agent items: still arriving, so the text is paced rather than dumped. */
  streaming?: boolean;
}

type Block =
  | { kind: 'ops'; id: string; items: ChatItem[] }
  | { kind: 'item'; item: ChatItem; prevTs?: string | null };

/** Built-in Claude Code commands worth a place in a GUI. The runtime executes
 *  them when sent as the message text; the answer comes back as a local
 *  command output, which the server relays as agent text. */
const BUILTIN_COMMANDS: CommandChoice[] = [
  { name: 'compact', description: 'Summarize this conversation into a fresh context — frees the window when it fills up' },
  { name: 'context', description: "Show what's filling this agent's context window" },
  { name: 'cost', description: 'Show what this session has spent' },
];

/** How a local model's grade reads in the pickers and the composer note. */
const QUALITY_LABEL: Record<NonNullable<ModelChoice['quality']>, string> = {
  strong: 'works well',
  fair: 'works for small tasks',
  weak: 'struggles with agents',
  unfit: "can't drive agents",
};

const STATE_LABEL: Record<RobotStatus, string> = {
  working: 'working',
  waiting_input: 'your move',
  idle: 'idle',
  error: 'error',
  done: 'done',
};

/** Consecutive tool calls collapse into one cluster — the audit trail, folded. */
function groupItems(items: ChatItem[]): Block[] {
  const blocks: Block[] = [];
  let lastTs: string | null | undefined;
  for (const it of items) {
    if (it.kind === 'tool') {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'ops') last.items.push(it);
      else blocks.push({ kind: 'ops', id: `ops-${it.tool ? (it.toolUseId ?? it.id) : it.id}`, items: [it] });
    } else {
      blocks.push({ kind: 'item', item: it, prevTs: lastTs });
      if (it.ts) lastTs = it.ts;
    }
  }
  return blocks;
}

function stepsToChat(steps: Step[], sessionId?: string): ChatItem[] {
  const items: ChatItem[] = [];
  steps.forEach((s) => {
    if (!s.label?.trim() && !s.images) return; // never render empty husks
    // s.id is minted by the parser from the record's uuid — stable even though
    // the server serves a sliding window, so nothing remounts on refresh
    const id = s.id;
    if (s.kind === 'user')
      items.push({
        id,
        kind: 'user',
        text: s.label,
        ts: s.ts,
        truncated: s.truncated,
        images: s.images,
        imageDims: s.imageDims,
        imageSrcs:
          sessionId && s.imageRefs?.length
            ? s.imageRefs.map((r) => `${API_BASE}/session-image?session=${encodeURIComponent(sessionId)}&ref=${encodeURIComponent(r.id)}`)
            : undefined,
      });
    else if (s.kind === 'assistant_text')
      items.push({ id, kind: 'agent', text: s.label, ts: s.ts, truncated: s.truncated });
    else if (s.kind === 'tool_use')
      items.push({ id, kind: 'tool', text: s.label, ts: s.ts, toolUseId: s.toolUseId, tool: s.tool });
    else if (s.kind === 'system') items.push({ id, kind: 'error', text: s.label, ts: s.ts });
    else if (s.kind === 'marker') items.push({ id, kind: 'marker', text: s.label, ts: s.ts, detail: s.detail });
    else if (s.kind === 'tool_result' && s.detail) {
      // Attach the output to the call it answers. Dropping these was why the
      // chat could say an agent ran the tests but never what they printed.
      const call = s.toolUseId
        ? [...items].reverse().find((it) => it.kind === 'tool' && it.toolUseId === s.toolUseId)
        : [...items].reverse().find((it) => it.kind === 'tool' && !it.output);
      if (call) call.output = { text: s.detail, isError: s.isError, truncated: s.truncated };
    }
    // thinking stays out of the chat view
  });
  return items;
}

/**
 * Is this user message really pasted output rather than prose? Logs and stack
 * traces get a code surface instead of a message body — otherwise a single
 * paste becomes several screens of coloured slab and buries the conversation.
 */
function isPasted(text: string): boolean {
  const lines = text.split('\n');
  // Prose is common and multi-paragraph; only treat content as OUTPUT when it
  // either looks like a log or is far past anything anyone types by hand.
  if (lines.length > 30 || text.length > 3000) return true;
  if (lines.length < 5) return false;
  const logish = lines.filter((l) =>
    /^\s*(at\s|\[|>|\$|#|\+|-|\||\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|npm |yarn |ERROR|WARN|Error:|Traceback|\w+Error\b|✓|✔|✗|×)/.test(l),
  ).length;
  return logish >= lines.length * 0.6;
}

/** Clipboard writes can be refused (permissions, no user gesture). Report the
 *  truth so callers never claim "copied" when nothing was. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-agent model preference. Stored as one map so a fleet of agents can each
 * run on a different model, and a corrupt/legacy value can never throw.
 */
const MODEL_STORE = 'airoom.models.v1';
function readModelPref(key: string): string {
  try {
    const all = JSON.parse(localStorage.getItem(MODEL_STORE) ?? '{}');
    const v = all?.[key];
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}
function writeModelPref(key: string, value: string) {
  try {
    const all = JSON.parse(localStorage.getItem(MODEL_STORE) ?? '{}');
    localStorage.setItem(MODEL_STORE, JSON.stringify({ ...(all ?? {}), [key]: value }));
  } catch {
    /* storage full or blocked — the picker still works for this session */
  }
}

/**
 * Is this the same model?
 *
 * airoom stores "no preference" as '', while the runtime calls that same choice
 * 'default'. Comparing them raw meant the default row never got its tick and
 * `current` fell back to models[0] by accident — which also hid the fast-mode
 * toggle, since that reads `current.supportsFastMode`.
 */
const sameModel = (a: string | undefined, b: string | undefined) =>
  (a || 'default') === (b || 'default');

const FAST_STORE = 'airoom.fast.v1';
function readFlagPref(key: string): boolean {
  try {
    return JSON.parse(localStorage.getItem(FAST_STORE) ?? '{}')?.[key] === true;
  } catch {
    return false;
  }
}
function writeFlagPref(key: string, value: boolean) {
  try {
    const all = JSON.parse(localStorage.getItem(FAST_STORE) ?? '{}');
    localStorage.setItem(FAST_STORE, JSON.stringify({ ...(all ?? {}), [key]: value }));
  } catch {
    /* non-fatal */
  }
}

/** Move a ghost desk's choices onto the session it just created, without
 *  overwriting anything already chosen for that session. */
function migratePrefs(from: string, to: string) {
  for (const store of [MODEL_STORE, FAST_STORE, MODE_STORE]) {
    try {
      const all = JSON.parse(localStorage.getItem(store) ?? '{}') ?? {};
      if (all[from] === undefined || all[to] !== undefined) continue;
      all[to] = all[from];
      delete all[from];
      localStorage.setItem(store, JSON.stringify(all));
    } catch {
      /* non-fatal */
    }
  }
}


/**
 * The room's remembered hire loadout. Keyed by ROOM, not session: a loadout is
 * chosen at the ghost desk, and the next hire in the same room almost always
 * wants the same equipment.
 */
const SKILLS_STORE = 'airoom.hireskills.v1';
function readSkillsPref(roomId: string): AgentSkills {
  try {
    const v = JSON.parse(localStorage.getItem(SKILLS_STORE) ?? '{}')?.[roomId];
    if (v && Array.isArray(v.skills)) return { skills: v.skills, specialist: !!v.specialist };
  } catch {
    /* fall through */
  }
  return { skills: [] };
}
function writeSkillsPref(roomId: string, value: AgentSkills) {
  try {
    const all = JSON.parse(localStorage.getItem(SKILLS_STORE) ?? '{}') ?? {};
    if (value.skills.length) all[roomId] = value;
    else delete all[roomId];
    localStorage.setItem(SKILLS_STORE, JSON.stringify(all));
  } catch {
    /* non-fatal */
  }
}

const MODE_STORE = 'airoom.modes.v1';
function readModePref(key: string): PermissionMode {
  try {
    const all = JSON.parse(localStorage.getItem(MODE_STORE) ?? '{}');
    const v = all?.[key];
    return PERMISSION_MODES.some((m) => m.value === v) ? (v as PermissionMode) : 'default';
  } catch {
    return 'default';
  }
}
function writeModePref(key: string, value: PermissionMode) {
  try {
    const all = JSON.parse(localStorage.getItem(MODE_STORE) ?? '{}');
    localStorage.setItem(MODE_STORE, JSON.stringify({ ...(all ?? {}), [key]: value }));
  } catch {
    /* non-fatal */
  }
}

/** Paths keep their tail (the filename is what you're looking for); commands
 *  keep their head. Everything else truncates in CSS, at the row's real width. */
function shortTarget(target: string): string {
  if (!target) return '';
  const isPath = /^[~/.]|\//.test(target) && !/\s/.test(target);
  if (isPath && target.length > 46) return `…${target.slice(-45)}`;
  return target;
}

/** Dismisses the "files reverted" receipt after a beat. Renders nothing. */
function RewindAutoClose({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 8000);
    return () => clearTimeout(t);
  }, [onDone]);
  return null;
}

/**
 * What an approval would actually DO.
 *
 * A bare file path is not consent: the one control that authorizes code against
 * your filesystem has to show the change. Edits render as a diff, a write as the
 * body it would create, a command as the command. Falls back to the target when
 * a tool exposes nothing useful.
 */
function GateContent({ tool, label }: { tool: RunUpdate['tool']; label: string }) {
  const input = (tool?.input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');

  const oldText = str('old_string');
  const newText = str('new_string');
  if (oldText || newText) {
    return (
      <div className="gate__diff">
        {oldText && (
          <pre className="gate__diff--del">
            {oldText.split('\n').map((l, i) => (
              <div key={i}>- {l}</div>
            ))}
          </pre>
        )}
        {newText && (
          <pre className="gate__diff--add">
            {newText.split('\n').map((l, i) => (
              <div key={i}>+ {l}</div>
            ))}
          </pre>
        )}
      </div>
    );
  }
  const content = str('content');
  if (content) return <Blk code={content} label="new file" clampLines={16} />;
  const command = str('command');
  if (command) return <pre className="gate__cmd">{command}</pre>;
  const prompt = str('prompt') || str('plan');
  if (prompt) return <div className="gate__plan"><Markdown text={prompt} /></div>;
  return <pre className="gate__cmd">{tool?.target || label}</pre>;
}

function ToolRow({ item, term }: { item: ChatItem; term?: boolean }) {
  const { name, target } = item.tool ?? splitToolLabel(item.text);
  const { Icon, color } = toolMeta(name);
  const out = item.output;
  // A failure is the one thing you always want to read, so it opens itself.
  const [open, setOpen] = useState(!!out?.isError);
  // Terminal view: a collapsed output shows as a dim "└ …" echo of its first
  // line — same state, same toggle, denser clothes.
  const echo = term && out && !open ? (out.text.split('\n').find((l) => l.trim()) ?? '').slice(0, 160) : null;
  return (
    <li className={`op ${out ? 'op--has-out' : ''} ${out?.isError ? 'op--failed' : ''}`}>
      <div
        className="op__row"
        title={target ? `${name} ${target}` : name}
        onClick={out ? () => setOpen((v) => !v) : undefined}
        role={out ? 'button' : undefined}
        tabIndex={out ? 0 : undefined}
        onKeyDown={
          out
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpen((v) => !v);
                }
              }
            : undefined
        }
      >
        <span className="op__icon" style={{ color }}>
          <Icon />
        </span>
        <span className="op__name">{name}</span>
        <span className="op__target">{shortTarget(target)}</span>
        {out && <span className="op__more">{open ? '▾' : '▸'}</span>}
      </div>
      {echo !== null && (
        <div
          className="op__echo"
          role="button"
          tabIndex={0}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          └ {echo || 'output'}
        </div>
      )}
      {out && open && (
        <div className="op__out">
          <Blk code={out.text} label={out.isError ? 'failed' : 'output'} clampLines={14} />
          {out.truncated && <div className="ev__cut">output truncated by airoom</div>}
        </div>
      )}
    </li>
  );
}

/** A folded run of tool calls. Collapsed by default — the prose is the
 *  conversation, the steps are its receipts. A cluster holding a FAILED step
 *  opens itself, because a failure is the one receipt you always read. */
function Ops({ items, term }: { items: ChatItem[]; term?: boolean }) {
  const [open, setOpen] = useState(() => items.some((it) => it.output?.isError));
  const tally = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) {
      const n = (it.tool ?? splitToolLabel(it.text)).name;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
      .join(' · ');
  }, [items]);

  return (
    <section className="ops" data-open={open ? 'true' : 'false'}>
      <button className="ops__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="ops__caret">{open ? '▾' : '▸'}</span>
        <span className="ops__n">
          {items.length} {items.length === 1 ? 'step' : 'steps'}
        </span>
        <span className="ops__tally">{tally}</span>
      </button>
      {open && (
        <ol className="ops__list">
          {items.map((it) => (
            <ToolRow key={it.id} item={it} term={term} />
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * The conversation panel: the transcript as a thread, live run output merged at
 * the bottom, inline tool approvals, and a composer that never locks — sending
 * while the agent works queues into the running turn (steering).
 */
export function AgentPanel({
  robot,
  roomId,
  hireMode,
  teamHired,
  memberMode,
  memberModel,
  onHireMode,
  teamAutonomy,
  teamRoundCap,
  teamMode,
  teamModel,
  canHire,
  skillChoices,
  onListSkills,
  onCreateSkill,
  onTeamDefaults,
  onHireTeam,
  team,
  onOpenTeam,
  playbook,
  onOpenPlaybook,
  onMakePlaybook,
  onRemember,
  onLetGo,
  onDelete,
  onNameAgent,
  roomName,
  accent,
  transcript,
  loadingMore,
  run,
  models,
  commands,
  onWarmLocal,
  onSubscribe,
  onLoadMore,
  onNotice,
  onSend,
  onInterrupt,
  onPermission,
  onSetMode,
  onSetFastMode,
  onRewind,
  rewind,
  onClearRewind,
  onClearRun,
  onClose,
  docked = false,
}: Props) {
  const trapRef = useFocusTrap<HTMLElement>(!docked);
  const [draft, setDraft] = useState('');
  /** How the conversation reads: the reading view, or the terminal stream.
   *  A presentation taste, so it is one global preference — not per agent. */
  const [view, setView] = useState<'chat' | 'term'>(() => {
    try {
      return localStorage.getItem('airoom.view.v1') === 'term' ? 'term' : 'chat';
    } catch {
      return 'chat';
    }
  });
  const pickView = (v: 'chat' | 'term') => {
    setView(v);
    try {
      localStorage.setItem('airoom.view.v1', v);
    } catch {
      /* taste just won't persist */
    }
  };
  const term = view === 'term';
  const [mode, setModeState] = useState<PermissionMode>(memberMode ?? 'default');
  // Model is a property of THIS agent, not of the app. One shared key meant
  // picking Opus for a hard task silently pinned Opus on every robot in the
  // office — real money, spent by a control that claimed to be per-agent.
  const modelKey = robot?.sessionId ?? `room:${roomId}`;
  /**
   * A hire's settings are chosen at the ghost desk, where the only key we have
   * is the room. The moment its session exists the panel re-keys — and used to
   * find nothing, silently snapping model, mode and fast back to defaults for
   * the very next message. Carry them across once.
   */
  useEffect(() => {
    if (!robot?.sessionId) return;
    const from = `room:${roomId}`;
    migratePrefs(from, robot.sessionId);
  }, [robot?.sessionId, roomId]);
  const [model, setModel] = useState(() => memberModel ?? readModelPref(modelKey));
  // A team member's settings live on the server, which is also told when they
  // change here — so following them keeps the picker honest both ways.
  useEffect(() => setModel(memberModel ?? readModelPref(modelKey)), [modelKey, memberModel]);
  // Mode is per-agent too, and for the same reason: it lived in component state
  // on a panel remounted per desk, so it silently snapped back to "asks first"
  // every time you looked at another robot.
  useEffect(() => setModeState(memberMode ?? readModePref(modelKey)), [modelKey, memberMode]);
  const [fast, setFastState] = useState(false);
  useEffect(() => setFastState(readFlagPref(modelKey)), [modelKey]);
  const changeFast = (next: boolean) => {
    setFastState(next);
    writeFlagPref(modelKey, next);
    onSetFastMode(next);
  };
  const pickModel = (value: string) => {
    if (value.startsWith('ollama/')) onWarmLocal?.(value);
    setModel(value);
    writeModelPref(modelKey, value);
    setModelMenu(false);
    setMoreOpen(false);
  };
  // Per-agent spend ceiling for one turn. 0 = uncapped.
  // ---- skill loadout (hiring an agent) ----
  const [loadout, setLoadout] = useState<AgentSkills>(() => readSkillsPref(roomId));
  useEffect(() => setLoadout(readSkillsPref(roomId)), [roomId]);
  const [skillsMenu, setSkillsMenu] = useState(false);
  // Fetched when the ghost desk opens — a hire form offering "no skills"
  // because nobody asked the server would be a quiet lie.
  useEffect(() => {
    if (!robot) onListSkills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robot?.sessionId, roomId]);
  const changeLoadout = (next: AgentSkills) => {
    setLoadout(next);
    writeSkillsPref(roomId, next);
  };
  /** One control, no sub-menus: off → granted → pinned → off. */
  const cycleSkill = (c: SkillChoice) => {
    const cur = loadout.skills.find((s) => s.path === c.path);
    const skills = !cur
      ? [...loadout.skills, { path: c.path, name: c.name, pin: false }]
      : cur.pin
        ? loadout.skills.filter((s) => s.path !== c.path)
        : loadout.skills.map((s) => (s.path === c.path ? { ...s, pin: true } : s));
    changeLoadout({ ...loadout, skills });
  };
  // ---- writing a NEW skill from the hire form ----
  const [creating, setCreating] = useState(false);
  /**
   * Where the ⛭ button sits. The menu renders through a PORTAL onto <body>:
   * the compact hire modal is centred with a transform, which makes it the
   * containing block for any positioned child — a dropdown taller than the
   * modal was simply clipped at its edge, with most of the library
   * unreachable. Measured when the menu opens and again just after (the modal
   * animates in, and a rect read mid-animation anchors the menu to a position
   * the button was only passing through), plus on resize.
   */
  const [skillsAt, setSkillsAt] = useState<{ left: number; top: number } | null>(null);
  const skillsBtnRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (!skillsMenu) return;
    const place = () => {
      const r = skillsBtnRef.current?.getBoundingClientRect();
      if (r) setSkillsAt({ left: r.left, top: r.top });
    };
    place();
    const settle = setTimeout(place, 220);
    window.addEventListener('resize', place);
    return () => {
      clearTimeout(settle);
      window.removeEventListener('resize', place);
    };
  }, [skillsMenu]);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newBody, setNewBody] = useState('');
  const [pendingCreate, setPendingCreate] = useState<string | null>(null);
  const saveNewSkill = () => {
    if (!newName.trim() || !newBody.trim()) return;
    if (!onCreateSkill(newName, newDesc, newBody)) return;
    // The server answers with a refreshed list; when the new skill appears in
    // it, grant it automatically — you wrote it for THIS hire, after all.
    setPendingCreate(
      newName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60),
    );
    setCreating(false);
    setNewName('');
    setNewDesc('');
    setNewBody('');
  };
  useEffect(() => {
    if (!pendingCreate) return;
    const hit = skillChoices.find((c) => c.name === pendingCreate);
    if (!hit) return;
    setPendingCreate(null);
    if (!loadout.skills.some((s) => s.path === hit.path))
      changeLoadout({ ...loadout, skills: [...loadout.skills, { path: hit.path, name: hit.name, pin: false }] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillChoices, pendingCreate]);

  const [modelMenu, setModelMenu] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // No stored preference means "whatever the runtime recommends", which is the
  // first row — so the tick lands on it instead of on nothing.
  const current = models.find((m) => sameModel(m.value, model)) ?? models[0];
  const primary = models.filter((m) => m.primary && m.provider !== 'ollama');
  const more = models.filter((m) => !m.primary && m.provider !== 'ollama');
  const local = models.filter((m) => m.provider === 'ollama');
  /** The chosen model when it is a local one — its grade rides into the composer. */
  const localPick = current?.provider === 'ollama' ? current : null;

  const changeMode = (next: PermissionMode) => {
    setModeState(next);
    writeModePref(modelKey, next);
    onSetMode(next); // takes effect on the running turn, not just the next one
  };
  const [shots, setShots] = useState<ImageAttachment[]>([]); // pasted/dropped images
  const [dragging, setDragging] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [pinned, setPinned] = useState(true);
  /** A clicked thumbnail, shown full-size over the panel until dismissed. */
  const [lightbox, setLightbox] = useState<string | null>(null);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setLightbox(null);
    };
    // capture: the world's own Escape closes the panel; the lightbox must win.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [lightbox]);
  const threadRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false); // IME: never send on the Enter that commits a candidate
  // When older messages prepend, the browser keeps scrollTop — which means the
  // view jumps backwards by exactly the height that was added. Remember the
  // distance from the BOTTOM instead, and restore it after the paint.
  // Where the reader was before a page of history was prepended: distance from
  // the bottom (invariant under prepending) plus the height it was measured
  // against, so the restore can tell "not laid out yet" from "already applied".
  const anchorRef = useRef<{ fromBottom: number; prevHeight: number } | null>(null);
  // A session opened in Claude Code is now driven from two places; remember
  // that locally, because a terminal sitting idle looks like nothing at all
  // from the transcript's point of view.
  const [handedOff, setHandedOff] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false); // double-drive guard armed
  /**
   * A message to a playbook run is either for this run or a rule from now
   * on. The choice is made per message, in the open, and never assumed: a
   * correction that quietly rewrote the card would be the hidden state this
   * feature exists to avoid. Off by default; resets after each send.
   */
  const [remember, setRemember] = useState(false);
  useEffect(() => setRemember(false), [robot?.sessionId]);

  useEffect(() => {
    if (robot) onSubscribe(robot.sessionId);
  }, [robot?.sessionId, onSubscribe]); // eslint-disable-line react-hooks/exhaustive-deps

  // Composer grows with its content, up to a cap.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(200, ta.scrollHeight)}px`;
  }, [draft]);

  // Opening a desk should land you at the newest message, focused and ready.
  useEffect(() => {
    setPinned(true);
    setMetaOpen(false);
    setShots([]);
    setConfirmSend(false);
    setHandedOff(
      !!robot && Date.now() - Number(localStorage.getItem(`airoom.handoff.${robot.sessionId}`) ?? 0) < 30 * 60_000,
    );
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    taRef.current?.focus();
  }, [robot?.sessionId, roomId]);

  const busy = !!run?.active;

  // The session is being driven by something that isn't airoom (a terminal).
  const liveExternal =
    !!robot && robot.status === 'working' && !busy && !robot.currentAction.includes('airoom');
  // Either signal means the session may have another writer: it is visibly
  // being driven elsewhere, or we handed it to Claude Code ourselves.
  const doubleDrive = liveExternal || handedOff;

  const historyItems = useMemo(() => {
    if (!robot) return [];
    const steps =
      transcript && transcript.sessionId === robot.sessionId ? transcript.steps : robot.recentSteps;
    return stepsToChat(steps, robot.sessionId);
  }, [robot, transcript]);

  const liveItems: ChatItem[] = useMemo(
    () =>
      (run?.thread ?? [])
        .filter((t) => t.text.trim() || t.images)
        .map((t) => ({
          id: t.id,
          kind: t.kind,
          text: t.text,
          images: t.images,
          imageSrcs: t.imageSrcs,
          toolUseId: t.toolUseId,
          tool: t.tool,
          streaming: t.streaming,
        })),
    [run?.thread],
  );

  // Continuous reconciliation in useFleet removes anything the transcript
  // shows; once a run is fully over, sweep any stragglers after a beat.
  useEffect(() => {
    if (run && !run.active && run.thread.length > 0) {
      const t = setTimeout(onClearRun, 2500);
      return () => clearTimeout(t);
    }
  }, [run, onClearRun]);

  const items = useMemo(() => [...historyItems, ...liveItems], [historyItems, liveItems]);
  const blocks = useMemo(() => groupItems(items), [items]);

  // Stay glued to the newest message ONLY while the user is already at the
  // bottom — never yank the view while they're reading history.
  /**
   * Put the reader back where they were after older messages are prepended.
   *
   * The anchor is a distance from the BOTTOM, which is invariant under
   * prepending — but it can only be applied once the new content has real
   * height. A page of history is tens of thousands of pixels that markdown and
   * code blocks do not finish laying out within the commit that added them, so
   * restoring immediately computed against the old height and pinned the reader
   * to the very top of the conversation instead. Hold the anchor until the
   * thread has actually grown, and let the resize observer below finish the job.
   */
  const restoreAnchor = (el: HTMLElement): boolean => {
    const a = anchorRef.current;
    if (!a) return false;
    if (el.scrollHeight <= a.prevHeight) return true; // not laid out yet — keep waiting
    el.scrollTop = Math.max(0, el.scrollHeight - a.fromBottom);
    anchorRef.current = null;
    return true;
  };

  // Stay glued to the newest message ONLY while the user is already at the
  // bottom — never yank the view while they're reading history.
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (restoreAnchor(el)) return;
    if (pinned) el.scrollTop = el.scrollHeight;
  }, [items.length, busy, run?.pendingPermission, pinned]);

  // The thread can shrink under you — a growing composer or an approval gate
  // pushes the newest message out of sight. Keep the bottom glued while pinned.
  useEffect(() => {
    const el = threadRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      // A pending anchor wins: this is the callback that fires once the
      // prepended history finally has its true height.
      if (restoreAnchor(el)) return;
      if (pinned) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    // Observing the scroller alone is not enough — its own box never changes
    // when content is added inside it. The column is what actually grows.
    const col = el.firstElementChild;
    if (col) ro.observe(col);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned]);

  const canLoadMore = !!robot && !!transcript?.hasMore && !loadingMore;

  const onScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    setPinned(atBottom);
    // near the top and there's more history → fetch the next page
    if (el.scrollTop < 220 && canLoadMore) {
      anchorRef.current = { fromBottom: el.scrollHeight - el.scrollTop, prevHeight: el.scrollHeight };
      onLoadMore();
    }
  };

  const jumpToNewest = () => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setPinned(true);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text && shots.length === 0) return;
    // Two live writers append to the same transcript and the conversation can
    // interleave. Make that a deliberate choice rather than a silent hazard.
    if (doubleDrive && !confirmSend) {
      setConfirmSend(true);
      return;
    }
    // Keep the draft unless it was delivered. Clearing first meant a send
    // attempted while the socket was down destroyed the typed text and any
    // pasted images — which live only in memory and cannot be recovered.
    // A hire carries its loadout on the first message; the server pins it to
    // the session that spawns. Follow-ups never re-send it.
    const hiring = !robot && hireMode === 'agent';
    const hireSkills = hiring && loadout.skills.length ? loadout : undefined;
    // 0 = no spend cap. There is no control for this — see the "NO SPEND CAP"
    // note below — so the value is fixed rather than read from a store nothing
    // writes.
    if (!onSend(text, mode, model, shots, fast, 0, hireSkills, hiring ? hireName.trim() || undefined : undefined))
      return;
    // Delivered. If this correction is to hold for every future run, it goes
    // on the card now — as a visible rule, not as a silent change.
    if (remember && playbook && onRemember && text) {
      onRemember(text);
      setRemember(false);
    }
    setHireName('');
    setConfirmSend(false);
    onClearRewind(); // a new turn supersedes any revert card still on screen
    setDraft('');
    setShots([]);
    setPinned(true);
  };

  /**
   * Continue this exact session in Claude Code. airoom drives the user's own
   * claude binary with `resume`, so the transcript on disk IS this session —
   * the terminal picks it up mid-conversation with full history.
   */
  const openInClaudeCode = async () => {
    const native = window.airoomNative?.openInClaudeCode;
    if (native) {
      const res = await native(roomId, robot?.sessionId);
      if (res.ok) {
        markHandoff();
        onNotice('Opened in Claude Code — this session is now live in both places');
      } else {
        onNotice(res.error ?? 'Could not open a terminal', true);
      }
      return;
    }
    // Browser: no way to spawn a terminal — hand over the command instead.
    const cmd = robot
      ? `cd ${JSON.stringify(roomId)} && claude --resume ${robot.sessionId}`
      : `cd ${JSON.stringify(roomId)} && claude`;
    // Only claim success if the write actually happened: clipboard access can be
    // denied, and a false "copied" would leave the user with nothing to paste —
    // and would arm the double-drive guard for a handoff that never occurred.
    if (await copyText(cmd)) {
      markHandoff();
      onNotice('Resume command copied — paste it in a terminal');
    } else {
      onNotice(`Copy failed — run this yourself: ${cmd}`, true);
    }
  };

  const markHandoff = () => {
    if (robot) localStorage.setItem(`airoom.handoff.${robot.sessionId}`, String(Date.now()));
    setHandedOff(true);
  };

  /** Read image files (paste, drop, or picker) into base64 attachments. */
  const addImages = async (files: FileList | File[]) => {
    const picked = [...files].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (!picked.length) return;
    const read = await Promise.all(
      picked.slice(0, 6).map(
        (f) =>
          new Promise<ImageAttachment | null>((resolve) => {
            const r = new FileReader();
            r.onerror = () => resolve(null);
            r.onload = () =>
              resolve({
                mediaType: f.type as ImageAttachment['mediaType'],
                data: String(r.result).split(',')[1] ?? '',
                name: f.name,
              });
            r.readAsDataURL(f);
          }),
      ),
    );
    const ok = read.filter((x): x is ImageAttachment => !!x && !!x.data);
    if (ok.length) setShots((prev) => [...prev, ...ok].slice(0, 6));
  };

  const status: RobotStatus = robot?.status ?? 'idle';
  const pending = run?.pendingPermission;

  /**
   * Move focus to Allow when an approval appears — but NEVER out from under
   * someone who is typing.
   *
   * A focused button fires on Space as well as Enter, so autoFocus here meant
   * that an approval arriving mid-sentence stole the caret and turned the next
   * space in the user's own message into consent for a filesystem write they
   * had not read. Approving has to be something you chose, not something your
   * typing did, so the caret stays in the composer and the gate waits for a
   * deliberate click.
   */
  /**
   * While an approval is up, Enter approves and Esc denies — from anywhere in
   * the panel. The card advertised "Allow ⏎" but nothing listened for it, and
   * Deny had no key at all; the only honest options were to wire them up or
   * stop claiming them.
   */
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      if (e.key === 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey)) return;
      // The gate is a card in the flow, not a modal — the composer stays usable
      // on purpose. Someone mid-sentence still owns their own Enter and Escape;
      // stealing them meant you could not send a message, or clear a draft, for
      // as long as an approval sat there.
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      onPermission(pending.requestId, e.key === 'Enter');
    };
    // capture: the composer's own Enter handler must not send a message while
    // the question on screen is "may I touch your filesystem?"
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pending?.requestId, onPermission]);

  /**
   * "@" file mentions.
   *
   * Naming a file is the commonest thing you type, and typing a whole path by
   * hand is where a GUI feels worse than a terminal with tab-completion. The
   * search is anchored at the room's own folder and walks down as you pick
   * directories, so it never wanders off into the rest of the disk.
   */
  const [mention, setMention] = useState<{ token: string; items: { name: string; path: string; dir: boolean }[] } | null>(null);
  const mentionSeq = useRef(0);

  /** The "@word" being typed at the caret, if any. */
  const mentionToken = (el: HTMLTextAreaElement): string | null => {
    const upto = el.value.slice(0, el.selectionStart ?? el.value.length);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(upto);
    return m ? m[1] : null;
  };

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const token = mentionToken(el);
    if (token == null) {
      setMention(null);
      return;
    }
    const seq = ++mentionSeq.current;
    // everything before the last "/" is the folder to look in
    const cut = token.lastIndexOf('/');
    const sub = cut === -1 ? '' : token.slice(0, cut + 1);
    const needle = (cut === -1 ? token : token.slice(cut + 1)).toLowerCase();
    const dir = sub ? `${roomId.replace(/\/$/, '')}/${sub}` : roomId;
    void fetch(`${API_BASE}/fs/list?files=1&path=${encodeURIComponent(dir)}`)
      .then((r) => r.json())
      .then((data) => {
        if (seq !== mentionSeq.current) return; // a newer keystroke won
        const all = [
          ...(data.dirs ?? []).map((d: { name: string }) => ({ name: d.name, path: sub + d.name, dir: true })),
          ...(data.files ?? []).map((f: { name: string }) => ({ name: f.name, path: sub + f.name, dir: false })),
        ];
        setMention({
          token,
          items: all.filter((i) => i.name.toLowerCase().includes(needle)).slice(0, 8),
        });
      })
      .catch(() => setMention(null));
  }, [draft, roomId]);

  /** Replace the "@token" at the caret with a pick. Directories keep the menu
   *  open with a trailing slash so you can keep drilling down. */
  const takeMention = (item: { path: string; dir: boolean }) => {
    const el = taRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at === -1) return;
    const inserted = `@${item.path}${item.dir ? '/' : ' '}`;
    const next = draft.slice(0, at) + inserted + draft.slice(caret);
    setDraft(next);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = at + inserted.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // Number keys pick a model while the menu is open — the same 1-4 shortcuts
  // Claude Code shows next to each row.
  useEffect(() => {
    if (!modelMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Esc dismisses the MENU, not the whole chat. The world's own Escape
        // handler also listens on window, so without stopping here the panel
        // closed underneath the menu on the first press.
        e.preventDefault();
        e.stopPropagation();
        if (moreOpen) setMoreOpen(false);
        else setModelMenu(false);
        return;
      }
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > primary.length) return;
      e.preventDefault();
      pickModel(primary[n - 1].value);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [modelMenu, moreOpen, primary]);

  /**
   * "/" command menu.
   *
   * Only when the slash opens the message — mid-sentence a slash is just a
   * slash (a path, a fraction), and popping a menu there would fight the user.
   */
  const slash = useMemo(() => {
    const m = /^\/([a-z0-9:_-]*)$/i.exec(draft);
    if (!m) return null;
    const needle = m[1].toLowerCase();
    // The runtime's own command list only carries skills and custom commands;
    // the GUI-worthy BUILT-INS it also executes (as local slash commands sent
    // in the message) would otherwise be undiscoverable — /compact looked
    // unsupported when it simply wasn't listed.
    const visible = commands.filter((c) => !c.name.startsWith('__'));
    const all = [...BUILTIN_COMMANDS.filter((b) => !visible.some((c) => c.name === b.name)), ...visible];
    const hits = all.filter((c) => c.name.toLowerCase().includes(needle));
    // Prefix matches first (stable sort keeps list order within each tier) —
    // the runtime lists built-ins like /compact near the END of ~50 commands,
    // so on a substring-only ranking they always fell off the 8-row cut.
    hits.sort((a, b) => Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle)));
    const top = hits.slice(0, 8);
    return top.length ? { items: top } : null;
  }, [draft, commands]);

  const takeCommand = (c: CommandChoice) => {
    setDraft(`/${c.name} `);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  /**
   * An empty desk should not open a floor-to-ceiling frame.
   *
   * The panel hugs its content while there is nothing in it: the whole team
   * brief, or the "your first message hires an agent" note. It goes full height
   * the moment a conversation actually exists — which for a fresh hire is the
   * first reply, not the moment the session id resolves, so the box does not
   * jump twice.
   */
  const compact = !robot && (hireMode === 'team' || (!run?.thread.length && !run?.active));

  /**
   * Two different goodbyes, deliberately not one button.
   *
   * "Let go" frees the desk and keeps the conversation — that is what people
   * mean nine times out of ten, so it is the one that is one click away.
   * Deleting the transcript is a separate, explicitly confirmed step, because
   * a session can be a day of work and no dialog should be able to lose it by
   * accident.
   */
  const [saying, setSaying] = useState<null | 'letgo' | 'delete'>(null);

  // The agent's callsign: the user's name for it, or the deterministic
  // default. Click it in the header to rename; empty goes back to default.
  const callsign = robot ? (robot.name ?? defaultAgentName(robot.sessionId)) : null;
  const [editingName, setEditingName] = useState(false);
  useEffect(() => setEditingName(false), [robot?.sessionId]);
  // A hire can be christened before its first word — the name travels with
  // the first message and is pinned to the session the moment it exists.
  const [hireName, setHireName] = useState('');
  useEffect(() => setHireName(''), [roomId]);

  const allowRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!pending) return;
    const el = document.activeElement as HTMLElement | null;
    const typing =
      !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
    if (!typing) allowRef.current?.focus();
  }, [pending?.requestId]);

  return (
    <aside
      ref={trapRef}
      className={`ap ${compact ? 'ap--compact' : ''} ${term && robot ? 'ap--term' : ''}`}
      role={docked ? 'region' : 'dialog'}
      aria-modal={docked ? undefined : 'true'}
      aria-labelledby="ap-title"
      style={{ ['--room' as string]: accent, ['--st' as string]: STATUS_COLOR[status] }}
    >
      <header className="ap__band">
        <span className="ap__led" />
        {robot && editingName ? (
          <input
            className="ap__nameIn"
            defaultValue={robot.name ?? ''}
            placeholder={defaultAgentName(robot.sessionId)}
            maxLength={24}
            autoFocus
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                onNameAgent(e.currentTarget.value.trim());
                setEditingName(false);
              } else if (e.key === 'Escape') setEditingName(false);
            }}
            onBlur={(e) => {
              onNameAgent(e.currentTarget.value.trim());
              setEditingName(false);
            }}
          />
        ) : (
          <h2 className="ap__title" id="ap-title" title={robot?.title ?? roomName}>
            {robot ? (
              <>
                <button
                  type="button"
                  className="ap__agentName"
                  title="Rename this agent"
                  onClick={() => setEditingName(true)}
                >
                  {callsign}
                </button>
                {robot.title}
              </>
            ) : (
              `New ${hireMode} — ${roomName}`
            )}
          </h2>
        )}
        {robot ? (
          <span className="ap__state">{STATE_LABEL[status]}</span>
        ) : (
          // The choice lives where the hire happens: an empty desk asks WHAT to
          // put there before it asks anything else.
          <div className="ap__seg" role="radiogroup" aria-label="What to hire">
            {(['agent', 'team'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={hireMode === m}
                className={`ap__segBtn ${hireMode === m ? 'ap__segBtn--on' : ''}`}
                onClick={() => onHireMode(m)}
                title={m === 'agent' ? 'One Claude session at this desk' : 'A lead, a builder and a reviewer working together'}
              >
                {m === 'agent' ? 'Agent' : 'Team'}
              </button>
            ))}
          </div>
        )}
        {liveExternal && (
          <span className="ap__chip ap__chip--live" title="This session is also open in a Claude Code terminal">
            ⌁ in terminal
          </span>
        )}
        <span className="ap__chip ap__chip--room">{roomName}</span>
        {robot && team && onOpenTeam && (
          <button
            type="button"
            className={`ap__chip ap__chip--team ${team.state === 'awaiting_human' ? 'ap__chip--teamWants' : ''}`}
            onClick={onOpenTeam}
            title="Open the team this agent is on"
          >
            {team.label} · team ▸
          </button>
        )}
        {robot && playbook && onOpenPlaybook && (
          <button type="button" className="ap__chip ap__chip--pb" onClick={onOpenPlaybook} title="Open the playbook this run follows">
            ▤ {playbook.name} ▸
          </button>
        )}
        <span className="ap__gap" />
        {robot && (
          <button
            className={`ap__ico ${term ? 'ap__ico--on' : ''}`}
            onClick={() => pickView(term ? 'chat' : 'term')}
            aria-label={term ? 'Back to the reading view' : 'Terminal view'}
            aria-pressed={term}
            title={term ? 'Back to the reading view' : 'Read this conversation as a terminal'}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
              <path d="M4.5 6.5 6.5 8l-2 1.5M8.5 10h3" />
            </svg>
          </button>
        )}
        <button
          className="ap__ico"
          onClick={() => setMetaOpen((v) => !v)}
          aria-expanded={metaOpen}
          aria-label="Session details"
          title="Session details"
        >
          ⋯
        </button>
        <button className="ap__ico" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {metaOpen && (
        <dl className="ap__meta">
          {robot?.gitBranch && (
            <>
              <dt>branch</dt>
              <dd>{robot.gitBranch}</dd>
            </>
          )}
          {!!robot?.skills?.length && (
            <>
              <dt>skills</dt>
              <dd>{robot.skills.join(' · ')}</dd>
            </>
          )}
          <dt>last</dt>
          <dd>{robot?.lastActivity ? relTime(robot.lastActivity) : '—'}</dd>
          <dt>turns</dt>
          <dd>{robot ? robot.messageCount : 0}</dd>
          {/* NO SPEND CAP CONTROL — deliberately.
              The plumbing below (budgetUsd → query maxBudgetUsd) is in place and
              typechecked, but a live test showed it does NOT stop a turn on this
              CLI build: a run capped at $0.02 still produced an 18k-character
              reply, which costs far more than that on any model. A control that
              promises to protect your bill and silently doesn't is worse than no
              control, so it stays hidden until the runtime honours it. */}
          {run?.context && (
            <>
              <dt title="How full this conversation's context window is. Claude Code compacts automatically when it fills, which costs a turn — this is your warning.">
                context
              </dt>
              <dd>
                <span className={`ctx ${run.context.percent >= 80 ? 'ctx--high' : ''}`}>
                  <span className="ctx__bar" style={{ width: `${Math.min(100, run.context.percent)}%` }} />
                </span>
                {run.context.percent}% · {Math.round(run.context.usedTokens / 1000)}k /{' '}
                {Math.round(run.context.maxTokens / 1000)}k
              </dd>
            </>
          )}
          {run?.cost != null && (
            <>
              <dt title="Billed to your Claude account for the turns airoom has run in this session. Turns you ran in Claude Code aren't counted.">
                spent
              </dt>
              <dd>{current?.provider === 'ollama' ? 'local · no charge' : `$${run.cost.toFixed(4)}`}</dd>
            </>
          )}
          <dt>folder</dt>
          <dd>
            <button
              className="ap__copy"
              onClick={() => void copyText(roomId).then((ok) => onNotice(ok ? 'Path copied' : 'Copy failed', !ok))}
              title="Copy path"
            >
              {roomId}
            </button>
          </dd>
          {robot && (
            <>
              <dt>session</dt>
              <dd>
                <button
                  className="ap__copy"
                  onClick={() =>
                    void copyText(robot.sessionId).then((ok) =>
                      onNotice(ok ? 'Session id copied' : 'Copy failed', !ok),
                    )
                  }
                  title="Copy session id"
                >
                  {robot.sessionId.slice(0, 8)}…
                </button>
              </dd>
            </>
          )}
        </dl>
      )}

      {metaOpen && robot && (
        <div className="ap__metaActions">
          <button
            className="ap__metaAction"
            onClick={() => {
              setMetaOpen(false);
              void openInClaudeCode();
            }}
            title="Same conversation, full history — the terminal picks it up mid-thread"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
              <path d="M4.5 6.5 6.5 8l-2 1.5M8.5 10h3" />
            </svg>
            Continue in Claude Code
          </button>
          {onMakePlaybook && !playbook && !team && (
            <button
              className="ap__metaAction ap__metaAction--pb"
              onClick={() => {
                setMetaOpen(false);
                onMakePlaybook();
              }}
              title="Turn this session into a playbook: airoom reads your brief, your corrections, what ran and what was checked, and proposes a card you can run again with new inputs"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="2" width="10" height="12" rx="1.5" />
                <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
              </svg>
              Make this a playbook
            </button>
          )}
        </div>
      )}
      {metaOpen && robot && (
        <div className="ap__danger">
          {saying === null && (
            <>
              <button className="ap__letgo" onClick={() => setSaying('letgo')}>
                Let this agent go
              </button>
              <button className="ap__del" onClick={() => setSaying('delete')}>
                Delete conversation
              </button>
            </>
          )}
          {saying === 'letgo' && (
            <>
              <span className="ap__dangerText">
                Frees the desk. The conversation stays on disk and you can bring it back from the
                room’s session list.
              </span>
              <span className="ap__dangerBtns">
                <button className="ap__dangerNo" onClick={() => setSaying(null)}>
                  Cancel
                </button>
                <button className="ap__letgo" onClick={onLetGo}>
                  Let go
                </button>
              </span>
            </>
          )}
          {saying === 'delete' && (
            <>
              <span className="ap__dangerText">
                Deletes this conversation — {robot.messageCount} turns. The file is moved to
                <code> ~/.airoom/deleted</code>, so you can still get it back by hand.
              </span>
              <span className="ap__dangerBtns">
                <button className="ap__dangerNo" onClick={() => setSaying(null)}>
                  Cancel
                </button>
                <button className="ap__del" onClick={onDelete}>
                  Delete for good
                </button>
              </span>
            </>
          )}
        </div>
      )}

      <div className="ap__scroll">
      {!robot && (
        <HireTeam
          roomId={roomId}
          roomName={roomName}
          autonomy={teamAutonomy}
          roundCap={teamRoundCap}
          mode={teamMode}
          model={teamModel}
          models={models}
          busy={!canHire}
          visible={hireMode === 'team'}
          hired={teamHired}
          onDefaults={onTeamDefaults}
          onHire={onHireTeam}
        />
      )}

      <div className="ap__thread" ref={threadRef} onScroll={onScroll} hidden={!robot && hireMode === 'team'}>
        <div className="ap__col">
          {robot && transcript?.hasMore && (
            <button className="ap__older" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? 'loading earlier messages…' : '↑ load earlier messages'}
            </button>
          )}
          {robot && transcript && !transcript.hasMore && items.length > 12 && (
            <div className="ap__origin">start of this conversation</div>
          )}
          {items.length === 0 && (
            <div className="ap__empty">
              {robot ? (
                'No conversation yet — say something below.'
              ) : (
                <>
                  Your first message <b>hires one agent</b> in this room: it walks in, sits down,
                  and starts a brand-new Claude session in this project. Need it reviewed as it
                  goes? Switch to <b>Team</b> above.
                </>
              )}
            </div>
          )}

          {blocks.map((b) =>
            b.kind === 'ops' ? (
              <Ops key={b.id} items={b.items} term={term} />
            ) : (
              <Turn
                key={b.item.id}
                item={b.item}
                prevTs={b.prevTs}
                term={term}
                onImage={setLightbox}
                // Checkpoints are stored on disk with the session, so this is
                // offered for any hired agent — reverting is something you want
                // AFTER the agent made a mess, which is usually long after the
                // run went idle.
                onRewind={run || robot?.sessionId ? (id) => onRewind(id, true) : undefined}
              />
            ),
          )}

          {busy && (
            <div className="ap__working">
              <span className="ap__dots">
                <i />
                <i />
                <i />
              </span>
              working
              <button className="ap__stop" onClick={onInterrupt} title="Stop this run">
                stop
              </button>
            </div>
          )}
        </div>
      </div>
        {!pinned && (
          <button className="ap__jump" onClick={jumpToNewest}>
            ↓ newest
          </button>
        )}
      </div>

      {/* The one control that authorizes code against your filesystem. */}
      {pending && (
        <section className="gate" role="alertdialog" aria-label="Tool approval">
          <div className="gate__head">
            needs your approval{pending.tool?.name ? ` · ${pending.tool.name}` : ''}
          </div>
          {pending.tool?.title && <div className="gate__ask">{pending.tool.title}</div>}
          <div className="gate__cwd">
            {pending.tool?.target || pending.label}
            {pending.tool?.cwd ? ` · in ${pending.tool.cwd}` : ''}
          </div>
          <GateContent tool={pending.tool} label={pending.label} />
          {pending.tool?.description && <div className="gate__why">{pending.tool.description}</div>}
          <div className="gate__row">
            <button
              className="gate__b gate__b--allow"
              ref={allowRef}
              onClick={() => onPermission(pending.requestId, true)}
            >
              Allow <kbd>⏎</kbd>
            </button>
            {pending.canAlways && (
              <button
                className="gate__b gate__b--always"
                onClick={() => {
                  // When "stop asking" means a wider mode, make that change
                  // through the picker so it is visible and revertible — the
                  // user should never discover later that their agent quietly
                  // stopped asking.
                  if (pending.alwaysMode) changeMode(pending.alwaysMode);
                  onPermission(pending.requestId, true, true);
                }}
                title={
                  pending.alwaysMode
                    ? `Allow this, and switch this agent to "${PERMISSION_MODES.find((m) => m.value === pending.alwaysMode)?.label}" for the rest of the session`
                    : 'Allow this, and stop asking for calls like it in this session'
                }
              >
                Always allow
              </button>
            )}
            <button className="gate__b gate__b--deny" onClick={() => onPermission(pending.requestId, false)}>
              Deny &amp; stop <kbd>esc</kbd>
            </button>
            <button
              className="gate__b gate__b--ghost"
              onClick={() => {
                void copyText(pending.tool?.target || pending.label).then((ok) =>
                  onNotice(ok ? 'Command copied' : 'Copy failed', !ok),
                );
              }}
            >
              copy
            </button>
          </div>
        </section>
      )}

      {/* The confirmation card is a receipt, not a dialog — it clears itself so
          it isn't still sitting above the composer three turns later. */}
      {rewind && rewind.userMessageId && !rewind.dryRun && <RewindAutoClose onDone={onClearRewind} />}
      {rewind && rewind.userMessageId && (
        <section className="gate gate--rewind" role="alertdialog" aria-label="Revert files">
          <div className="gate__head">revert files to this message</div>
          {rewind.error ? (
            <div className="gate__cwd">{rewind.error}</div>
          ) : rewind.dryRun ? (
            <>
              <div className="gate__cwd">
                {rewind.filesChanged?.length
                  ? `${rewind.filesChanged.length} file${rewind.filesChanged.length > 1 ? 's' : ''} would change · +${rewind.insertions ?? 0} −${rewind.deletions ?? 0}`
                  : 'Nothing to change — the files already match that point.'}
              </div>
              {!!rewind.filesChanged?.length && (
                <Blk code={rewind.filesChanged.join('\n')} label="files" clampLines={10} />
              )}
            </>
          ) : (
            <div className="gate__cwd">
              {/* The real call doesn't always report a file list, and claiming
                  "0 files" after a successful revert is simply untrue. Only
                  give a count when there is one to give. */}
              {rewind.filesChanged?.length
                ? `Reverted ${rewind.filesChanged.length} file${rewind.filesChanged.length === 1 ? '' : 's'}.`
                : 'Files reverted to that point.'}
            </div>
          )}
          <div className="gate__row">
            {rewind.dryRun && rewind.canRewind && !!rewind.filesChanged?.length && (
              <button
                className="gate__b gate__b--deny"
                onClick={() => onRewind(rewind.userMessageId, false)}
                title="Overwrite these files with their earlier contents"
              >
                Revert them
              </button>
            )}
            <button className="gate__b gate__b--ghost" onClick={onClearRewind}>
              {rewind.dryRun ? 'Cancel' : 'Close'}
            </button>
          </div>
        </section>
      )}

      {lightbox && (
        <div className="lightbox" role="dialog" aria-label="Image, full size" onClick={() => setLightbox(null)}>
          <img className="lightbox__img" src={lightbox} alt="attachment, full size" />
          <span className="lightbox__hint">click anywhere or press esc to close</span>
        </div>
      )}

      {slash ? (
        <div className="mention">
          {slash.items.map((c) => (
            <button
              key={c.name}
              className="mention__row"
              onMouseDown={(e) => {
                e.preventDefault();
                takeCommand(c);
              }}
            >
              <span className="mention__kind">/</span>
              <span className="mention__name">{c.name}</span>
              <span className="mention__desc">{c.description}</span>
            </button>
          ))}
          <div className="mention__hint">⇥ or ⏎ to pick · commands run in the agent</div>
        </div>
      ) : null}

      {mention?.items.length ? (
        <div className="mention">
          {mention.items.map((it) => (
            <button key={it.path} className="mention__row" onMouseDown={(e) => { e.preventDefault(); takeMention(it); }}>
              <span className="mention__kind">{it.dir ? '▸' : '·'}</span>
              <span className="mention__name">{it.path}</span>
            </button>
          ))}
          <div className="mention__hint">⇥ or ⏎ to pick</div>
        </div>
      ) : null}

      <form
        className={`cx ${dragging ? 'cx--drop' : ''}`}
        hidden={!robot && hireMode === 'team'}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          void addImages(e.dataTransfer.files);
        }}
      >
        {doubleDrive && !confirmSend && (
          <div className="cx__note">
            {liveExternal ? 'This session is running in Claude Code right now.' : 'You opened this session in Claude Code.'}{' '}
            Messages you send from here go to the same conversation, but the other side won't
            re-read it until you reopen it there.
          </div>
        )}
        {confirmSend && (
          <div className="cx__warn">
            <div className="cx__warntext">
              <b>Send from airoom too?</b> This session is open in Claude Code. Both sides append to
              the same transcript, so replies can end up interleaved.
            </div>
            <div className="cx__warnrow">
              <button type="submit" className="cx__warnbtn cx__warnbtn--go">
                Send anyway
              </button>
              <button
                type="button"
                className="cx__warnbtn"
                onClick={() => {
                  setConfirmSend(false);
                  setHandedOff(false);
                  if (robot) localStorage.removeItem(`airoom.handoff.${robot.sessionId}`);
                }}
              >
                Keep it in Claude Code
              </button>
            </div>
          </div>
        )}
        {localPick && (
          <div className={`cx__localnote cx__localnote--${localPick.quality ?? 'fair'}`} role="note">
            <span className={`mm__q mm__q--${localPick.quality ?? 'fair'}`} aria-hidden="true" />
            <b>{localPick.displayName}</b> · local model, {QUALITY_LABEL[localPick.quality ?? 'fair']}.{' '}
            {localPick.qualityNote} No charge; the office's approval cards and tools work as usual.
            {localPick.runtimeContextK != null && localPick.runtimeContextK < 16 && (
              <>
                {' '}
                <b>It is running with a {localPick.runtimeContextK}k window</b> — too small for agent turns.
                Restart the server with <code>OLLAMA_CONTEXT_LENGTH=32768</code>, or raise the context length in its
                settings.
              </>
            )}
          </div>
        )}
        {remember && playbook && (
          <div className="cx__rememberNote">This message also becomes a rule on “{playbook.name}” — every future run follows it.</div>
        )}
        {shots.length > 0 && (
          <div className="cx__shots">
            {shots.map((img, i) => (
              <div className="shot" key={`${img.name ?? 'img'}${i}`}>
                <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name ?? 'attachment'} />
                <button
                  type="button"
                  className="shot__x"
                  onClick={() => setShots((prev) => prev.filter((_, j) => j !== i))}
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="cx__frame">
          <textarea
            ref={taRef}
            className="cx__ta"
            rows={1}
            placeholder={
              busy
                ? 'Type a follow-up — it queues into the running turn…'
                : robot
                  ? `Message ${robot.title.slice(0, 32)}…`
                  : `First task for the new ${roomName} agent…`
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.items]
                .filter((it) => it.kind === 'file')
                .map((it) => it.getAsFile())
                .filter((f): f is File => !!f);
              if (files.length) {
                e.preventDefault();
                void addImages(files);
              }
            }}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && draft.trim()) {
                // don't throw away a draft: first Esc just leaves the field
                e.stopPropagation();
                e.currentTarget.blur();
                return;
              }
              // While a completion menu is open it owns Tab and Enter.
              if (slash && (e.key === 'Tab' || e.key === 'Enter')) {
                e.preventDefault();
                takeCommand(slash.items[0]);
                return;
              }
              if (mention?.items.length && (e.key === 'Tab' || e.key === 'Enter')) {
                e.preventDefault();
                takeMention(mention.items[0]);
                return;
              }
              if (e.key === 'Escape' && mention) {
                e.stopPropagation();
                setMention(null);
                return;
              }
              const enter = e.key === 'Enter';
              if (!enter) return;
              if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.shiftKey) return; // newline
              e.preventDefault();
              submit();
            }}
          />
        </div>
        <div className="cx__bar">
          <PickerMenu
            className={`cx__mode ${mode !== 'default' ? 'cx__mode--on' : ''} ${mode === 'bypassPermissions' ? 'cx__mode--hot' : ''}`}
            value={mode}
            options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, hint: m.hint }))}
            onPick={(v) => changeMode(v as PermissionMode)}
            ariaLabel="How much this agent may do without asking"
          />
          <div className="mm">
            <button
              type="button"
              className="cx__model"
              onClick={() => {
                setModelMenu((v) => !v);
                setMoreOpen(false);
              }}
              title="Model for this agent"
            >
              {current?.displayName ?? 'Default'}
              {fast ? ' ⚡' : ''}
            </button>
            {modelMenu && (
              <>
                <div className="mm__scrim" onClick={() => setModelMenu(false)} />
                <div className="mm__menu" role="menu">
                  <div className="mm__head">Models</div>
                  {primary.map((m, i) => (
                    <button
                      key={m.value}
                      className="mm__row"
                      role="menuitemradio"
                      aria-checked={sameModel(m.value, model)}
                      onClick={() => pickModel(m.value)}
                      title={m.description}
                    >
                      <span className="mm__name">{m.displayName}</span>
                      {sameModel(m.value, model) && <span className="mm__tick">✓</span>}
                      <span className="mm__key">{i + 1}</span>
                      {m.description && <span className="mm__desc">{m.description}</span>}
                    </button>
                  ))}
                  {more.length > 0 && (
                    <div
                      className="mm__sub"
                      onMouseEnter={() => setMoreOpen(true)}
                      onMouseLeave={() => setMoreOpen(false)}
                    >
                      {/* Opens, never toggles: hovering the row already opened
                          the submenu, so a toggle here closed it on the very
                          click meant to open it. */}
                      <button className="mm__row" onClick={() => setMoreOpen(true)}>
                        <span className="mm__name">More models</span>
                        <span className="mm__key">›</span>
                      </button>
                      {moreOpen && (
                        <div className="mm__menu mm__menu--sub" role="menu">
                          {more.map((m) => (
                            <button
                              key={m.value}
                              className="mm__row"
                              role="menuitemradio"
                              aria-checked={sameModel(m.value, model)}
                              onClick={() => pickModel(m.value)}
                              title={m.description}
                            >
                              <span className="mm__name">{m.displayName}</span>
                              {sameModel(m.value, model) && <span className="mm__tick">✓</span>}
                              {m.description && <span className="mm__desc">{m.description}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {/* Only when local models actually exist — nothing advertises them. */}
                  {local.length > 0 && (
                    <>
                      <div className="mm__head">Local</div>
                      {local.map((m) => (
                        <button
                          key={m.value}
                          className="mm__row"
                          role="menuitemradio"
                          aria-checked={sameModel(m.value, model)}
                          disabled={m.quality === 'unfit'}
                          onClick={() => m.quality !== 'unfit' && pickModel(m.value)}
                          title={m.qualityNote}
                        >
                          <span className="mm__name">
                            <span className={`mm__q mm__q--${m.quality ?? 'fair'}`} aria-hidden="true" />
                            {m.displayName}
                            <span className="mm__grade">{QUALITY_LABEL[m.quality ?? 'fair']}</span>
                          </span>
                          {sameModel(m.value, model) && <span className="mm__tick">✓</span>}
                          <span className="mm__desc">
                            {m.description}
                            {m.runtimeContextK != null ? ` · running at ${m.runtimeContextK}k` : ''}
                            {m.qualityNote ? ` — ${m.qualityNote}` : ''}
                          </span>
                        </button>
                      ))}
                    </>
                  )}
                  {(current?.supportsFastMode ?? false) && (
                    <>
                      <div className="mm__head">Fast mode</div>
                      <button
                        className="mm__row"
                        role="menuitemcheckbox"
                        aria-checked={fast}
                        onClick={() => changeFast(!fast)}
                        title="Same model, faster output."
                      >
                        <span className="mm__name">Enable fast mode</span>
                        <span className={`mm__sw ${fast ? 'mm__sw--on' : ''}`} />
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          {!robot && hireMode === 'agent' && (
            <input
              className="cx__nameIn"
              placeholder="name…"
              value={hireName}
              maxLength={24}
              onChange={(e) => setHireName(e.target.value)}
              title="Name this agent (optional — it gets a callsign either way)"
            />
          )}
          {!robot && hireMode === 'agent' && (
            // The loadout lives where the hire happens: pick skills at the
            // ghost desk, before the first word is typed.
            <div className="mm">
              <button
                type="button"
                ref={skillsBtnRef}
                className="cx__model"
                onClick={() => setSkillsMenu((v) => !v)}
                title="Skills this hire will carry"
              >
                {loadout.skills.length
                  ? `⛭ ${loadout.skills.length} skill${loadout.skills.length > 1 ? 's' : ''}`
                  : '⛭ skills'}
              </button>
              {skillsMenu &&
                skillsAt &&
                createPortal(
                  <>
                    <div className="mm__scrim mm__scrim--float" onClick={() => setSkillsMenu(false)} />
                    <div
                      className="mm__menu mm__menu--skills mm__menu--float"
                      role="menu"
                      style={{
                        left: Math.max(8, Math.min(skillsAt.left, window.innerWidth - 420)),
                        bottom: window.innerHeight - skillsAt.top + 6,
                        maxHeight: Math.max(220, Math.min(440, skillsAt.top - 14)),
                      }}
                    >
                    <div className="mm__head">Skills — click cycles granted → pinned → off</div>
                    {creating ? (
                      <div className="skf">
                        <input
                          className="skf__in"
                          placeholder="skill name (e.g. api-conventions)"
                          value={newName}
                          onChange={(e) => setNewName(e.target.value)}
                          autoFocus
                        />
                        <input
                          className="skf__in"
                          placeholder="one-line description"
                          value={newDesc}
                          onChange={(e) => setNewDesc(e.target.value)}
                        />
                        <textarea
                          className="skf__in skf__ta"
                          rows={6}
                          placeholder="The instructions the agent will follow…"
                          value={newBody}
                          onChange={(e) => setNewBody(e.target.value)}
                        />
                        <div className="skf__row">
                          <button type="button" className="skf__btn skf__btn--ghost" onClick={() => setCreating(false)}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="skf__btn"
                            disabled={!newName.trim() || !newBody.trim()}
                            onClick={saveNewSkill}
                          >
                            Save skill
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button className="mm__row" onClick={() => setCreating(true)}>
                        <span className="mm__name">＋ New skill…</span>
                        <span className="mm__desc">
                          Write one here — saved to ~/.claude/skills as a real SKILL.md, reusable by every future
                          hire (and by Claude Code itself).
                        </span>
                      </button>
                    )}
                    {skillChoices.length === 0 && (
                      <div className="mm__row">
                        <span className="mm__name">No skills on this machine yet</span>
                        <span className="mm__desc">
                          Write one above, or add SKILL.md packages under ~/.claude/skills or this project's
                          .claude/skills.
                        </span>
                      </div>
                    )}
                    {(
                      [
                        ['project', 'This project'],
                        ['user', 'Your skills'],
                        ['plugin', 'Installed plugins'],
                        ['marketplace', 'Marketplace library'],
                      ] as const
                    ).map(([src, label]) => {
                      const group = skillChoices.filter((c) => c.source === src);
                      if (!group.length) return null;
                      return (
                        <div key={src}>
                          <div className="mm__head">{label}</div>
                          {group.map((c) => {
                            const sel = loadout.skills.find((s) => s.path === c.path);
                            return (
                              <button
                                key={c.path}
                                className="mm__row"
                                role="menuitemcheckbox"
                                aria-checked={!!sel}
                                onClick={() => cycleSkill(c)}
                                title={c.description}
                              >
                                <span className="mm__name">
                                  {c.name}
                                  {sel ? (sel.pin ? ' — pinned' : ' — granted') : ''}
                                </span>
                                {sel && <span className="mm__tick">{sel.pin ? '✚' : '✓'}</span>}
                                {c.description && <span className="mm__desc">{c.description}</span>}
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                    {loadout.skills.length > 0 && (
                      <>
                        <div className="mm__head">Specialist</div>
                        <button
                          className="mm__row"
                          role="menuitemcheckbox"
                          aria-checked={!!loadout.specialist}
                          onClick={() => changeLoadout({ ...loadout, specialist: !loadout.specialist })}
                          title="Only take on work these skills cover — decline the rest."
                        >
                          <span className="mm__name">Decline work outside these skills</span>
                          <span className={`mm__sw ${loadout.specialist ? 'mm__sw--on' : ''}`} />
                        </button>
                      </>
                    )}
                    </div>
                  </>,
                  document.body,
                )}
            </div>
          )}
          <label className="cx__attach" title="Attach an image (or just paste / drop one)">
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addImages(e.target.files);
                e.target.value = '';
              }}
            />
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M13 7.5 8.2 12.3a3.1 3.1 0 0 1-4.4-4.4l5.2-5.2a2.1 2.1 0 0 1 3 3l-5.2 5.2a1.1 1.1 0 0 1-1.5-1.5l4.6-4.6" />
            </svg>
          </label>
          {term && robot && run?.context && (
            <span
              className="cx__ctx"
              title={`Context window: ${run.context.percent}% used · ${Math.round(run.context.usedTokens / 1000)}k of ${Math.round(run.context.maxTokens / 1000)}k tokens`}
            >
              <span className={`ctx ${run.context.percent >= 80 ? 'ctx--high' : ''}`}>
                <span className="ctx__bar" style={{ width: `${Math.min(100, run.context.percent)}%` }} />
              </span>
              {run.context.percent}%
            </span>
          )}
          <span className="cx__gap" />
          {robot && playbook && onRemember && (
            <div className="cx__remember" role="radiogroup" aria-label="Where this message applies">
              <button
                type="button"
                role="radio"
                aria-checked={!remember}
                className={`cx__rememberBtn ${!remember ? 'cx__rememberBtn--on' : ''}`}
                onClick={() => setRemember(false)}
                title="Applies to this run only"
              >
                this run
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={remember}
                className={`cx__rememberBtn ${remember ? 'cx__rememberBtn--on' : ''}`}
                onClick={() => setRemember(true)}
                title="Also saved as a rule on the playbook, for every future run"
              >
                remember
              </button>
            </div>
          )}
          <span className="cx__keys">
            <kbd>⏎</kbd> send <kbd>⇧⏎</kbd> newline
          </span>
          <button
            type="submit"
            className={`cx__send ${busy ? 'cx__send--queue' : ''}`}
            disabled={!draft.trim() && shots.length === 0}
            title={busy ? 'Queue into the running turn' : 'Send'}
          >
            {busy ? 'queue' : 'send'}
          </button>
        </div>
      </form>
    </aside>
  );
}

/** One turn: a timestamp gutter plus the body. Times form a hard column. */
/**
 * Pace a reply out at a readable rate.
 *
 * The runtime does not stream token by token: it hands over roughly 110
 * characters every 0.7 seconds, so painting each chunk the moment it lands
 * makes a reply arrive in visible slabs — measured at 19 chunks for a
 * 2000-character answer. Nothing upstream of here can be made finer, so the
 * text is buffered and revealed continuously instead.
 *
 * The rate is set by how much is waiting, not by a fixed speed: a normal chunk
 * drains over about the time the next one takes to arrive (so the flow never
 * stalls or races), while a large backlog — a reconnect, a background tab —
 * catches up quickly. When the turn ends the rest appears at once; text that
 * has arrived must never sit hidden behind an animation.
 */
function useSmoothText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text.length);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const reduced =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (!streaming || reduced) {
      if (shownRef.current !== text.length) setShown(text.length);
      return;
    }
    if (shownRef.current > text.length) setShown(text.length); // thread replaced
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(120, now - last);
      last = now;
      const pending = text.length - shownRef.current;
      if (pending <= 0) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const perSec = pending > 400 ? pending / 0.3 : Math.max(90, pending / 0.75);
      const next = Math.min(text.length, shownRef.current + Math.max(1, (perSec * dt) / 1000));
      shownRef.current = next;
      setShown(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, streaming, reduced]);

  if (!streaming || reduced) return text;
  // Never cut mid-word: stop at the last space so the tail doesn't flicker
  // through half-written words.
  const n = Math.floor(shown);
  if (n >= text.length) return text;
  const cut = text.lastIndexOf(' ', n);
  return text.slice(0, cut > n - 14 ? cut : n);
}

/** A reply, paced while it is still arriving and whole once it has. */
function AgentText({ item }: { item: ChatItem }) {
  const text = useSmoothText(item.text, !!item.streaming);
  return <Markdown text={text} />;
}

function Turn({
  item,
  prevTs,
  term,
  onRewind,
  onImage,
}: {
  item: ChatItem;
  prevTs?: string | null;
  /** Terminal view: prompt-echo rows, inline right timestamps, no gutter. */
  term?: boolean;
  /** Present only when this session can actually be rewound (a live run). */
  onRewind?: (userMessageId: string) => void;
  /** A thumbnail was clicked — show it full-size. */
  onImage?: (src: string) => void;
}) {
  const showTs =
    !!item.ts && (!prevTs || Math.abs(Date.parse(item.ts) - Date.parse(prevTs)) > 180_000);

  if (item.kind === 'marker') {
    // A conversation-level event (compaction), not anyone speaking: a quiet
    // divider in the flow, with the numbers when we have them.
    return (
      <div className="ev ev--marker">
        <div className="ev__gut">{showTs && item.ts && <time>{clock(item.ts)}</time>}</div>
        <div className="ev__mark">
          <span className="ev__markline" />
          <span className="ev__marktext">
            {item.text}
            {item.detail ? <em> · {item.detail}</em> : null}
          </span>
          <span className="ev__markline" />
        </div>
      </div>
    );
  }

  if (item.kind === 'error') {
    return (
      <article className="ev ev--err">
        <div className="ev__gut">{showTs && item.ts && <time>{clock(item.ts)}</time>}</div>
        <div className="ev__body">
          <div className="ev__errhead">run failed</div>
          <Blk code={item.text} label="details" clampLines={10} />
        </div>
      </article>
    );
  }

  return (
    <article className={`ev ev--${item.kind}`}>
      <div className="ev__gut">{showTs && item.ts && <time>{clock(item.ts)}</time>}</div>
      <div className="ev__body">
        {item.kind === 'user' && onRewind && (
          <button
            className="ev__rewind"
            title="Put every file back the way it was just before this message. You'll see what would change first."
            onClick={() => onRewind(item.id.split('#')[0])}
          >
            ⟲ revert files to here
          </button>
        )}
        {item.kind === 'user' && !!item.imageSrcs?.length && (
          <div className="ev__thumbs">
            {item.imageSrcs.map((src, i) => (
              <img
                key={i}
                className="ev__thumb"
                src={src}
                loading="lazy"
                alt={`attachment ${i + 1}`}
                title="Click to view full size"
                onClick={() => onImage?.(src)}
              />
            ))}
          </div>
        )}
        {item.kind === 'user' && !!item.images && !item.imageSrcs?.length && (
          <span className="ev__imgchip" title="Attached with this message — the image itself lives in the session transcript">
            🖼 {item.images > 1 ? `${item.images} images` : 'image'}
            {item.imageDims ? ` · ${item.imageDims}` : ''}
          </span>
        )}
        {item.kind === 'agent' ? (
          <AgentText item={item} />
        ) : isPasted(item.text) ? (
          <Blk code={item.text} label="pasted" clampLines={12} />
        ) : item.text ? (
          <div className="ev__user">
            {item.text}
            {term && showTs && item.ts && <time className="ev__ptime">{clock(item.ts)}</time>}
          </div>
        ) : null}
        {item.truncated && <div className="ev__cut">message truncated by airoom</div>}
      </div>
    </article>
  );
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
