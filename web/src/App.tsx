import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSkills, ImageAttachment, PermissionMode, Playbook, Robot, Room } from '@shared/types';
import { PlaybookEditor } from './ui/PlaybookEditor';
import { PlaybookPanel } from './ui/PlaybookPanel';
import { Connectors } from './ui/Connectors';
import { useFleet, type RunState } from './net/useFleet';
import { API_BASE } from './net/base';
import { PixelWorld, type EditState } from './render/PixelWorld';
import { AgentPanel } from './ui/AgentPanel';
import { Logo } from './ui/Logo';
import { FolderPicker } from './ui/FolderPicker';
import { RoomSettings } from './ui/RoomSettings';
import { TeamPanel } from './ui/TeamPanel';
import { RoomRoster } from './ui/RoomRoster';
import { DecorPalette } from './ui/DecorPalette';
import { autoDecor, PRESETS } from './render/decor';
import { THEMES } from './render/draw';
import { loadRoomConfigs, saveRoomConfigs, type DecorItem, type FloorMat, type RoomConfig, type RoomConfigs } from './roomConfig';
import { sound } from './sound';
import { UpdateBar, useRelease } from './ui/UpdateBar';
import { clearDraft as clearHireDraft } from './ui/hireDraft';
import { basename } from './pathish';
import { Queue, type QueueKind } from './ui/Queue';
import { Palette, paletteRows } from './ui/Palette';
import { platform as hostPlatform } from './platform';
import { ProjectChooser } from './ui/ProjectChooser';
import { PickerMenu } from './ui/PickerMenu';
import { thisMachine, tokenPath, yourMachine } from './platform';

/** Anthropic's own command, verbatim. The old approach piped it through a
 *  grep that extracted the key into a file — it worked, but telling a brand
 *  new user to run a credential-harvesting-shaped one-liner was the least
 *  trustworthy possible first impression. Now they run the plain command and
 *  paste the key into the app, which saves it locally (see /engine/token). */
const CONNECT_CMD = 'claude setup-token';

// Bumped on UI changes — visible in the footer so "which build am I looking
// at?" is never a mystery again.
export const UI_BUILD = 'ui-38';

declare global {
  interface Window {
    /** Exposed by the desktop shell's preload bridge (absent in browsers). */
    airoomNative?: {
      /** 'darwin' | 'win32' | 'linux' */
      platform?: string;
      pickFolder(): Promise<string | null>;
      openInClaudeCode?(
        cwd: string,
        sessionId?: string,
      ): Promise<{ ok: boolean; cmd?: string; error?: string }>;
    };
  }
}

/** Poll the server's engine diagnostics until agents are authenticated. */
function useEngineAuth() {
  const [authed, setAuthed] = useState<boolean | null>(null); // null = unknown yet
  const [hasClaude, setHasClaude] = useState<boolean | null>(null); // claude binary found?
  const [ollama, setOllama] = useState<{ installed: boolean; running: boolean; models: number }>({
    installed: false,
    running: false,
    models: 0,
  });
  // `claude setup-token`, or the binary's full path when a terminal would not find `claude`.
  const [setupCommand, setSetupCommand] = useState<string>(CONNECT_CMD);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/health`);
        const j = await r.json();
        if (!stop) {
          setAuthed(j?.engine?.authToken != null);
          setHasClaude(j?.engine?.claudeBin != null);
          if (j?.engine?.ollama) setOllama(j.engine.ollama);
          if (typeof j?.engine?.setupCommand === 'string') setSetupCommand(j.engine.setupCommand);
        }
      } catch {
        /* server not up — keep unknown */
      }
      if (!stop) timer = setTimeout(poll, 8000);
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);
  return { authed, hasClaude, ollama, setupCommand };
}

export default function App() {
  const {
    snapshot,
    conn,
    transcript,
    runs,
    notice,
    subscribe,
    loadMore,
    loadingMore,
    unsubscribe,
    send,
    interrupt,
    respondPermission,
    setMode,
    setFastMode,
    warmLocal,
    setRoomHidden,
    models,
    commands,
    skillLists,
    listSkills,
    createSkill,
    rewind,
    askRewind,
    clearRewind,
    clearRunThread,
    addProject,
    curateProjects,
    setAgentHidden,
    nameAgent,
    nameTeam,
    deleteAgent,
    teamLogs,
    lastHandoff,
    hireTeam,
    teamNewTask,
    teamCancelTask,
    teamMergeTask,
    teamCloseTask,
    teamContinue,
    teamStop,
    teamDismiss,
    subscribeTeam,
    connectors,
    mcpPulse,
    listConnectors,
    setConnectorEnabled,
    setConnectorLoaded,
    addConnector,
    removeConnector,
    playbooks,
    playbookDrafts,
    requestPlaybookDraft,
    clearPlaybookDraft,
    savePlaybook,
    deletePlaybook,
    runPlaybook,
    addPlaybookRule,
    dropPlaybookRule,
    stopPlaybookRun,
  } = useFleet();
  // sessionId of a robot, or `spawn:<roomId>` for a ghost desk
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(sound.enabled());
  /** Focus mode: monochrome office, colour reserved for robots and signals,
   *  and the life layer stands down. Persisted like sound. */
  const [focusMode, setFocusMode] = useState(() => {
    try {
      return localStorage.getItem('airoom.focus.v1') === '1';
    } catch {
      return false;
    }
  });
  const toggleFocus = () => {
    // The write lives OUTSIDE the updater: StrictMode double-invokes updater
    // functions, and a side effect in one turns a single click into a toggle
    // that undoes itself.
    const next = !focusMode;
    setFocusMode(next);
    try {
      localStorage.setItem('airoom.focus.v1', next ? '1' : '0');
    } catch {
      /* preference just won't stick */
    }
  };
  const { authed, hasClaude, setupCommand } = useEngineAuth();
  const [connectDismissed, setConnectDismissed] = useState(false);
  /** The "which projects appear?" card: opened by hand from + project, or
   *  shown once on a fresh install. Skipping it settles the question too. */
  const [chooserOpen, setChooserOpen] = useState(false);
  const [chooserSkipped, setChooserSkipped] = useState(false);
  // A newer build, or a line from us: the server asks airoom.dev, this shows it.
  const { release } = useRelease();
  // Room we're waiting on a brand-new session for, after hiring at a ghost desk.
  // Without this marker a finished spawn run left parked under `spawn:<roomId>`
  // would make the NEXT "new agent" click hand you straight to the old agent.
  const [spawnWait, setSpawnWait] = useState<string | null>(null);
  // Local toast slot for panel-raised messages (handoff, copy fallbacks).
  const [flash, setFlash] = useState<{ text: string; isError: boolean } | null>(null);
  const raise = (text: string, isError = false) => {
    setFlash({ text, isError });
    setTimeout(() => setFlash(null), 4500);
  };
  const [copied, setCopied] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenErr, setTokenErr] = useState<string | null>(null);
  const [tokenSaved, setTokenSaved] = useState(false);
  // "It IS installed": the user pastes what `which claude` printed.
  const [binPath, setBinPath] = useState('');
  const [binBusy, setBinBusy] = useState(false);
  const [binError, setBinError] = useState<string | null>(null);
  const [binSaved, setBinSaved] = useState<string | null>(null);
  const saveBinPath = async () => {
    const p = binPath.trim();
    if (!p) return;
    setBinBusy(true);
    setBinError(null);
    try {
      const r = await fetch(`${API_BASE}/engine/claude-bin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; version?: string; error?: string };
      if (!r.ok || !j.ok) setBinError(j.error ?? 'airoom could not use that path.');
      else setBinSaved(j.version ?? p);
    } catch {
      setBinError('airoom is not reachable right now — try again in a moment.');
    } finally {
      setBinBusy(false);
    }
  };
  const saveToken = async () => {
    const token = tokenDraft.trim();
    if (!token || tokenBusy) return;
    setTokenBusy(true);
    setTokenErr(null);
    try {
      const r = await fetch(`${API_BASE}/engine/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await r.json();
      if (!r.ok) setTokenErr(data.error ?? 'Could not save the key.');
      else {
        setTokenSaved(true);
        setTokenDraft('');
      }
    } catch {
      setTokenErr('Could not reach the airoom server.');
    } finally {
      setTokenBusy(false);
    }
  };
  const wasAuthed = useRef<boolean | null>(null);
  const [connectedFlash, setConnectedFlash] = useState(false);
  useEffect(() => {
    if (wasAuthed.current === false && authed === true) {
      sound.chime();
      setConnectedFlash(true);
      setTimeout(() => setConnectedFlash(false), 5000);
    }
    wasAuthed.current = authed;
  }, [authed]);

  const selected: Robot | null = useMemo(
    () => snapshot?.robots.find((r) => r.sessionId === selectedId) ?? null,
    [snapshot, selectedId],
  );
  /**
   * A team member runs on the team's model and permission mode, not on this
   * app's defaults. Its panel used to read "Default · asks first" whatever the
   * team was hired with — and send the human's follow-ups on those settings.
   */
  const selectedMember = useMemo(() => {
    if (!selected?.team) return null;
    const t = snapshot?.teams.find((x) => x.id === selected.team!.id);
    return t?.members.find((m) => m.role === selected.team!.role) ?? null;
  }, [snapshot, selected]);
  const spawnRoomId = selectedId?.startsWith('spawn:') ? selectedId.slice(6) : null;
  const spawnRoom = useMemo(
    () => (spawnRoomId ? (snapshot?.rooms.find((r) => r.id === spawnRoomId) ?? null) : null),
    [snapshot, spawnRoomId],
  );
  const panelRoomId = selected?.roomId ?? spawnRoom?.id ?? null;

  // ---- teams ----
  // What the "+ new" desk is offering right now. Reset whenever the panel
  // moves to a different desk: a half-typed team brief must not reappear
  // under someone else's room.
  const [hireMode, setHireMode] = useState<'agent' | 'team'>('agent');
  useEffect(() => setHireMode('agent'), [spawnRoomId]);
  const [teamOpenId, setTeamOpenId] = useState<string | null>(null);
  /** Which of the strip's lists is open in the dock, if any. Opening an agent
   *  or a team replaces it; the strip brings it back. */
  const [queue, setQueue] = useState<QueueKind | null>(null);
  /** The dock's width, remembered in this browser. */
  const [dockW, setDockW] = useState(() => {
    try {
      return Number(localStorage.getItem('airoom.dock.w')) || 480;
    } catch {
      return 480;
    }
  });
  const dockWRef = useRef(dockW);
  useEffect(() => {
    dockWRef.current = dockW;
  }, [dockW]);
  const startDockResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = dockWRef.current;
    const grip = e.currentTarget;
    grip.classList.add('dock__grip--live');
    const onMove = (ev: PointerEvent) =>
      setDockW(Math.round(Math.max(360, Math.min(window.innerWidth * 0.64, startW + (startX - ev.clientX)))));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      grip.classList.remove('dock__grip--live');
      try {
        localStorage.setItem('airoom.dock.w', String(dockWRef.current));
      } catch {
        /* the width just won't stick */
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  /** Open one of the strip's lists in the dock, closing whatever was there. */
  const openQueue = (q: QueueKind) => {
    setSelectedId(null);
    setSpawnWait(null);
    unsubscribe();
    setTeamOpenId(null);
    setPlaybooksOpen(false);
    setQueue((cur) => (cur === q ? null : q));
  };

  // ---- playbooks ----
  /** The library in the dock, and which card is open in it. */
  const [playbooksOpen, setPlaybooksOpen] = useState(false);
  const [playbookId, setPlaybookId] = useState<string | null>(null);
  /** The card being edited: a fresh proposal, or a saved one. */
  const [editor, setEditor] = useState<{ draft: Playbook; sourceTitle?: string } | null>(null);
  /** The session "Make this a playbook" is reading, until its card arrives. */
  const [draftFor, setDraftFor] = useState<{ sessionId: string; title: string } | null>(null);
  const openPlaybooks = (id: string | null = null) => {
    setSelectedId(null);
    setSpawnWait(null);
    unsubscribe();
    setTeamOpenId(null);
    setQueue(null);
    setPlaybookId(id);
    setPlaybooksOpen(true);
  };
  useEffect(() => {
    if (!draftFor) return;
    const d = playbookDrafts[draftFor.sessionId];
    if (!d || d.loading) return;
    if (d.draft) setEditor({ draft: d.draft, sourceTitle: draftFor.title });
    else raise(d.error ?? 'airoom could not read a playbook out of that session.', true);
    clearPlaybookDraft(draftFor.sessionId);
    setDraftFor(null);
    // raise closes over setters only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbookDrafts, draftFor, clearPlaybookDraft]);
  const reading = !!draftFor && !!playbookDrafts[draftFor.sessionId]?.loading;
  /** Jump to anything: ⌘K, or Ctrl+K where there is no ⌘. ⌘J opens the
   *  Needs-you list. Both stay out of text fields' way: a field that wants
   *  those keys keeps them by stopping the event. */
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = hostPlatform === 'darwin' ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey) return;
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        openQueue('needs');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // openQueue closes over setters only; a stale copy behaves the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const openTeam = useMemo(
    () => snapshot?.teams.find((t) => t.id === teamOpenId) ?? null,
    [snapshot, teamOpenId],
  );
  // Room whose freshly hired team should pop its panel open on arrival.
  const [teamWait, setTeamWait] = useState<string | null>(null);
  /** Bumped when a hire lands, so the hire form knows to start over. */
  const [teamHired, setTeamHired] = useState(0);
  useEffect(() => {
    if (!teamWait || !snapshot) return;
    const t = snapshot.teams.find(
      (x) => x.roomId === teamWait && (x.state === 'working' || x.state === 'awaiting_human'),
    );
    if (t) {
      setTeamWait(null);
      setTeamOpenId(t.id);
      // The brief became a team: only now is it safe to forget it. A hire the
      // server refuses never reaches here, so the draft survives to be fixed.
      clearHireDraft(teamWait);
      setTeamHired((n) => n + 1);
    }
  }, [snapshot, teamWait]);
  /**
   * The newest handoff, translated for the renderer: roles become session ids
   * and the kind becomes the receiver's bubble line. Member↔member handoffs
   * walk; anything touching the human or the server has nobody to animate.
   */
  const handoffSignal = useMemo(() => {
    if (!lastHandoff || !snapshot) return null;
    const h = lastHandoff.handoff;
    const team = snapshot.teams.find((t) => t.id === h.teamId);
    if (!team) return null;
    const sid = (role: string) => team.members.find((m) => m.role === role)?.sessionId ?? null;
    const LABEL: Record<string, string> = {
      assign: 'new assignment',
      result: 'work handed in',
      verdict: h.verdict === 'approve' ? 'approved ✓' : 'changes requested',
    };
    return {
      seq: lastHandoff.seq,
      fromSessionId: h.from === 'human' || h.from === 'server' ? null : sid(h.from),
      toSessionId: h.to === 'human' ? null : sid(h.to),
      label: LABEL[h.kind] ?? h.kind,
    };
  }, [lastHandoff, snapshot]);

  // The run driving this robot may still live under its spawn key (the key is
  // stable for a run's lifetime) — match by sessionId as well.
  const activeRun: RunState | undefined = useMemo(() => {
    if (selected) {
      return (
        runs[selected.sessionId] ??
        Object.values(runs).find((r) => r.sessionId === selected.sessionId)
      );
    }
    if (spawnRoomId) {
      const r = runs[`spawn:${spawnRoomId}`];
      // Only surface a spawn run that belongs to THIS hire: still in flight, or
      // one we're actively waiting on. A finished one is the previous agent's.
      if (!r) return undefined;
      return !r.sessionId || r.active || spawnWait === spawnRoomId ? r : undefined;
    }
    return undefined;
  }, [runs, selected, spawnRoomId, spawnWait]);

  // After hiring at a ghost desk, hand the panel over to the new robot as
  // soon as it exists in the fleet.
  useEffect(() => {
    if (!spawnRoomId || !snapshot || spawnWait !== spawnRoomId) return;
    const sid = runs[`spawn:${spawnRoomId}`]?.sessionId;
    if (sid && snapshot.robots.some((r) => r.sessionId === sid)) {
      setSpawnWait(null);
      setSelectedId(sid);
    }
  }, [runs, snapshot, spawnRoomId, spawnWait]);

  const counts = useMemo(() => {
    const c = { working: 0, waiting_input: 0, idle: 0, error: 0, done: 0 };
    snapshot?.robots.forEach((r) => (c[r.status] += 1));
    return c;
  }, [snapshot]);
  /** Everything waiting on a person: agents on a question or an approval, and
   *  teams parked on a decision. The one number the strip must get right. */
  const needsN = useMemo(
    () =>
      (snapshot?.robots.filter((r) => r.status === 'waiting_input' || r.needsApproval).length ?? 0) +
      (snapshot?.teams.filter((t) => t.state === 'awaiting_human').length ?? 0),
    [snapshot],
  );

  // Per-room customization (floor theme + project logo), persisted locally.
  const [configs, setConfigs] = useState<RoomConfigs>(() => loadRoomConfigs());
  const [settingsRoom, setSettingsRoom] = useState<Room | null>(null);
  // ---- connectors ----
  /** The room whose Connections sheet is open. */
  const [connectorsRoom, setConnectorsRoom] = useState<Room | null>(null);
  /** Ask once per room for what its agents can reach. The server answers
   *  from its cache or starts one runtime per room, one at a time. */
  const askedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!snapshot || conn !== 'open') return;
    for (const r of snapshot.rooms) {
      if (r.lane || askedRef.current.has(r.id)) continue;
      askedRef.current.add(r.id);
      listConnectors(r.id);
    }
  }, [snapshot, conn, listConnectors]);
  /** roomId → the connectors ON that room's wall. Nothing shows without
   *  being turned on for the room (project ones, when enabled; shared ones,
   *  when chosen in the room's settings). */
  const wallConnectors = useMemo(() => {
    const m: Record<string, import('@shared/types').Connector[]> = {};
    for (const [id, rc] of Object.entries(connectors)) {
      const on = rc.connectors.filter((c) => c.onWall);
      if (on.length) m[id] = on;
    }
    return m;
  }, [connectors]);
  const connectorsSummaryFor = (roomId: string) => {
    const rc = connectors[roomId];
    if (!rc) return undefined;
    if (rc.checking && !rc.checkedAt) return 'checking…';
    const on = rc.connectors.filter((c) => c.onWall);
    if (!rc.connectors.length) return 'none available';
    if (!on.length) return `none on · ${rc.connectors.length} available`;
    const bad = on.filter((c) => c.status === 'failed' || c.status === 'needs-auth').length;
    return `${on.length} on${bad ? ` · ${bad} need attention` : ''} · ${rc.connectors.length - on.length} more available`;
  };
  // Room whose full session list is open (the "+N more" badge).
  const [rosterRoomId, setRosterRoomId] = useState<string | null>(null);
  const rosterRoom = useMemo(
    () => (rosterRoomId ? (snapshot?.rooms.find((r) => r.id === rosterRoomId) ?? null) : null),
    [snapshot, rosterRoomId],
  );
  const patchRoom = (roomId: string, patch: RoomConfig): string | null => {
    const merged: RoomConfig = { ...configs[roomId], ...patch };
    if (!merged.name?.trim()) delete merged.name; // blank name → fall back to folder
    if (!merged.notes?.trim()) delete merged.notes; // blank notes → none
    const next: RoomConfigs = { ...configs, [roomId]: merged };
    // Drop configs with nothing in them — but decide by "any field set at
    // all", not a hand-kept list. The old list predated the team fields, so a
    // room whose ONLY setting was team autonomy had it silently pruned here.
    if (Object.values(merged).every((v) => v === undefined)) delete next[roomId];
    const err = saveRoomConfigs(next);
    if (!err) setConfigs(next);
    return err;
  };

  // Room editor (decor placement) state.
  const [edit, setEdit] = useState<EditState | null>(null);
  const editRoom = useMemo(
    () => (edit ? (snapshot?.rooms.find((r) => r.id === edit.roomId) ?? null) : null),
    [edit, snapshot],
  );
  const setDecor = (roomId: string, decor: DecorItem[]) => patchRoom(roomId, { decor });
  const applyPreset = (roomId: string, presetKey: string) => {
    const p = PRESETS.find((x) => x.key === presetKey);
    if (p) patchRoom(roomId, { decor: [...p.items], floor: p.floor as FloorMat });
  };

  // "+ project": native folder picker in the desktop app; in-app folder
  // BROWSER elsewhere. (window.prompt is unsupported in Electron — never use it.)
  const [pickerOpen, setPickerOpen] = useState(false);
  const promptAddProject = async () => {
    if (window.airoomNative?.pickFolder) {
      const picked = await window.airoomNative.pickFolder();
      if (picked) addProject(picked);
    } else {
      setPickerOpen(true);
    }
  };

  // ⌥D → copy chat diagnostics to the clipboard (husk hunting & future bugs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.altKey && e.code === 'KeyD')) return;
      const chat = document.querySelector('.ap__col');
      const suspicious = chat
        ? [...chat.querySelectorAll('*')].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.height > 3 && r.height < 22 && r.width > 50 && !el.textContent?.trim();
          })
        : [];
      const histogram: Record<string, number> = {};
      if (chat) for (const el of chat.children) histogram[el.className || el.tagName] = (histogram[el.className || el.tagName] ?? 0) + 1;
      const diag = {
        build: UI_BUILD,
        chatChildren: chat?.children.length ?? -1,
        histogram,
        suspiciousCount: suspicious.length,
        suspiciousSamples: suspicious.slice(0, 5).map((el) => el.outerHTML.slice(0, 300)),
        runs: Object.values(runs).map((r) => ({
          key: r.runKey,
          active: r.active,
          threadLen: r.thread.length,
          threadSample: r.thread.slice(-6).map((t) => `${t.kind}:${JSON.stringify(t.text.slice(0, 60))}`),
        })),
      };
      void navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
      setConnectedFlash(false);
      // reuse the toast slot via notice-less local flash
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = '🩺 diagnostics copied — paste them to Claude';
      document.querySelector('.stage')?.appendChild(el);
      setTimeout(() => el.remove(), 3500);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runs]);

  /**
   * Stable identity matters here: the panel's finished-run sweep is a 2.5s
   * timer in an effect that depends on this callback, and App re-renders on
   * every snapshot — a fresh arrow each time restarted the timer forever, so
   * the sweep never fired while any session was being written to.
   */
  const activeRunKey = activeRun?.runKey;
  const clearActiveRunThread = useCallback(() => {
    if (activeRunKey) clearRunThread(activeRunKey);
  }, [activeRunKey, clearRunThread]);

  const sendToPanel = (
    text: string,
    mode: PermissionMode,
    model: string,
    images: ImageAttachment[],
    fast: boolean,
    budgetUsd: number,
    skills?: AgentSkills,
    agentName?: string,
  ) => {
    if (!panelRoomId) return false;
    // A hire's run answers to `spawn:<roomId>` only until its session exists.
    // Address it that way while it is genuinely live AND still session-less;
    // the moment a session id is known, that id is the address. Both halves
    // matter: the server drops a run 2 min after its last turn, and it hands
    // the spawn slot back as soon as the session resolves — so a session-less
    // send once either is true starts a BRAND NEW session instead of resuming
    // the agent on screen, hiring a second one behind your back.
    const useSpawnKey =
      activeRun?.runKey === `spawn:${panelRoomId}` && activeRun.active && !activeRun.sessionId;
    const sent = send(
      panelRoomId,
      text,
      useSpawnKey ? undefined : selected?.sessionId,
      mode,
      model || undefined,
      images,
      fast,
      budgetUsd,
      skills,
      useSpawnKey || selected ? undefined : agentName,
    );
    // Only commit to "waiting for a new agent here" once the message is really
    // on the wire; and report delivery back so the composer can keep a draft
    // that never left the building.
    if (sent && !selected) setSpawnWait(panelRoomId);
    return sent;
  };

  return (
    <div className="app">
      {release && <UpdateBar release={release} />}
      <header className="topbar">
        <Logo />
        <PickerMenu
          className="addbtn"
          value=""
          options={[
            { value: 'browse', label: 'Browse for a folder…', hint: 'Any folder becomes a room, with or without sessions' },
            { value: 'found', label: `Choose from projects on ${thisMachine}…`, hint: 'Everything Claude Code has been used in, including rooms you put away' },
          ]}
          onPick={(v) => (v === 'browse' ? void promptAddProject() : setChooserOpen(true))}
          placement="down"
          label="+ project"
          ariaLabel="Add a project"
        />
        <div className="strip__mid">
          {/* Lists, not counters: each button opens the list it counts. */}
          <button className={`qbtn qbtn--warn ${needsN > 0 ? 'qbtn--hot' : ''} ${queue === 'needs' ? 'qbtn--on' : ''}`} onClick={() => openQueue('needs')}>
            <span className="qbtn__dot" />
            Needs you <span className="qbtn__n">{needsN}</span>
          </button>
          <button className={`qbtn qbtn--ok ${queue === 'working' ? 'qbtn--on' : ''}`} onClick={() => openQueue('working')}>
            <span className="qbtn__dot" />
            Working <span className="qbtn__n">{counts.working}</span>
          </button>
          <button className={`qbtn qbtn--err ${queue === 'blocked' ? 'qbtn--on' : ''}`} onClick={() => openQueue('blocked')}>
            <span className="qbtn__dot" />
            Blocked <span className="qbtn__n">{counts.error}</span>
          </button>
          <button className={`qbtn ${queue === 'done' ? 'qbtn--on' : ''}`} onClick={() => openQueue('done')}>
            <span className="qbtn__dot" />
            Finished <span className="qbtn__n">{counts.done}</span>
          </button>
        </div>
        <div className="strip__right">
          <PickerMenu
            className="newtask"
            value=""
            options={(snapshot?.rooms ?? [])
              .filter((r) => !r.lane)
              .map((r) => ({ value: r.id, label: r.name || basename(r.id), hint: r.path }))}
            onPick={(roomId) => {
              setTeamOpenId(null);
              setQueue(null);
              setSpawnWait(null);
              setSelectedId(`spawn:${roomId}`);
            }}
            placement="down"
            label="+ New task"
            ariaLabel="Start work in a project"
          />
          <button className="kbtn" onClick={() => setPaletteOpen(true)} title="Jump to a room, an agent, a team or an action">
            Jump to <kbd>{hostPlatform === 'darwin' ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <div className={`conn conn--${conn}`}>
            <span className="conn__dot" />
            {conn === 'open' ? 'live' : conn}
          </div>
        </div>
      </header>
      <div className="body">
        <nav className="rail" aria-label="Places">
          <button className="rail__i rail__i--on" title="The office" aria-label="The office">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11 12 3l9 8" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></svg>
          </button>
          <button className={`rail__i ${queue === 'needs' ? 'rail__i--on' : ''}`} title="Needs you" aria-label="Needs you" onClick={() => openQueue('needs')}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h5l2 3h2l2-3h5" /><path d="M4 12v6h16v-6" /><path d="M6 12 8 5h8l2 7" /></svg>
            {needsN > 0 && <span className="rail__badge">{needsN}</span>}
          </button>
          <button className="rail__i" title="Which projects appear" aria-label="Projects" onClick={() => setChooserOpen(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
          </button>
          <button
            className={`rail__i ${playbooksOpen ? 'rail__i--on' : ''}`}
            title="Playbooks — tasks that worked once, written down to run again"
            aria-label="Playbooks"
            onClick={() => (playbooksOpen ? setPlaybooksOpen(false) : openPlaybooks(playbookId))}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></svg>
            {playbooks.some((p) => p.runs.some((r) => r.state === 'waiting')) && <span className="rail__badge">!</span>}
          </button>
          <span className="rail__gap" />
          <button
            className={`rail__i ${focusMode ? 'rail__i--on' : ''}`}
            title={focusMode ? 'Focus mode on — the office is monochrome and still; colour is reserved for your agents' : 'Focus mode — mute the office to grayscale, keep the robots in colour'}
            aria-label="Focus mode"
            onClick={toggleFocus}
          >
            ◐
          </button>
          <button
            className={`rail__i ${soundOn ? 'rail__i--on' : ''}`}
            title={soundOn ? 'Sound on' : 'Sound off'}
            aria-label="Sound"
            onClick={() => {
              const next = !soundOn;
              sound.setEnabled(next);
              setSoundOn(next);
              if (next) sound.ding();
            }}
          >
            {soundOn ? '♪' : '∅'}
          </button>
        </nav>
        <div className="main">

      <main className="stage">
        {snapshot ? (
          <PixelWorld
            snapshot={snapshot}
            focus={focusMode}
            selectedId={selectedId}
            configs={configs}
            edit={edit}
            onOpenRoster={setRosterRoomId}
            onSelect={(r) => {
              setSelectedId(r?.sessionId ?? null);
              setSpawnWait(null);
              setTeamOpenId(null); // the two panels share the stage edge
              if (!r) unsubscribe(); // Esc/backdrop must release the transcript too
            }}
            onSpawn={(roomId) => {
              setTeamOpenId(null);
              setSelectedId(`spawn:${roomId}`);
            }}
            onTeam={(teamId) => {
              setSelectedId(null);
              setSpawnWait(null);
              unsubscribe();
              setTeamOpenId(teamId);
            }}
            handoffSignal={handoffSignal}
            connectors={wallConnectors}
            pulseSignal={mcpPulse}
            onOpenConnectors={(roomId) => {
              const room = snapshot.rooms.find((r) => r.id === roomId);
              if (room) setConnectorsRoom(room);
            }}
            onOpenSettings={(room) => setSettingsRoom(room)}
            onCycleTheme={(roomId, next) => patchRoom(roomId, { theme: next })}
            onChangeDecor={setDecor}
            onDisarm={() => setEdit((e) => (e ? { ...e, placing: null } : e))}
            onExitEdit={() => setEdit(null)}
          />
        ) : (
          <div className="loading">
            {conn === 'open' ? 'Loading workspace…' : 'Connecting to airoom server…'}
          </div>
        )}


        {(flash ?? notice) && (
          <div className={`toast ${(flash ?? notice)!.isError ? 'toast--err' : ''}`}>
            {(flash ?? notice)!.text}
          </div>
        )}

        {/* First-run, step 0: Claude Code isn't installed at all */}
        {authed === false && hasClaude === false && !connectDismissed && (
          <div className="connect">
            <div className="connect__head">
              <span className="connect__title">Install Claude Code</span>
              <button className="panel__close" onClick={() => setConnectDismissed(true)} aria-label="Dismiss">
                ×
              </button>
            </div>
            <p className="connect__body">
              airoom is a control room for{' '}
              <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer">
                Claude Code
              </a>{' '}
              agents, and it isn't installed yet. Run this in any terminal, then come back:
            </p>
            <div className="connect__cmdrow">
              <code className="connect__cmd">npm install -g @anthropic-ai/claude-code</code>
              <button
                className="connect__copy"
                onClick={() => {
                  void navigator.clipboard.writeText('npm install -g @anthropic-ai/claude-code');
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? '✓ copied' : 'copy'}
              </button>
            </div>
            <p className="connect__wait">
              <span className="connect__waitdot" /> waiting for install… (checks every few seconds)
            </p>
            <div className="connect__locate">
              <p className="connect__body">
                <strong>Already installed?</strong> airoom looked where the installer, Homebrew, npm, the Claude
                desktop app and editor extensions put it, and asked your shell. If yours lives somewhere else, run{' '}
                <code>which claude</code> in a terminal and paste what it prints:
              </p>
              <form
                className="connect__cmdrow"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveBinPath();
                }}
              >
                <input
                  className="connect__path"
                  value={binPath}
                  onChange={(e) => setBinPath(e.target.value)}
                  placeholder="/Users/you/.local/bin/claude"
                  spellCheck={false}
                  aria-label="Path to the claude binary"
                />
                <button className="connect__copy" type="submit" disabled={binBusy || !binPath.trim()}>
                  {binBusy ? 'checking…' : 'use this'}
                </button>
              </form>
              {binError && <p className="connect__err">{binError}</p>}
              {binSaved && !binError && <p className="connect__fine">Found it: {binSaved}. Connecting…</p>}
            </div>
            <p className="connect__fine">
              airoom runs entirely on {thisMachine}. Your code, your conversations and your Claude
              account never pass through our servers.
            </p>
          </div>
        )}

        {/* First-run: connect airoom to the user's existing Claude login */}
        {authed === false && hasClaude !== false && !connectDismissed && (
          <div className="connect">
            <div className="connect__head">
              <span className="connect__title">Connect your Claude</span>
              <button className="panel__close" onClick={() => setConnectDismissed(true)} aria-label="Dismiss">
                ×
              </button>
            </div>
            <p className="connect__body">
              airoom starts agents through <strong>your own Claude Code</strong>, on your own
              subscription. Claude Code makes a key for that — run its command in any terminal
              (your browser opens to approve):
            </p>
            <div className="connect__cmdrow">
              <code className="connect__cmd">{setupCommand}</code>
              <button
                className="connect__copy"
                onClick={() => {
                  void navigator.clipboard.writeText(setupCommand);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? '✓ copied' : 'copy'}
              </button>
            </div>
            <p className="connect__body">
              The terminal prints a long key starting with <code>sk-ant-</code>. Paste it here:
            </p>
            <div className="connect__cmdrow">
              <input
                className="connect__input"
                type="password"
                placeholder="sk-ant-…"
                value={tokenDraft}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setTokenDraft(e.target.value);
                  setTokenErr(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveToken();
                }}
              />
              <button className="connect__copy" disabled={!tokenDraft.trim() || tokenBusy} onClick={() => void saveToken()}>
                {tokenBusy ? 'saving…' : 'connect'}
              </button>
            </div>
            {tokenErr && <p className="connect__err">{tokenErr}</p>}
            <p className="connect__wait">
              <span className="connect__waitdot" />{' '}
              {tokenSaved ? 'key saved — connecting…' : 'waiting for the key… nothing to install, nothing to sign up for'}
            </p>
            <ul className="connect__privacy">
              <li>
                The key stays in one file on {thisMachine} — <code>{tokenPath}</code>, readable
                only by you. Delete the file and airoom is disconnected.
              </li>
              <li>
                It is only ever handed to Claude Code on this machine, which talks directly to
                Anthropic. airoom has no account system and never sees or stores it anywhere else.
              </li>
              <li>
                Your prompts, code and transcripts stay on {yourMachine} too — airoom has no account
                and no key, and its only server contact is a version check against airoom.dev.
              </li>
            </ul>
          </div>
        )}
        {connectedFlash && <div className="toast">✓ Claude connected — your agents are live</div>}
        {reading && <div className="toast">▤ Reading “{draftFor?.title}” into a playbook — this takes a moment…</div>}

        {editor && (
          <>
            <div className="panel-backdrop" onClick={() => setEditor(null)} />
            <PlaybookEditor
              draft={editor.draft}
              sourceTitle={editor.sourceTitle}
              models={models}
              onSave={(pb) => {
                if (!savePlaybook(pb)) {
                  raise('Not connected — the playbook was not saved. Try again in a moment.', true);
                  return;
                }
                setEditor(null);
                // A fresh card lands in the list once the server answers;
                // open the library so it is the next thing on screen.
                if (!pb.id) openPlaybooks(null);
              }}
              onClose={() => setEditor(null)}
            />
          </>
        )}


        {settingsRoom && (
          <>
            <div className="panel-backdrop" onClick={() => setSettingsRoom(null)} />
            <RoomSettings
              room={settingsRoom}
              config={configs[settingsRoom.id] ?? {}}
              sessionCount={snapshot?.robots.filter((r) => r.roomId === settingsRoom.id).length ?? 0}
              awayCount={snapshot?.away.filter((a) => a.roomId === settingsRoom.id).length ?? 0}
              onOpenRoster={() => {
                setRosterRoomId(settingsRoom.id);
                setSettingsRoom(null);
              }}
              onOpenConnectors={() => {
                setConnectorsRoom(settingsRoom);
                setSettingsRoom(null);
              }}
              connectorsSummary={connectorsSummaryFor(settingsRoom.id)}
              connectors={connectors[settingsRoom.id]?.connectors ?? []}
              onToggleConnector={(name, on) => setConnectorEnabled(settingsRoom.id, name, on)}
              team={
                snapshot?.teams.find(
                  (t) =>
                    t.roomId === settingsRoom.id &&
                    (t.state === 'working' || t.state === 'awaiting_human'),
                ) ?? null
              }
              onChange={(patch) => patchRoom(settingsRoom.id, patch)}
              onHide={() => {
              setRoomHidden(settingsRoom.id, true);
              setSettingsRoom(null);
            }}
            onDecorate={() => {
                // A room with no saved decor is showing the automatic
                // furnishing. Commit that to the room before opening the
                // editor, so you're editing what you can actually see —
                // otherwise placing your first plant would make everything
                // else in the room vanish at once.
                if (!configs[settingsRoom.id]?.decor?.length) {
                  patchRoom(settingsRoom.id, {
                    decor: autoDecor(settingsRoom.id, settingsRoom.robotCount),
                  });
                }
                setEdit({ roomId: settingsRoom.id, placing: null });
                setSettingsRoom(null);
              }}
              onClose={() => setSettingsRoom(null)}
            />
          </>
        )}

        {connectorsRoom && (
          <>
            <div className="panel-backdrop" onClick={() => setConnectorsRoom(null)} />
            <Connectors
              roomName={configs[connectorsRoom.id]?.name?.trim() || connectorsRoom.name}
              roomShort={connectorsRoom.name || basename(connectorsRoom.id)}
              room={connectors[connectorsRoom.id] ?? null}
              onRefresh={() => listConnectors(connectorsRoom.id, true)}
              onToggle={(name, enabled) => setConnectorEnabled(connectorsRoom.id, name, enabled)}
              onLoaded={(name, loaded) => setConnectorLoaded(connectorsRoom.id, name, loaded)}
              onAdd={(opts) => addConnector({ roomId: connectorsRoom.id, ...opts })}
              onRemove={(name) => removeConnector(connectorsRoom.id, name)}
              onClose={() => setConnectorsRoom(null)}
            />
          </>
        )}

        {edit && editRoom && (
          <DecorPalette
            roomName={configs[editRoom.id]?.name?.trim() || editRoom.name}
            placing={edit.placing}
            // Show the material the room is ACTUALLY laid in: with no explicit
            // choice that's the theme's own default, not 'checker'.
            floor={
              configs[editRoom.id]?.floor ??
              (THEMES.find((t) => t.id === configs[editRoom.id]?.theme) ?? THEMES[0]).mat
            }
            hasDecor={!!configs[editRoom.id]?.decor?.length}
            onPick={(key) => setEdit({ ...edit, placing: key })}
            onFloor={(mat) => patchRoom(editRoom.id, { floor: mat })}
            onPreset={(key) => applyPreset(editRoom.id, key)}
            onClear={() => patchRoom(editRoom.id, { decor: [] })}
            onDone={() => setEdit(null)}
          />
        )}

        {/* Which found projects appear. Once, on a fresh install, after the
            engine is connected (two cards at once would be a pile-up); any
            time, from + project. */}
        {snapshot &&
          (chooserOpen ||
            (snapshot.curated === false &&
              !chooserSkipped &&
              snapshot.rooms.some((r) => !r.lane) &&
              !(authed === false && !connectDismissed))) && (
            <>
              <div
                className="panel-backdrop"
                onClick={() => {
                  if (!chooserOpen) {
                    setChooserSkipped(true);
                    curateProjects(snapshot.hiddenProjects ?? []);
                  }
                  setChooserOpen(false);
                }}
              />
              <ProjectChooser
                rooms={snapshot.rooms.filter((r) => !r.lane)}
                hidden={snapshot.hiddenProjects ?? []}
                names={Object.fromEntries(Object.entries(configs).map(([id, c]) => [id, c.name?.trim() || '']))}
                firstRun={!chooserOpen}
                onDone={(hidden) => {
                  curateProjects(hidden);
                  setChooserSkipped(true);
                  setChooserOpen(false);
                }}
                onClose={() => {
                  // Skipping the first-run question is an answer: keep it all.
                  if (!chooserOpen) {
                    setChooserSkipped(true);
                    curateProjects(snapshot.hiddenProjects ?? []);
                  }
                  setChooserOpen(false);
                }}
              />
            </>
          )}

        {rosterRoom && (
          <>
          {/* The same scrim every other dialog gets: click outside to close,
              and the office behind it reads as behind it. The roster opens
              FROM room settings, whose scrim used to vanish the moment the
              list appeared. */}
          <div className="panel-backdrop" onClick={() => setRosterRoomId(null)} />
          <RoomRoster
            roomName={configs[rosterRoom.id]?.name || rosterRoom.name}
            robots={snapshot?.robots.filter((r) => r.roomId === rosterRoom.id) ?? []}
            away={snapshot?.away.filter((a) => a.roomId === rosterRoom.id) ?? []}
            onOpen={(robot) => {
              setRosterRoomId(null);
              setSelectedId(robot.sessionId);
            }}
            onLetGo={(sessionId) => {
              setAgentHidden(sessionId, true);
              if (selectedId === sessionId) {
                setSelectedId(null);
                unsubscribe();
              }
            }}
            onBringBack={(sessionId) => setAgentHidden(sessionId, false)}
            onClose={() => setRosterRoomId(null)}
          />
          </>
        )}

        {/* browsable folder picker for "+ project" (desktop uses the native one) */}
        {pickerOpen && (
          <>
          <div className="panel-backdrop" onClick={() => setPickerOpen(false)} />
          <FolderPicker
            onPick={(p) => {
              setPickerOpen(false);
              addProject(p);
            }}
            onClose={() => setPickerOpen(false)}
          />
          </>
        )}
      </main>

      <footer className="hint">
        click a desk to open it beside the office · an empty desk adds an agent or a team · double-click a room to retheme ·
        esc closes · {UI_BUILD}
      </footer>
        </div>

        {(((selected || spawnRoom) && panelRoomId) || (openTeam && !selected && !spawnRoom) || (queue && snapshot) || (playbooksOpen && snapshot)) && (
          <aside className="dock" style={{ width: dockW }} aria-label="Dock">
            <div className="dock__grip" onPointerDown={startDockResize} title="Drag to resize" />
        {(selected || spawnRoom) && panelRoomId && (
          <AgentPanel
            docked
            key={selectedId ?? panelRoomId}
            robot={selected}
            roomId={panelRoomId}
            team={(() => {
              const t = selected?.team ? snapshot?.teams.find((x) => x.id === selected.team!.id) : undefined;
              if (!t) return null;
              return { label: t.members.find((m) => m.role === selected!.team!.role)?.label ?? selected!.team!.role, state: t.state };
            })()}
            onOpenTeam={() => {
              const id = selected?.team?.id;
              if (!id) return;
              setSelectedId(null);
              unsubscribe();
              setTeamOpenId(id);
            }}
            playbook={selected?.playbook ?? null}
            onOpenPlaybook={() => selected?.playbook && openPlaybooks(selected.playbook.id)}
            onMakePlaybook={() => {
              if (!selected) return;
              if (requestPlaybookDraft(selected.sessionId, selected.roomId)) setDraftFor({ sessionId: selected.sessionId, title: selected.title });
              else raise('Not connected — try again in a moment.', true);
            }}
            onRemember={(text) => {
              if (selected?.playbook) addPlaybookRule(selected.playbook.id, text, selected.playbook.runId);
            }}
            hireMode={hireMode}
            teamHired={teamHired}
            memberMode={selectedMember?.mode}
            memberModel={selectedMember?.model}
            onHireMode={setHireMode}
            teamAutonomy={configs[panelRoomId]?.teamAutonomy ?? 'auto_capped'}
            teamRoundCap={configs[panelRoomId]?.teamRoundCap ?? 2}
            teamMode={configs[panelRoomId]?.teamMode ?? 'default'}
            teamModel={configs[panelRoomId]?.teamModel ?? ''}
            canHire={conn === 'open'}
            skillChoices={skillLists[panelRoomId] ?? []}
            onListSkills={() => listSkills(panelRoomId)}
            onCreateSkill={(name, description, body) => createSkill(panelRoomId, name, description, body)}
            onTeamDefaults={(patch) => patchRoom(panelRoomId, patch)}
            onLetGo={() => {
              if (!selected) return;
              setAgentHidden(selected.sessionId, true);
              setSelectedId(null);
              unsubscribe();
            }}
            onDelete={() => {
              if (!selected) return;
              deleteAgent(selected.sessionId);
              setSelectedId(null);
              unsubscribe();
            }}
            onNameAgent={(name) => {
              if (selected) nameAgent(selected.sessionId, name);
            }}
            onHireTeam={(hire) => {
              hireTeam({
                roomId: panelRoomId,
                task: hire.task,
                autonomy: configs[panelRoomId]?.teamAutonomy ?? 'auto_capped',
                roundCap: configs[panelRoomId]?.teamRoundCap ?? 2,
                mode: configs[panelRoomId]?.teamMode ?? 'default',
                model: configs[panelRoomId]?.teamModel || undefined,
                roster: hire.roster,
                lanes: hire.lanes,
                ownRoom: hire.ownRoom,
                thrift: hire.thrift,
              });
              setTeamWait(panelRoomId);
              setSelectedId(null);
              setSpawnWait(null);
              unsubscribe();
            }}
            roomName={
              (panelRoomId && configs[panelRoomId]?.name?.trim()) ||
              spawnRoom?.name ||
              (selected && basename(selected.roomId)) ||
              ''
            }
            accent={
              focusMode
                ? '#8f8f8f' // the panel wears the office's mood: focus grays the trim too
                : (THEMES.find((t) => t.id === configs[panelRoomId]?.theme)?.accent ?? THEMES[0].accent)
            }
            transcript={transcript}
            loadingMore={loadingMore}
            run={activeRun}
            onSubscribe={subscribe}
            onLoadMore={loadMore}
            onNotice={raise}
            onSend={sendToPanel}
            onInterrupt={() => activeRun && interrupt(activeRun.runKey)}
            onPermission={(requestId, allow, always) =>
              activeRun && respondPermission(activeRun.runKey, requestId, allow, always)
            }
            onSetMode={(mode) => activeRun && setMode(activeRun.runKey, mode)}
            onSetFastMode={(fast) => activeRun && setFastMode(activeRun.runKey, fast)}
            onRewind={(userMessageId, dryRun) => {
              // Works with or without a live run: the server reopens the
              // session's checkpoints from roomId + sessionId when needed.
              const key = activeRun?.runKey ?? selected?.sessionId;
              if (key) askRewind(key, userMessageId, dryRun, panelRoomId, selected?.sessionId);
            }}
            rewind={rewind}
            onClearRewind={clearRewind}
            models={models}
            commands={commands}
            onWarmLocal={warmLocal}
            onClearRun={clearActiveRunThread}
            onClose={() => {
              setSelectedId(null);
              setSpawnWait(null);
              unsubscribe();
            }}
          />
        )}
        {openTeam && !selected && !spawnRoom && (
          <TeamPanel
            docked
            key={openTeam.id}
            team={openTeam}
            log={teamLogs[openTeam.id] ?? []}
            robots={snapshot?.robots ?? []}
            away={snapshot?.away ?? []}
            onBringBack={(sessionId) => setAgentHidden(sessionId, false)}
            onOpenMember={(sessionId) => {
              setTeamOpenId(null);
              setSelectedId(sessionId);
            }}
            onContinue={() => teamContinue(openTeam.id)}
            onStop={() => teamStop(openTeam.id)}
            onNewTask={(task) => teamNewTask(openTeam.id, task)}
            onRename={(name) => nameTeam(openTeam.id, name)}
            onCancelTask={(taskId) => teamCancelTask(openTeam.id, taskId)}
            onMergeTask={(taskId) => teamMergeTask(openTeam.id, taskId)}
            onCloseTask={(taskId) => teamCloseTask(openTeam.id, taskId)}
            onDismiss={() => {
              teamDismiss(openTeam.id);
              setTeamOpenId(null);
            }}
            onClose={() => setTeamOpenId(null)}
            onSubscribe={() => subscribeTeam(openTeam.id)}
            />
        )}
        {playbooksOpen && snapshot && !selected && !spawnRoom && !openTeam && !queue && (
          <PlaybookPanel
            playbooks={playbooks}
            rooms={snapshot.rooms}
            robots={snapshot.robots}
            models={models}
            selectedId={playbookId}
            canRun={conn === 'open'}
            onSelect={setPlaybookId}
            onRun={(id, inputs, mode, model) => {
              if (!runPlaybook(id, inputs, mode, model)) raise('Not connected — try again in a moment.', true);
            }}
            onEdit={(pb) => setEditor({ draft: pb })}
            onDelete={(id) => {
              deletePlaybook(id);
              setPlaybookId(null);
            }}
            onStop={stopPlaybookRun}
            onDropRule={dropPlaybookRule}
            onOpenAgent={(sessionId) => {
              setPlaybooksOpen(false);
              setSelectedId(sessionId);
            }}
            onClose={() => setPlaybooksOpen(false)}
          />
        )}
        {queue && snapshot && !selected && !spawnRoom && !openTeam && (
          <Queue
            kind={queue}
            snapshot={snapshot}
            runs={runs}
            onOpen={(sessionId) => {
              setQueue(null);
              setSelectedId(sessionId);
            }}
            onOpenTeam={(teamId) => {
              setQueue(null);
              setTeamOpenId(teamId);
            }}
            onPermission={(runKey, requestId, allow) => respondPermission(runKey, requestId, allow)}
            onMergeTask={(teamId, taskId) => teamMergeTask(teamId, taskId)}
            onClose={() => setQueue(null)}
          />
        )}
          </aside>
        )}
      </div>
      {paletteOpen && snapshot && (
        <Palette
          onClose={() => setPaletteOpen(false)}
          rows={paletteRows({
            snapshot,
            needs: [
              ...snapshot.robots
                .filter((r) => r.status === 'waiting_input' || r.needsApproval)
                .map((r) => ({ sessionId: r.sessionId, title: r.title, project: basename(r.roomId), since: r.lastActivity })),
              ...snapshot.teams
                .filter((t) => t.state === 'awaiting_human')
                .map((t) => ({ teamId: t.id, title: t.name || t.task.split('\n')[0].slice(0, 80), project: `${basename(t.roomId)} · team`, since: t.updatedAt })),
            ],
            focusMode,
            soundOn,
            isMac: hostPlatform === 'darwin',
            openAgent: (sessionId) => {
              setQueue(null);
              setTeamOpenId(null);
              setSelectedId(sessionId);
            },
            openTeam: (teamId) => {
              setQueue(null);
              setSelectedId(null);
              unsubscribe();
              setTeamOpenId(teamId);
            },
            newTask: (roomId) => {
              setQueue(null);
              setTeamOpenId(null);
              setSpawnWait(null);
              setSelectedId(`spawn:${roomId}`);
            },
            openQueue: () => openQueue('needs'),
            openProjects: () => setChooserOpen(true),
            playbooks,
            openPlaybook: (id) => openPlaybooks(id),
            toggleFocus,
            toggleSound: () => {
              const next = !soundOn;
              sound.setEnabled(next);
              setSoundOn(next);
              if (next) sound.ding();
            },
          })}
        />
      )}
    </div>
  );
}

